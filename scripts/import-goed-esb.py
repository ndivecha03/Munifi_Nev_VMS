#!/usr/bin/env python3
"""
import-goed-esb.py — Import GOED ESB certified business directory into baked-vendors-v2.json

Usage:
    python3 scripts/import-goed-esb.py --csv <path-to-goed-export.csv>

Expected CSV columns (flexible — script will try common name variants):
    Business Name, Tier, City, Address, Zip, NAICS, Phone, Email, Website,
    Certification Status, Expiration Date, County

The script merges new vendors into public/baked-vendors-v2.json without
overwriting existing NDOT NUCP vendors. Duplicates are matched by normalized
business name. Run with --dry-run to preview without writing.
"""

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime, date

VENDORS_PATH = os.path.join(os.path.dirname(__file__), '..', 'public', 'baked-vendors-v2.json')

# ── Column name aliases (GOED may vary) ──────────────────────────────────────
COL_ALIASES = {
    'name':         ['Business Name', 'Company Name', 'Name', 'Firm Name', 'DBA Name'],
    'tier':         ['Tier', 'ESB Tier', 'Certification Tier', 'Type'],
    'city':         ['City', 'Business City', 'Principal City'],
    'address':      ['Address', 'Street Address', 'Business Address', 'Principal Address'],
    'zip':          ['Zip', 'Zip Code', 'ZIP', 'Postal Code'],
    'county':       ['County', 'Business County', 'Principal County'],
    'naics':        ['NAICS', 'NAICS Code', 'NAICS Codes', 'Industry Code'],
    'phone':        ['Phone', 'Phone Number', 'Business Phone', 'Contact Phone'],
    'email':        ['Email', 'Email Address', 'Business Email', 'Contact Email'],
    'website':      ['Website', 'Web', 'URL', 'Business Website'],
    'status':       ['Certification Status', 'Status', 'ESB Status', 'Cert Status'],
    'expires':      ['Expiration Date', 'Cert Expiration', 'Expiry', 'Expires', 'Valid Until'],
    'esb_number':   ['ESB Number', 'Cert Number', 'Certification Number', 'ESB #'],
    'owner_gender': ['Gender', 'Owner Gender', 'Principal Gender'],
    'owner_race':   ['Race', 'Ethnicity', 'Owner Race', 'Minority Status'],
}

COUNTY_NORMALIZE = {
    'clark': 'clark', 'clark county': 'clark',
    'washoe': 'washoe', 'washoe county': 'washoe',
    'carson city': 'carson_city', 'carson': 'carson_city',
    'douglas': 'douglas', 'douglas county': 'douglas',
    'lyon': 'lyon', 'elko': 'elko', 'nye': 'nye',
    'churchill': 'churchill', 'humboldt': 'humboldt',
    'lander': 'lander', 'mineral': 'mineral',
    'pershing': 'pershing', 'storey': 'storey',
    'white pine': 'white_pine', 'eureka': 'eureka',
    'esmeralda': 'esmeralda', 'lincoln': 'lincoln',
}

NAICS_TO_SPECIALTIES = {
    '2371': ['pipeline', 'utility_work'],
    '2373': ['paving', 'asphalt'],
    '2379': ['concrete', 'sidewalk'],
    '2381': ['foundation', 'excavation'],
    '2382': ['electrical'],
    '2383': ['hvac', 'mechanical'],
    '2389': ['demolition'],
    '4811': ['trucking'],
    '4841': ['trucking', 'hauling'],
    '5413': ['engineering'],
    '5416': ['environmental'],
    '7111': ['landscaping'],
    '2361': ['concrete', 'sidewalk'],
    '2362': ['concrete'],
    '2369': ['grading', 'excavation'],
    '2382': ['electrical'],
    '4812': ['trucking'],
}


def find_col(header, field):
    """Return the actual header name matching our field alias list, or None."""
    aliases = COL_ALIASES.get(field, [])
    for alias in aliases:
        if alias in header:
            return alias
        # case-insensitive fallback
        for h in header:
            if h.strip().lower() == alias.lower():
                return h
    return None


def normalize_name(name):
    return re.sub(r'\s+', ' ', name.strip().lower())


def naics_to_specialties(naics_str):
    specs = []
    codes = re.findall(r'\d+', naics_str or '')
    for code in codes:
        for prefix, tags in NAICS_TO_SPECIALTIES.items():
            if code.startswith(prefix):
                specs.extend(t for t in tags if t not in specs)
    return specs


def county_key(raw):
    if not raw:
        return None
    return COUNTY_NORMALIZE.get(raw.strip().lower(), raw.strip().lower().replace(' ', '_'))


def tier_to_lbe(tier_str):
    t = (tier_str or '').strip().lower()
    if 'tier 1' in t or 'tier1' in t:
        return 'tier1'
    if 'tier 2' in t or 'tier2' in t:
        return 'tier2'
    return None


def parse_csv(csv_path):
    vendors = []
    with open(csv_path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        col = {field: find_col(header, field) for field in COL_ALIASES}

        missing = [f for f in ['name', 'city'] if not col[f]]
        if missing:
            print(f"WARNING: Could not find columns for: {missing}")
            print(f"  Available columns: {header}")

        for i, row in enumerate(reader):
            def get(field):
                c = col.get(field)
                return row[c].strip() if c and c in row else ''

            name = get('name')
            if not name:
                continue

            naics_raw = get('naics')
            specs = naics_to_specialties(naics_raw)
            tier_raw = get('tier')
            lbe_tier = tier_to_lbe(tier_raw)
            county_raw = get('county') or ('clark' if get('city').lower() in ['las vegas','henderson','north las vegas','boulder city','mesquite'] else '')

            vendor = {
                'id': f'goed-esb-{i+1:04d}',
                'name': name,
                'address': {
                    'street': get('address'),
                    'city':   get('city'),
                    'state':  'NV',
                    'zip':    get('zip'),
                },
                'county': county_key(county_raw),
                'lbe': {
                    'cmd_cert_active': True,
                    'certifying_body_key': 'goed_esb',
                    'esb_number': get('esb_number') or None,
                    'tier': lbe_tier,
                    'cmd_cert_expires_on': get('expires') or None,
                },
                'licensing': {
                    'nv_license_status': 'active' if (get('status') or 'active').lower() in ['active', 'certified', ''] else get('status').lower(),
                },
                'demographics': {
                    'wbe_certified': any(x in (get('owner_gender') or '').lower() for x in ['female', 'woman', 'f']),
                    'mbe_certified': bool(get('owner_race') and get('owner_race').lower() not in ['white', 'caucasian', 'non-minority', '']),
                    'dbe_certified': False,
                    'dvbe_certified': False,
                },
                'specialties': specs,
                'contact': {
                    'phone':   get('phone') or None,
                    'email':   get('email') or None,
                    'website': get('website') or None,
                },
                'track_record': {
                    'prior_ndot_contracts_count': 0,
                    'prior_ndot_contracts_value': 0,
                },
                'source': 'goed_esb_directory',
                'date_joined': datetime.today().strftime('%Y-%m-%d'),
            }

            # clean None values from contact
            vendor['contact'] = {k: v for k, v in vendor['contact'].items() if v}

            vendors.append(vendor)

    return vendors


def merge_vendors(existing, incoming):
    existing_names = {normalize_name(v['name']): v for v in existing}
    added, updated, skipped = 0, 0, 0

    for v in incoming:
        key = normalize_name(v['name'])
        if key in existing_names:
            # Update contact/cert fields only — don't overwrite NDOT licensing data
            ex = existing_names[key]
            if v['contact']:
                ex.setdefault('contact', {}).update({k: val for k, val in v['contact'].items() if val})
            if v['lbe'].get('esb_number') and not ex.get('lbe', {}).get('esb_number'):
                ex.setdefault('lbe', {})['esb_number'] = v['lbe']['esb_number']
            if v['lbe'].get('cmd_cert_expires_on') and not ex.get('lbe', {}).get('cmd_cert_expires_on'):
                ex.setdefault('lbe', {})['cmd_cert_expires_on'] = v['lbe']['cmd_cert_expires_on']
            updated += 1
        else:
            existing.append(v)
            existing_names[key] = v
            added += 1

    return existing, added, updated, skipped


def main():
    parser = argparse.ArgumentParser(description='Import GOED ESB CSV into baked-vendors-v2.json')
    parser.add_argument('--csv', required=True, help='Path to GOED ESB export CSV file')
    parser.add_argument('--dry-run', action='store_true', help='Preview without writing')
    parser.add_argument('--out', default=VENDORS_PATH, help='Output JSON path (default: public/baked-vendors-v2.json)')
    args = parser.parse_args()

    if not os.path.exists(args.csv):
        print(f"ERROR: CSV file not found: {args.csv}")
        sys.exit(1)

    # Load existing vendors
    with open(args.out) as f:
        data = json.load(f)
    existing = data.get('vendors', data) if isinstance(data, dict) else data

    print(f"Existing vendors: {len(existing)}")

    # Parse incoming CSV
    incoming = parse_csv(args.csv)
    print(f"Vendors in CSV:   {len(incoming)}")

    # Merge
    merged, added, updated, skipped = merge_vendors(existing, incoming)
    print(f"\nResult: +{added} new  |  {updated} enriched  |  {len(merged)} total")

    if args.dry_run:
        print("\n-- DRY RUN: no files written --")
        # Show sample of new vendors
        new_names = [v['name'] for v in incoming if normalize_name(v['name']) not in {normalize_name(e['name']) for e in existing}]
        print(f"\nSample new vendors ({min(10, len(new_names))}/{len(new_names)}):")
        for n in new_names[:10]:
            print(f"  + {n}")
        return

    # Write output
    if isinstance(data, dict):
        data['vendors'] = merged
        out_data = data
    else:
        out_data = merged

    with open(args.out, 'w') as f:
        json.dump(out_data, f, indent=2)

    print(f"\nWritten to {args.out}")


if __name__ == '__main__':
    main()
