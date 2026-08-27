# MunifiGov — Nevada ESB Dispatch Console

Nevada vertical of the MunifiGov platform. Surfaces NDOT-certified ESB/DBE vendors for Clark County public works dispatch, powered by live SeeClickFix complaints and the Nevada State Contractors Board registry.

## Policy basis

- **NRS 338.0117** — Nevada ESB set-aside authority
- **GOED ESB/DBE certification** — vendor eligibility gate
- **NDOT NUCP certification** — 46-vendor pool

## Stack

- Static frontend in `public/` — no build step, deploys via Vercel (`munifi-nev-vms.vercel.app`)
- `dev-server.py` — local proxy for SeeClickFix Clark County complaints
- GitHub Actions in `.github/workflows/` — daily cert refresh + complaint ingest

## Running locally

```bash
python3 dev-server.py 8853
# open http://localhost:8853
```

## Vendor data

`public/baked-vendors-v2.json` — 46 NDOT NUCP-certified vendors with real NSCB license numbers, addresses, ESB/DBE certification status, and license classifications.
