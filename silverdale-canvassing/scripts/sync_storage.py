#!/usr/bin/env python3
"""
Moves the planning register data between the GitHub Action and the private
Supabase file store (bucket "canvassing"), so the data never has to sit in
this public repository.

    python3 sync_storage.py download   # before the weekly pull: fetch the current files
    python3 sync_storage.py upload     # after it: save the updated files back

Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment (the key is a
GitHub Actions secret, never written into any file).
"""
import os
import sys
from pathlib import Path

import requests

FILES = ["latest.json", "details.json", "history.json", "predictions.json", "timings.json"]
LOCAL_DIR = Path(__file__).resolve().parent.parent / "register-data"
BUCKET = "canvassing"


def headers(extra=None):
    key = os.environ["SUPABASE_SERVICE_KEY"]
    h = {"apikey": key}
    if key.startswith("eyJ"):  # older-style keys also go in the Authorization header
        h["Authorization"] = "Bearer " + key
    h.update(extra or {})
    return h


def url(name):
    return f"{os.environ['SUPABASE_URL'].rstrip('/')}/storage/v1/object/{BUCKET}/register-data/{name}"


def download():
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        r = requests.get(url(name), headers=headers(), timeout=120)
        if r.status_code == 200:
            (LOCAL_DIR / name).write_bytes(r.content)
            print(f"downloaded {name} ({len(r.content) // 1024} KB)")
        elif r.status_code in (400, 404):
            print(f"{name} not in the private store yet, keeping the local copy")
        else:
            sys.exit(f"could not download {name}: {r.status_code} {r.text[:200]}")


def upload():
    for name in FILES:
        path = LOCAL_DIR / name
        if not path.exists():
            continue
        r = requests.post(url(name), data=path.read_bytes(), timeout=300,
                          headers=headers({"Content-Type": "application/json", "x-upsert": "true"}))
        if r.status_code not in (200, 201):
            sys.exit(f"could not upload {name}: {r.status_code} {r.text[:200]}")
        print(f"uploaded {name} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("download", "upload"):
        sys.exit(__doc__)
    {"download": download, "upload": upload}[sys.argv[1]]()
