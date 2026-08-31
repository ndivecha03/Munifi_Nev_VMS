#!/usr/bin/env python3
"""
bake-vendors.py — Re-bake public/baked-vendors-v2.json into the
`const VENDORS = [...]` line of public/index.html.

index.html embeds the vendor pool as a single baked JS constant (the site
never fetches the JSON at runtime). After adding vendors to
baked-vendors-v2.json (e.g. via scripts/import-goed-esb.py), run:

    python scripts/bake-vendors.py

All vendor counts on the site (page header, stat tiles, compliance bars,
data notes) are computed from VENDORS, so they update automatically.
"""

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), '..')
VENDORS_JSON = os.path.join(ROOT, 'public', 'baked-vendors-v2.json')
INDEX_HTML = os.path.join(ROOT, 'public', 'index.html')


def main():
    with open(VENDORS_JSON, encoding='utf-8') as f:
        data = json.load(f)
    vendors = data['vendors'] if isinstance(data, dict) else data

    with open(INDEX_HTML, encoding='utf-8') as f:
        html = f.read()

    baked = json.dumps(vendors, ensure_ascii=False, separators=(',', ':'))
    new_html, n = re.subn(
        r'const VENDORS = \[.*?\];\n',
        lambda m: 'const VENDORS = ' + baked + ';\n',
        html,
        count=1,
        flags=re.S,
    )
    if n != 1:
        print('ERROR: could not find `const VENDORS = [...];` in index.html')
        sys.exit(1)

    with open(INDEX_HTML, 'w', encoding='utf-8', newline='') as f:
        f.write(new_html)

    goed = sum(1 for v in vendors if (v.get('lbe') or {}).get('certifying_body_key') == 'goed_esb')
    dbe = sum(1 for v in vendors if (v.get('demographics') or {}).get('dbe_certified'))
    act = sum(1 for v in vendors if ((v.get('licensing') or {}).get('nv_license_status') or '') == 'active')
    print(f'Baked {len(vendors)} vendors into index.html '
          f'({goed} GOED ESB, {dbe} USDOT DBE, {act} active NSCB)')


if __name__ == '__main__':
    main()
