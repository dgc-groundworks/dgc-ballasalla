#!/usr/bin/env python3
"""Deploy an Edge Function from supabase/functions/<slug>/index.ts to the ORIGINAL Job Planner project (vigdtpcgeqenznuakdwz)
through the Supabase Management API (22 Oct 2026, hub-planner-login; a copy of silverdale-app/supabase/deploy-function.py). verify_jwt is OFF: see the function.
The function checks its caller itself.
No secrets in this file or the source: the function uses the project's own SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY,
plus the function secret HUB_PLANNER_KEY (set through the Management API, never in git). The Management API token is read from ~/.silverdale/supabase_token
and never printed. Usage: python3 supabase/deploy-function.py hub-planner-login"""
import json, os, pathlib, sys, time, urllib.request, urllib.error, uuid

REF = "vigdtpcgeqenznuakdwz"
SLUGS = {"hub-planner-login": False}  # slug: verify_jwt (off: the caller proves itself with the hub key and a director's OS sign-in)
HERE = pathlib.Path(__file__).resolve().parent
tok = open(os.path.expanduser("~/.silverdale/supabase_token")).read().strip()
H = {"Authorization": "Bearer " + tok, "User-Agent": "ash-claude/1.0"}


def deploy(slug):
    src = HERE / "functions" / slug / "index.ts"
    vj = SLUGS[slug]
    meta = {"name": slug, "entrypoint_path": "index.ts", "verify_jwt": vj}
    bnd = "----silverdale" + uuid.uuid4().hex
    data = b"".join([
        f'--{bnd}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'.encode() + json.dumps(meta).encode() + b"\r\n",
        f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n'.encode() + src.read_bytes() + b"\r\n",
        f"--{bnd}--\r\n".encode(),
    ])
    try:
        urllib.request.urlopen(urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/functions/{slug}", headers=H), timeout=60).read()
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        body = json.dumps({"slug": slug, "name": slug, "verify_jwt": vj,
                           "body": 'Deno.serve(() => new Response("starting", { status: 503 }));'}).encode()
        urllib.request.urlopen(urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/functions", data=body, method="POST",
                                                      headers={**H, "Content-Type": "application/json"}), timeout=120).read()
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/functions/deploy?slug={slug}", data=data, method="POST",
                                 headers={**H, "Content-Type": f"multipart/form-data; boundary={bnd}"})
    for attempt in range(1, 7):
        try:
            out = json.load(urllib.request.urlopen(req, timeout=180))
            break
        except urllib.error.HTTPError as e:
            if e.code != 500 or attempt == 6:
                raise
            print(f"{slug}: deploy try {attempt} got 500, trying again in 20 s")
            time.sleep(20)
    print(json.dumps({k: out.get(k) for k in ("slug", "status", "version", "verify_jwt", "entrypoint_path")}))


for s in sys.argv[1:] or list(SLUGS):
    if s not in SLUGS:
        sys.exit("unknown slug " + s)
    try:
        deploy(s)
    except urllib.error.HTTPError as e:
        print("DEPLOY FAILED", s, e.code, e.read().decode()[:2000])
        sys.exit(1)
