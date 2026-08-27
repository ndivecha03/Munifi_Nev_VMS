#!/usr/bin/env python3
"""
Local dev server for NV ESB Dispatch Console.
Serves public/ as static files AND proxies /api/complaints → SeeClickFix,
matching the behaviour of the Vercel serverless function in api/complaints.js.

Usage: python3 dev-server.py [port]   (default: 8853)
"""
import http.server, json, os, re, ssl, sys, urllib.request, urllib.error
from datetime import datetime, timezone

PORT   = int(sys.argv[1]) if len(sys.argv) > 1 else 8853
STATIC = os.path.join(os.path.dirname(__file__), 'public')

SCF_BASE   = 'https://seeclickfix.com/api/v2/issues'
ROAD_TYPES = '31028,31067,31082,31070'
CLUSTERS   = [
    (36.17, -115.14, 10),   # Las Vegas core
    (36.05, -115.28, 10),   # Henderson / SW
    (36.28, -115.06, 10),   # North LV / Nellis
]
SUBTYPE_MAP = {
    31028: 'pavement_repair',
    31067: 'drainage_repair',
    31082: 'sign_installation',
    31070: 'concrete_repair',
}
SEVERITY_KEYWORDS = {
    'emergency': ['sinkhole', 'collapse', 'flood', 'washout', 'cave'],
    'urgent':    ['pothole', 'uneven', 'crumbling', 'broken', 'hazard', 'dangerous'],
    'elevated':  ['crack', 'obstruction', 'debris', 'damage'],
}

def infer_severity(text):
    t = (text or '').lower()
    for sev, kws in SEVERITY_KEYWORDS.items():
        if any(k in t for k in kws):
            return sev
    return 'standard'

def infer_district(lat, lng):
    if lat is None: return 'D1'
    if lat < 36.0:  return 'D3'
    if lat > 36.25: return 'D1'
    if lng is not None and lng < -115.25: return 'D3'
    return 'D1'

def normalize(issue):
    rt_id   = (issue.get('request_type') or {}).get('id')
    subtype = SUBTYPE_MAP.get(rt_id, 'pavement_repair')
    text    = (issue.get('summary') or '') + ' ' + (issue.get('description') or '')
    return {
        'id':          f"SCF-{issue['id']}",
        'status':      'open',
        'subtype':     subtype,
        'severity':    infer_severity(text),
        'opened_on':   (issue.get('created_at') or '')[:10] or None,
        'location':    issue.get('address') or '',
        'district':    infer_district(issue.get('lat'), issue.get('lng')),
        'county':      'Clark',
        'lat':         issue.get('lat'),
        'lng':         issue.get('lng'),
        'description': issue.get('summary') or (issue.get('request_type') or {}).get('title') or '',
        'source':      'seeclickfix_clark_county',
        'agency':      'Clark County Public Works',
        'scf_url':     issue.get('html_url') or None,
    }

def fetch_scf_cluster(lat, lng, zoom):
    url = (f"{SCF_BASE}?lat={lat}&lng={lng}&zoom={zoom}"
           f"&per_page=100&request_types={ROAD_TYPES}&status=open")
    req = urllib.request.Request(url, headers={'User-Agent': 'NVESBDispatch/1.0'})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
        return json.loads(r.read())['issues']

def api_complaints():
    seen, issues = set(), []
    for lat, lng, zoom in CLUSTERS:
        try:
            batch = fetch_scf_cluster(lat, lng, zoom)
            for issue in batch:
                if issue['id'] not in seen:
                    seen.add(issue['id'])
                    issues.append(normalize(issue))
        except Exception as e:
            print(f'  [proxy] cluster ({lat},{lng}) error: {e}')
    return {'complaints': issues, 'source': 'seeclickfix_live', 'count': len(issues)}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def do_GET(self):
        if self.path.split('?')[0] == '/api/complaints':
            self.handle_api_complaints()
        else:
            super().do_GET()

    def handle_api_complaints(self):
        print(f'  [proxy] fetching SeeClickFix Clark County…', flush=True)
        try:
            data = api_complaints()
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            print(f'  [proxy] returned {data["count"]} live complaints', flush=True)
        except Exception as e:
            err = json.dumps({'error': str(e)}).encode()
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(err)))
            self.end_headers()
            self.wfile.write(err)
            print(f'  [proxy] error: {e}', flush=True)

    def log_message(self, fmt, *args):
        # suppress static-file noise, only show API calls
        if '/api/' in (args[0] if args else ''):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    import socketserver
    os.chdir(STATIC)
    with socketserver.TCPServer(('', PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        print(f'NV ESB Dev Server → http://localhost:{PORT}')
        print(f'  Static: {STATIC}')
        print(f'  Proxy:  /api/complaints → SeeClickFix Clark County (live)')
        print(f'  Press Ctrl+C to stop.\n')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')
