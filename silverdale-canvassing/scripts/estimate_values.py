#!/usr/bin/env python3
"""
Puts a rough value on planning applications for the Silverdale Canvassing
market view: what the job is, how big, a value range (whole job and the
groundworks and drainage share), a confidence grade and sources.

Runs in the weekly GitHub Action after the register pull, only when
ANTHROPIC_API_KEY is set. Needs the private prompt and rate book, which
sync_storage.py downloads from the private store into register-data/estimator/.
Writes register-data/estimates.jsonl (one short line per application) and
register-data/market-summary.json (the totals). Both go back to the private
store, never into this public repo.

  python3 estimate_values.py [--max 40] [--no-vision]

--max caps how many applications are priced in one run (newest first), so
cost can be checked before it runs weekly at full size.

Paperwork on an earlier permission (a condition discharge or minor change that
names the original application) is not priced on its own: the app shows the
original's estimate on it instead. Those originals are priced first, because a
condition being discharged usually means the build is about to start.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

from planning_history import DATA, WORK_TYPES, effective_work, load_history, parse_date

EST_PATH = os.path.join(DATA, "estimates.jsonl")
SUMMARY_PATH = os.path.join(DATA, "market-summary.json")
PROMPT_PATH = os.path.join(DATA, "estimator", "prompt.md")
RATES_PATH = os.path.join(DATA, "estimator", "rate_book.md")
LATEST_PATH = os.path.join(DATA, "latest.json")
MODEL = os.environ.get("ESTIMATOR_MODEL", "claude-opus-5-5")
BATCH = 15
BUILD_WORK = {"New homes (1)", "New homes (2-9)", "New homes (10+)", "Extension / alterations",
              "Change of use / conversion", "Commercial / community", "Agricultural", "Access / parking",
              "Demolition", "Infrastructure / utilities"}

GRADES = """GRADES: A = sizes measured from scaled drawings and priced with our own QS rates (about +/-15%).
B = floor or site area from drawings or description, priced with Isle of Man adjusted benchmarks (about +/-30%).
C = size inferred from the description using typical sizes (about +/-50%).
D = not priced: not building work, or not enough information (value fields null)."""

RANGE = {"type": "array", "items": {"type": "integer"}}   # [low, high]; the API only allows minItems 0 or 1, so pairs are tidied in code
NULLABLE_RANGE = {"anyOf": [RANGE, {"type": "null"}]}
WEEKS = {"type": "object", "properties": {"build": NULLABLE_RANGE, "groundworks": NULLABLE_RANGE},
         "required": ["build", "groundworks"], "additionalProperties": False}
MATERIAL = {"type": "object", "properties": {"item": {"type": "string"}, "qty": NULLABLE_RANGE, "unit": {"type": "string"},
                                             "cost": NULLABLE_RANGE},
            "required": ["item", "qty", "unit", "cost"], "additionalProperties": False}
MARGIN = {"type": "object", "properties": {"pct": NULLABLE_RANGE, "gw": NULLABLE_RANGE, "note": {"type": "string"}},
          "required": ["pct", "gw", "note"], "additionalProperties": False}
SCHEMA = {
    "type": "object",
    "properties": {"results": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "ref": {"type": "string"},
            "what": {"type": "string"},
            "type": {"type": "string", "enum": WORK_TYPES},
            "homes": {"type": "integer"},
            "client": {"type": "string", "enum": ["householder", "developer", "commercial", "farm", "public body", "unknown"]},
            "offMains": {"type": "boolean"},
            "floorM2": NULLABLE_RANGE,
            "siteM2": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
            "sizeFrom": {"type": "string"},
            "total": NULLABLE_RANGE,
            "groundworks": NULLABLE_RANGE,
            "england": NULLABLE_RANGE,
            "weeks": WEEKS,
            "materials": {"type": "array", "items": MATERIAL},
            "margin": MARGIN,
            "silverdaleFit": {"type": "string", "enum": ["full build", "project management", "design and planning", "not a fit"]},
            "silverdale": {"type": "string"},
            "grade": {"type": "string", "enum": ["A", "B", "C", "D"]},
            "why": {"type": "string"},
            "opportunity": {"type": "string"},
            "sources": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["ref", "what", "type", "homes", "client", "offMains", "floorM2", "siteM2", "sizeFrom",
                     "total", "groundworks", "england", "weeks", "materials", "margin", "silverdaleFit", "silverdale", "grade", "why", "opportunity", "sources"],
        "additionalProperties": False,
    }}},
    "required": ["results"],
    "additionalProperties": False,
}


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def load_estimates():
    out = {}
    if os.path.exists(EST_PATH):
        for line in open(EST_PATH, encoding="utf-8"):
            if line.strip():
                e = json.loads(line)
                out[e["ref"]] = e
    return out


def save_estimates(est):
    tmp = EST_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for ref in sorted(est, key=lambda r: est[r].get("received") or "", reverse=True):
            f.write(json.dumps(est[ref], ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, EST_PATH)


REF_RE = re.compile(r"(?<!\d)\d{2}/\d{5}/[A-Z]{1,4}\b")
PAPERWORK = {"Conditions / information", "Minor change", "Variation of conditions"}
CLOSE_DAYS = 180   # paperwork this recent marks its original application as "build close"
# Grade D because the size wasn't known (not because there's nothing to build): worth one more go
# with the plan drawing in front of the model.
UNSURE_RE = re.compile(r"unknown|avoid guess|no floor area given|floor area not|not enough information|too little information", re.I)


def valued_under(e):
    """Refs an unpriced estimate says its value is counted under ("valued under 23/00860/CON")."""
    if not e or e.get("total"):
        return []
    text = " ".join(str(e.get(k) or "") for k in ("why", "what", "opportunity"))
    return re.findall(r"valued under\s+((?:\d{2}/\d{5}/[A-Z]{1,4}))", text, re.I)


def parent_ref(r, history):
    """The original application a piece of paperwork belongs to, when it names one we hold."""
    if effective_work(r) not in PAPERWORK:
        return None
    for m in REF_RE.findall(r.get("description") or ""):
        if m != r["ref"] and m in history:
            return m
    return None
POSTCODE_RE = re.compile(r"\bIM\d{1,2}\s?\d[A-Z]{2}\b", re.I)
SKIP_WORDS = {"the", "and", "land", "at", "of", "to", "site", "adjacent", "adj", "rear", "plot", "plots"}


def site_key(address):
    """Postcode plus the first two words of the address (house name or number), e.g. 'im12ez|holly lodge'."""
    m = POSTCODE_RE.search(address or "")
    if not m:
        return None
    rest = POSTCODE_RE.sub("", address.lower().replace("isle of man", ""))
    words = [w for w in re.sub(r"[^a-z0-9 ]", " ", rest).split() if w not in SKIP_WORDS]
    return m.group(0).lower().replace(" ", "") + "|" + " ".join(words[:2]) if words else None


def related_index(history):
    idx = {"site": {}, "applicant": {}, "mentions": {}}
    for ref, r in history.items():
        k = site_key(r.get("address"))
        if k:
            idx["site"].setdefault(k, []).append(ref)
        if r.get("applicantKey"):
            idx["applicant"].setdefault(r["applicantKey"], []).append(ref)
        for m in REF_RE.findall(r.get("description") or ""):
            if m != ref:
                idx["mentions"].setdefault(m, []).append(ref)
    return idx


def related_for(r, history, idx, limit=8):
    """Earlier and later applications for the same job: refs it mentions (and theirs), same site, same applicant."""
    found = {}
    parents = [m for m in REF_RE.findall(r.get("description") or "") if m != r["ref"]]
    for m in list(parents):
        parents += [g for g in REF_RE.findall((history.get(m) or {}).get("description") or "") if g not in parents and g != r["ref"]]
    for m in parents:
        found.setdefault(m, "mentioned")
    for c in idx["mentions"].get(r["ref"], []):
        found.setdefault(c, "follow-on")
    for m in parents:
        for c in idx["mentions"].get(m, []):
            found.setdefault(c, "same original")
    for s in idx["site"].get(site_key(r.get("address")) or "", []):
        found.setdefault(s, "same site")
    same_applicant = idx["applicant"].get(r.get("applicantKey") or "", [])
    if 1 < len(same_applicant) <= 8:
        for s in same_applicant:
            found.setdefault(s, "same applicant")
    found.pop(r["ref"], None)
    order = {"mentioned": 0, "follow-on": 1, "same original": 2, "same site": 3, "same applicant": 4}
    picked = sorted(found.items(), key=lambda kv: order[kv[1]])[:limit]
    out = []
    for ref, why in picked:
        h = history.get(ref) or {}
        out.append({k: v for k, v in {"ref": ref, "why": why, "description": (h.get("description") or "")[:200],
                                       "status": h.get("outcome"), "received": h.get("received")}.items() if v})
    return out


def tidy_range(v):
    """Turn whatever came back into [low, high], or None."""
    nums = [int(x) for x in v if isinstance(x, (int, float))] if isinstance(v, list) else []
    return [min(nums), max(nums)] if nums else None


def app_payload(r, related=None):
    return {k: v for k, v in {
        "ref": r["ref"], "description": r.get("description"), "applicationType": r.get("applicationType"),
        "workCategory": effective_work(r), "parish": r.get("parish"), "address": r.get("address"),
        "status": r.get("outcome") or "pending", "received": r.get("received"), "decided": r.get("decisionDate"),
        "agent": r.get("agentCompanyName") or r.get("agentName"), "documentNames": r.get("documentNames"),
        "siteExtent": r.get("siteExtent"), "relatedApplications": related,
    }.items() if v not in (None, "", [])}


def plan_image(r):
    """Floor plan or layout image for Claude to read, in memory only, never saved."""
    if not r.get("keyVal"):
        return None
    try:
        from drawings import best_plan_image  # provided by the drawings step, if present
    except ImportError:
        return None
    try:
        return best_plan_image(r["keyVal"])
    except Exception as e:  # a bad drawing must never stop the run
        print(f"{r['ref']}: no plan image ({e})", file=sys.stderr)
        return None


def ask(client, system, content, usage):
    import anthropic
    try:
        resp = client.beta.messages.create(
            model=MODEL, max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.RateLimitError:
        raise
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        print(f"request failed: {e}", file=sys.stderr)
        return []
    u = resp.usage
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
        usage[k] = usage.get(k, 0) + (getattr(u, k, 0) or 0)
    if resp.stop_reason in ("refusal", "max_tokens"):
        print(f"reply stopped ({resp.stop_reason}), skipped", file=sys.stderr)
        return []
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text)["results"]
    except (json.JSONDecodeError, KeyError):
        print("unreadable reply, skipped", file=sys.stderr)
        return []


def estimate(max_apps, vision):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set - skipping value estimates", file=sys.stderr)
        return None
    if not (os.path.exists(PROMPT_PATH) and os.path.exists(RATES_PATH)):
        print("estimator prompt or rate book missing from the private store - skipping", file=sys.stderr)
        return None
    import anthropic
    client = anthropic.Anthropic()
    system = (read(PROMPT_PATH) + "\n\n" + GRADES + "\n\nWORK TYPES: " + json.dumps(WORK_TYPES)
              + "\n\nRATE BOOK:\n" + read(RATES_PATH))
    history = load_history()
    idx = related_index(history)
    est = load_estimates()
    # A changed prompt or rate book means earlier estimates are re-priced (newest first, within --max).
    version = hashlib.sha1(system.encode("utf-8")).hexdigest()[:10]
    # Only what the canvassing list shows (it keeps every application it has ever pulled), plus the
    # originals behind recent paperwork. Order: new in the last fortnight, then originals whose build
    # looks close, then everything else newest first.
    listed = json.loads(read(LATEST_PATH)).get("applications", []) if os.path.exists(LATEST_PATH) else []
    on_list = {a["ref"] for a in listed}
    cutoff, fortnight = date.today() - timedelta(days=CLOSE_DAYS), date.today() - timedelta(days=14)
    close = {parent_ref(r, history) for r in history.values()
             if (parse_date(r.get("received")) or date.min) >= cutoff} - {None}
    # Every original named by something on the list (fetch_originals.py adds the old ones to history).
    named = {m for a in listed for m in REF_RE.findall(a.get("description") or "") if m != a["ref"] and m in history}
    # ...and the originals that unpriced follow-ons were "valued under".
    named |= {m for a in listed for m in valued_under(est.get(a["ref"])) if m != a["ref"] and m in history}
    def needs(ref):
        e = est.get(ref)
        if not e:
            return True
        if e.get("grade") == "D":
            return bool(UNSURE_RE.search(e.get("why") or "")) and e.get("retried") != version
        return e.get("rateBook") != version
    todo = [r for r in history.values() if r.get("description") and not parent_ref(r, history)
            and (not on_list or r["ref"] in on_list or r["ref"] in close or r["ref"] in named) and needs(r["ref"])]
    received = lambda r: parse_date(r.get("received")) or date.min
    todo.sort(key=lambda r: (received(r) >= fortnight, r["ref"] in close or r["ref"] in named, received(r)), reverse=True)
    todo = todo[:max_apps]
    retry = {r["ref"] for r in todo if r["ref"] in est and est[r["ref"]].get("grade") == "D"}
    print(f"{sum(r['ref'] in close for r in todo)} of these are originals with recent condition paperwork", file=sys.stderr)
    print(f"pricing {len(todo)} applications with {MODEL}", file=sys.stderr)
    usage, done = {}, 0
    with_image = [r for r in todo if vision and (effective_work(r) in BUILD_WORK or r["ref"] in retry
                                                 or r["ref"].endswith("/REM") or effective_work(r) == "Other")]
    text_only = [r for r in todo if r not in with_image]
    jobs = [[r] for r in with_image] + [text_only[i:i + BATCH] for i in range(0, len(text_only), BATCH)]
    for batch in jobs:
        content = [{"type": "text", "text": json.dumps([app_payload(r, related_for(r, history, idx)) for r in batch], ensure_ascii=False)}]
        if len(batch) == 1 and batch[0] in with_image:
            img = plan_image(batch[0])
            if img:
                content.insert(0, {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                                "data": base64.b64encode(img).decode()}})
                content.append({"type": "text", "text": "The image is the application's proposed plan or layout drawing. Use it to judge floor area; say so in sources."})
        try:
            results = ask(client, system, content, usage)
        except anthropic.RateLimitError:
            print("rate limited - stopping, the rest carries over to next week", file=sys.stderr)
            break
        by_ref = {r["ref"]: r for r in batch}
        for res in results:
            r = by_ref.get(res["ref"])
            if not r:
                continue
            for key in ("total", "groundworks", "england", "floorM2"):
                res[key] = tidy_range(res.get(key))
            res["weeks"] = {k: tidy_range((res.get("weeks") or {}).get(k)) for k in ("build", "groundworks")}
            res["materials"] = [{**m, "qty": tidy_range(m.get("qty")), "cost": tidy_range(m.get("cost"))}
                                for m in (res.get("materials") or [])[:8]]
            mg = res.get("margin") or {}
            res["margin"] = {"pct": tidy_range(mg.get("pct")), "gw": tidy_range(mg.get("gw")), "note": mg.get("note", "")}
            res.update({"received": r.get("received"), "status": r.get("outcome") or "pending",
                        "parish": r.get("parish"), "keyVal": r.get("keyVal"), "pricedOn": date.today().isoformat(),
                        "rateBook": version, "decided": r.get("decisionDate"),
                        **({"retried": version} if res["ref"] in retry else {})})
            est[res["ref"]] = res
            done += 1
        save_estimates(est)
    print(f"priced {done}; tokens {usage}", file=sys.stderr)
    return {"model": MODEL, "priced": done, "usage": usage, "rateBook": version,
            "ranOn": datetime.utcnow().isoformat(timespec="minutes") + "Z"}


def mid(rng):
    return (rng[0] + rng[1]) / 2 if rng else 0


def summarise(run=None):
    """Totals by period, status, type, area and client. Grade D is never counted."""
    est = load_estimates()
    history = load_history()
    today = date.today()
    periods = {"30 days": 30, "90 days": 90, "12 months": 365}
    rows = []
    for e in est.values():
        rec = parse_date(e.get("received"))
        rows.append({**e, "_received": rec})

    def totals(sel):
        priced = [e for e in sel if e.get("grade") in ("A", "B", "C") and e.get("total")]
        agg = lambda key: [round(sum(e[key][i] for e in priced if e.get(key))) for i in (0, 1)] if priced else [0, 0]
        return {"count": len(sel), "priced": len(priced),
                "total": agg("total"), "groundworks": agg("groundworks"), "england": agg("england"),
                "gradeAB": sum(1 for e in priced if e["grade"] in ("A", "B"))}

    def group(sel, key):
        g = {}
        for e in sel:
            g.setdefault(e.get(key) or "unknown", []).append(e)
        return dict(sorted(((k, totals(v)) for k, v in g.items()), key=lambda kv: -mid(kv[1]["total"])))

    out = {"generated": datetime.utcnow().isoformat(timespec="minutes") + "Z", "periods": {}}
    for label, days in periods.items():
        sel = [e for e in rows if e["_received"] and (today - e["_received"]).days <= days]
        coverage = sum(1 for r in history.values() if (d := parse_date(r.get("received"))) and (today - d).days <= days)
        out["periods"][label] = {
            "applications": coverage, "all": totals(sel),
            "byStatus": group(sel, "status"), "byType": group(sel, "type"),
            "byParish": group(sel, "parish"), "byClient": group(sel, "client"),
            "offMainsNewHomes": sum(1 for e in sel if e.get("offMains") and (e.get("homes") or 0) > 0),
        }
    recent = [e for e in rows if e["_received"] and (today - e["_received"]).days <= 90
              and e.get("status") in ("approved", "pending") and e.get("groundworks") and e.get("grade") in ("A", "B", "C")]
    out["topOpportunities"] = [e["ref"] for e in sorted(recent, key=lambda e: -mid(e["groundworks"]))[:15]]
    sil = [e for e in rows if e["_received"] and (today - e["_received"]).days <= 90 and e.get("status") in ("approved", "pending")
           and e.get("total") and e.get("grade") in ("A", "B", "C") and e.get("silverdaleFit") not in (None, "not a fit")]
    out["topSilverdale"] = [e["ref"] for e in sorted(sil, key=lambda e: -mid(e["total"]))[:15]]
    if run:
        out["lastRun"] = run
    elif os.path.exists(SUMMARY_PATH):
        try:
            out["lastRun"] = json.load(open(SUMMARY_PATH)).get("lastRun")
        except (OSError, json.JSONDecodeError):
            pass
    with open(SUMMARY_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"summary written: {len(est)} estimates", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=40, help="most applications to price in one run (newest first)")
    ap.add_argument("--no-vision", action="store_true", help="don't send plan drawings to Claude")
    args = ap.parse_args()
    run = estimate(args.max, not args.no_vision)
    summarise(run)


if __name__ == "__main__":
    main()
