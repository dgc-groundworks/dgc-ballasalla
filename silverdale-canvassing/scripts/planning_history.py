#!/usr/bin/env python3
"""
Builds and maintains the planning decision-time history used by the
Silverdale Canvassing app's timing metrics and predictions.

  register-data/history.json      every application seen: received /
                                  validated / decision dates, type, outcome
  register-data/predictions.json  a predicted decision date for each pending
                                  application, fixed on the day it was made,
                                  plus the actual date and error once decided

Usage:
  # one-off backfill of past decisions, month by month (slow: one detail
  # page per application, run politely)
  python3 planning_history.py --backfill --from 2021-09 --to 2026-09

  # weekly: merge the latest pull into the history, lock in predictions for
  # new pending applications, and score predictions that have now come due
  python3 planning_history.py --update register-data/latest.json
"""
import argparse
import hashlib
import json
import os
import re
import statistics
import sys
import time
from datetime import date, datetime, timedelta

import requests
from bs4 import BeautifulSoup

from pull_register import BASE, DETAIL_DELAY_SECONDS, fetch_detail, new_session, not_available

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "register-data")
HISTORY = os.path.join(DATA, "history.json")
PREDICTIONS = os.path.join(DATA, "predictions.json")
TIMINGS = os.path.join(DATA, "timings.json")
DETAILS = os.path.join(DATA, "details.json")
PRIVATE_COPY = os.environ.get("PLANNING_PRIVATE_COPY")  # full, unfiltered history kept off the public repo
PREDICTION_WINDOW_DAYS = 730  # predictions use decisions from the last two years
MIN_GROUP = 10                # below this, fall back to a broader group

WORK_TYPES = ["Conditions / information", "Minor change", "Certificate of lawfulness", "Signage / adverts",
              "Variation of conditions", "Change of use / conversion", "New homes (1)", "New homes (2-9)",
              "New homes (10+)", "Demolition", "Access / parking", "Small works (doors, flues, fences...)",
              "Extension / alterations", "Agricultural", "Infrastructure / utilities", "Commercial / community",
              "Trees / landscaping", "Other"]

NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
             "ten": 10, "eleven": 11, "twelve": 12}


def parse_date(s):
    if not s:
        return None
    s = re.sub(r"^\w{3}\s+", "", s.strip())  # drop a leading weekday
    for fmt in ("%d %b %Y", "%d %B %Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


ORG_WORDS = re.compile(r"\b(ltd|limited|llp|plc|inc|company|co\.|group|holdings|homes|developments?|properties|property|estates?|"
                       r"investments?|trust|trustees|partnership|associates|construction|builders|council|commissioners|"
                       r"department|government|authority|utilities|church|school|club|society|association|charity|hotel)\b", re.I)


def applicant_key(name):
    norm = re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()
    return hashlib.sha256(("iom-planning:" + norm).encode()).hexdigest()[:12] if norm else None


def public_copy(history):
    """What goes in the public repo: companies named in full, private
    individuals only when they've applied more than once (repeat
    developers); a one-off homeowner keeps just an anonymous key."""
    from collections import Counter
    for r in history.values():
        if r.get("applicantName"):
            r["applicantKey"] = applicant_key(r["applicantName"])
    counts = Counter(r.get("applicantKey") for r in history.values() if r.get("applicantKey"))
    out = {}
    for ref, r in history.items():
        rec = dict(r)
        name = rec.get("applicantName")
        if name and not ORG_WORDS.search(name) and counts[rec.get("applicantKey")] < 2:
            rec.pop("applicantName")
        out[ref] = rec
    return out


def load_history():
    if PRIVATE_COPY and os.path.exists(PRIVATE_COPY):
        return load(PRIVATE_COPY, {})
    return load(HISTORY, {})


def save_history(history):
    save(HISTORY, public_copy(history))
    if PRIVATE_COPY:
        save(PRIVATE_COPY, history)


def work_type(desc, ref, app_type):
    """What the application is actually for, read from its description."""
    d = (desc or "").lower()
    suffix = (ref or "").rsplit("/", 1)[-1].upper()
    t = (app_type or "").lower()
    if suffix == "AIR" or "information in relation to condition" in d or "condition discharge" in t:
        return "Conditions / information"
    if suffix == "MCH" or "minor change" in t:
        return "Minor change"
    if suffix == "LAW" or "lawful" in d or "lawful" in t:
        return "Certificate of lawfulness"
    if re.search(r"\badverti|\bsignage\b|\bsigns?\b|illuminated", d):
        return "Signage / adverts"
    if re.search(r"variation of conditions?|removal of conditions?|vary condition", d):
        return "Variation of conditions"
    homes = re.search(r"\b(dwelling|dwellings|dwellinghouse|dwellinghouses|house|houses|bungalow|apartment|apartments|flat|flats|residential)\b", d)
    new_build = re.search(r"\b(erection|construction|creation|development|redevelopment|replacement|new)\b", d)
    if re.search(r"change of use|conversion of|additional use|use of (?:the )?(?:dwelling|residence|property|premises|building) as", d) and not (homes and re.search(r"erection|construction", d)):
        return "Change of use / conversion"
    if homes and new_build and not re.search(r"\bextension\b|\balterations? to\b", d):
        m = re.search(r"\b(\d+|" + "|".join(NUM_WORDS) + r")\s+(?:no\.?\s+)?(?:new\s+)?(?:[a-z-]+\s+){0,2}(dwellings|houses|apartments|flats|homes|units|bungalows)\b", d)
        n = 1
        if m:
            n = int(m.group(1)) if m.group(1).isdigit() else NUM_WORDS[m.group(1)]
        return "New homes (1)" if n <= 1 else "New homes (2-9)" if n < 10 else "New homes (10+)"
    if re.search(r"\bdemoli", d):
        return "Demolition"
    if re.search(r"vehicular access|vehicle access|\baccess\b|parking|driveway|hard ?standing|crossing|dropped kerb", d):
        return "Access / parking"
    if re.search(r"\bdoors?\b|\bflue\b|fenc|\bgates?\b|chimney|render|gazebo|log store|canopy|notice board|information board|"
                 r"interpretation board|railings|\bsatellite dish|air source heat pump|heat pump|replacement windows?", d) and not re.search(r"extension", d):
        return "Small works (doors, flues, fences...)"
    if re.search(r"extension|conservatory|dormer|porch|garage|carport|alteration|loft|annex|balcon|veranda|garden room|"
                 r"outbuilding|decking|window|roof|cladding|fence|wall|driveway|patio|summer ?house|shed", d):
        return "Extension / alterations"
    if re.search(r"agricultur|\bbarn\b|stable|livestock|polytunnel|poly tunnel|\bfarm", d):
        return "Agricultural"
    if re.search(r"solar|wind turbine|telecom|\bmast\b|antenna|substation|pumping|reservoir|treatment works|highway|"
                 r"\broad\b|car park|footpath|slipway|harbour|drainage|sewer", d):
        return "Infrastructure / utilities"
    if re.search(r"industrial|warehouse|office|retail|\bshop|restaurant|\bcafe|hotel|commercial|workshop|\bunits?\b|"
                 r"storage|showroom|school|church|hall|clinic|nursery|leisure", d):
        return "Commercial / community"
    if re.search(r"\btree", d):
        return "Trees / landscaping"
    return "Other"


def effective_work(r):
    """Claude's reading of the application when it has one, otherwise the keyword rules."""
    return r.get("aiWork") or work_type(r.get("description"), r["ref"], r.get("applicationType"))


def decision_level(raw):
    """Who decided it, grouped — without the individual officers' initials."""
    l = (raw or "").lower()
    if not l:
        return None
    if "committee" in l:
        return "Planning Committee"
    if "head of development" in l:
        return "Head of Development Management"
    if "enf" in l:
        return "Planning officer (enforcement)"
    if "south" in l:
        return "Planning officer (South)"
    if "north" in l:
        return "Planning officer (North)"
    if "withdraw" in l:
        return "Withdrawn"
    if "department" in l:
        return "Department application"
    return "Other"


def outcome(decision):
    d = (decision or "").lower()
    if re.search(r"permit|approv|grant|consent", d) and "declined" not in d:
        return "approved"
    if re.search(r"refus|declined", d):
        return "refused"
    if re.search(r"withdraw|retract|void", d):
        return "withdrawn"
    return "other" if d else None


def record_from(item, detail):
    received = item.get("received") or not_available(detail.get("Application Received"))
    validated = item.get("validated") or not_available(detail.get("Application Validated"))
    app_type = not_available(detail.get("Application Type"))
    decision = not_available(detail.get("Decision"))
    decision_date = not_available(detail.get("Decision Issued Date"))
    return {
        "ref": item["ref"],
        "description": item.get("description") or "",
        "address": item.get("address") or "",
        "parish": not_available(detail.get("Parish")),
        "applicationType": app_type,
        "workType": work_type(item.get("description"), item["ref"], app_type),
        "received": received,
        "validated": validated,
        "decision": decision,
        "outcome": outcome(decision),
        "decisionDate": decision_date,
        "decisionLevel": not_available(detail.get("Actual Decision Level")) or not_available(detail.get("Expected Decision Level")),
        "agentName": not_available(detail.get("Agent Name")),
        "agentCompanyName": not_available(detail.get("Agent Company Name")),
        "agentAddress": not_available(detail.get("Agent Address")),
        "applicantName": not_available(detail.get("Applicant Name")),
        "keyVal": item.get("keyVal"),
    }


def days_between(a, b):
    da, db = parse_date(a), parse_date(b)
    return (db - da).days if da and db and db >= da else None


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=0, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def agent_label(r):
    company, name = (r.get("agentCompanyName") or "").strip(), (r.get("agentName") or "").strip()
    return company or name


def write_timings(history):
    """Compact copies for the app: timings.json (one small row per
    application, loaded up front) and details.json (descriptions, links
    and names, loaded only when someone drills into an agent)."""
    pub = public_copy(history)
    enc = {k: [""] for k in ("works", "types", "levels", "outcomes", "agents", "applicants")}
    index = {k: {"": 0} for k in enc}
    def code(kind, v):
        v = v or ""
        if v not in index[kind]:
            index[kind][v] = len(enc[kind])
            enc[kind].append(v)
        return index[kind][v]
    iso = lambda s: (parse_date(s).isoformat() if parse_date(s) else "")
    rows, details = [], {}
    for r in pub.values():
        rows.append([r["ref"], code("works", effective_work(r)), code("types", r.get("applicationType")),
                     code("levels", decision_level(r.get("decisionLevel"))), code("outcomes", outcome(r.get("decision"))),
                     iso(r.get("received")), iso(r.get("validated")), iso(r.get("decisionDate")), r.get("aiComplexity") or 0,
                     code("agents", agent_label(r)), code("applicants", r.get("applicantName")), r.get("applicantKey") or ""])
        details[r["ref"]] = [r.get("description") or "", r.get("address") or "", r.get("keyVal") or "",
                             r.get("agentName") or "", r.get("agentCompanyName") or "", r.get("agentAddress") or "",
                             r.get("applicantName") or "", r.get("decision") or ""]
    save(TIMINGS, {"generated": datetime.utcnow().isoformat() + "Z",
                   "fields": ["ref", "work", "type", "level", "outcome", "received", "validated", "decided",
                              "complexity", "agent", "applicant", "applicantKey"],
                   **enc, "rows": rows})
    save(DETAILS, {"fields": ["description", "address", "keyVal", "agentName", "agentCompanyName", "agentAddress",
                              "applicantName", "decision"], "apps": details})


# ---- Advanced search by decision date (for the backfill) ----

def parse_list(html):
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for li in soup.select("li.searchresult"):
        a = li.select_one("a.summaryLink")
        m = re.search(r"keyVal=([^&]+)", a["href"] if a else "")
        meta = re.sub(r"\s+", " ", li.select_one("p.metaInfo").get_text(" ", strip=True)) if li.select_one("p.metaInfo") else ""
        ref = re.search(r"Ref\.?\s*No:?\s*([^|]+?)\s*(?:\||$)", meta)
        if not m or not ref:
            continue
        get = lambda label: (re.search(label + r":\s*([^|]+?)\s*(?:\||$)", meta) or [None, None])[1]
        desc = li.select_one(".summaryLinkTextClamp")
        addr = li.select_one("p.address")
        items.append({"keyVal": m.group(1), "ref": ref.group(1).strip(),
                      "description": desc.get_text(strip=True) if desc else "",
                      "address": addr.get_text(strip=True) if addr else "",
                      "received": get("Received"), "validated": get("Validated"), "status": get("Status")})
    total = re.search(r"Showing\s+\d+-\d+\s+of\s+(\d+)", soup.get_text(" "))
    csrf = soup.find("input", {"name": "_csrf"})
    too_many = "Too many results" in html
    return items, int(total.group(1)) if total else len(items), csrf["value"] if csrf else "", too_many


def search_decided(session, start, end):
    """Every application decided between two dates (inclusive)."""
    r = session.get(f"{BASE}/online-applications/search.do?action=advanced", timeout=30)
    r.raise_for_status()
    csrf = BeautifulSoup(r.text, "html.parser").find("input", {"name": "_csrf"})["value"]
    data = {"_csrf": csrf, "searchType": "Application", "caseAddressType": "Application",
            "date(applicationDecisionStart)": start.strftime("%d/%m/%Y"),
            "date(applicationDecisionEnd)": end.strftime("%d/%m/%Y")}
    r = session.post(f"{BASE}/online-applications/advancedSearchResults.do?action=firstPage", data=data, timeout=30)
    r.raise_for_status()
    items, total, csrf, too_many = parse_list(r.text)
    if too_many:
        if start == end:
            raise RuntimeError(f"too many results for a single day {start}")
        mid = start + (end - start) // 2
        return search_decided(session, start, mid) + search_decided(session, mid + timedelta(days=1), end)
    out, page = [], 1
    while True:
        r = session.post(f"{BASE}/online-applications/pagedSearchResults.do",
                         data={"_csrf": csrf, "action": "page", "searchCriteria.page": str(page),
                               "searchCriteria.resultsPerPage": "100"}, timeout=30)
        r.raise_for_status()
        items, total, csrf2, _ = parse_list(r.text)
        csrf = csrf2 or csrf
        out.extend(items)
        if not items or len(out) >= total:
            break
        page += 1
        time.sleep(DETAIL_DELAY_SECONDS)
    return out


def month_range(frm, to):
    y, m = map(int, frm.split("-"))
    ty, tm = map(int, to.split("-"))
    while (y, m) <= (ty, tm):
        start = date(y, m, 1)
        nxt = date(y + (m == 12), m % 12 + 1, 1)
        yield start, min(nxt - timedelta(days=1), date.today())
        y, m = nxt.year, nxt.month


def fetch_records(items, delay, workers):
    """Detail pages for a batch, a few at a time, each worker on its own session."""
    from concurrent.futures import ThreadPoolExecutor
    import threading
    local = threading.local()
    def one(it):
        if not hasattr(local, "session"):
            local.session = new_session()
        for attempt in range(3):
            try:
                detail = fetch_detail(local.session, it["keyVal"])
                time.sleep(delay)
                return record_from(it, detail)
            except requests.RequestException:
                time.sleep(5 * (attempt + 1))
                local.session = new_session()
        return None
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return [r for r in pool.map(one, items) if r]


def backfill(frm, to, delay, workers=3, newest_first=True):
    history = load_history()
    session = new_session()
    months = list(month_range(frm, to))
    if newest_first:
        months.reverse()
    for start, end in months:
        if start > date.today():
            continue
        try:
            items = search_decided(session, start, end)
        except (requests.RequestException, RuntimeError) as e:
            print(f"{start:%b %Y}: search failed ({e}) — rerun to retry", file=sys.stderr, flush=True)
            session = new_session()
            continue
        todo = [it for it in items if not ((history.get(it["ref"]) or {}).get("decisionDate") and (history.get(it["ref"]) or {}).get("keyVal"))]
        t0 = time.time()
        for rec in fetch_records(todo, delay, workers):
            rec["firstSeen"] = (history.get(rec["ref"]) or {}).get("firstSeen") or date.today().isoformat()
            history[rec["ref"]] = rec
        save_history(history)
        write_timings(history)
        print(f"{start:%b %Y}: {len(items)} decided, fetched {len(todo)} in {round(time.time() - t0)}s — history {len(history)}", file=sys.stderr, flush=True)
    print(f"history: {len(history)} applications", file=sys.stderr, flush=True)


# ---- Stats + predictions ----

def decided_durations(history, since=None, until=None, start_field="received"):
    rows = []
    for r in history.values():
        dd = parse_date(r.get("decisionDate"))
        days = days_between(r.get(start_field), r.get("decisionDate"))
        if days is None or not dd:
            continue
        if since and dd < since:
            continue
        if until and dd >= until:
            continue
        rows.append((r, days))
    return rows


def typical_days(rows, work, app_type):
    """Median days for the most specific group with enough decisions."""
    for label, pick in ((f"{work}", lambda r: r.get("workType") == work),
                        (f"{app_type}", lambda r: r.get("applicationType") == app_type),
                        ("all applications", lambda r: True)):
        ds = [d for r, d in rows if pick(r)]
        if len(ds) >= MIN_GROUP:
            return statistics.median(ds), len(ds), label
    ds = [d for _, d in rows]
    return (statistics.median(ds), len(ds), "all applications") if ds else (None, 0, None)


def update(latest_path):
    history = load_history()
    predictions = load(PREDICTIONS, {})
    latest = load(latest_path, {}).get("applications", [])
    today = date.today()
    for a in latest:
        prev = history.get(a["ref"], {})
        rec = {**prev,
               "ref": a["ref"], "description": a.get("description") or prev.get("description", ""),
               "address": a.get("address") or prev.get("address", ""), "parish": a.get("parish") or prev.get("parish"),
               "applicationType": a.get("applicationType") or prev.get("applicationType"),
               "received": a.get("received") or prev.get("received"), "validated": a.get("validated") or prev.get("validated"),
               "decision": a.get("decision") or prev.get("decision"), "decisionDate": a.get("decisionDate") or prev.get("decisionDate"),
               "decisionLevel": a.get("decisionLevel") or prev.get("decisionLevel"),
               "agentName": a.get("agentName") or prev.get("agentName"),
               "agentAddress": a.get("agentAddress") or prev.get("agentAddress"),
               "applicantName": a.get("applicantName") or prev.get("applicantName"),
               "applicantKey": prev.get("applicantKey"),
               "keyVal": a.get("keyVal") or prev.get("keyVal"),
               "agentCompanyName": a.get("agentCompanyName") or prev.get("agentCompanyName")}
        rec["workType"] = work_type(rec["description"], rec["ref"], rec["applicationType"])
        rec["outcome"] = outcome(rec["decision"])
        rec["firstSeen"] = prev.get("firstSeen") or today.isoformat()
        history[a["ref"]] = rec

    for r in history.values():
        r["workType"] = effective_work(r)
    rows = decided_durations(history, since=today - timedelta(days=PREDICTION_WINDOW_DAYS))
    # Counting from validation (the application accepted as complete) back-tested
    # slightly better than from receipt, so forecasts use it when it's known.
    rows_v = decided_durations(history, since=today - timedelta(days=PREDICTION_WINDOW_DAYS), start_field="validated")
    # Only applications the latest pull shows as still undecided get a
    # forecast — an old record with an outcome but no issued date is not pending.
    pending_now = {a["ref"] for a in latest if not a.get("isDecided")}
    for ref, r in history.items():
        p = predictions.get(ref)
        if r.get("decisionDate"):
            if p and not p.get("actualDate"):
                p["actualDate"] = r["decisionDate"]
                pd, ad = parse_date(p["predictedDate"]), parse_date(r["decisionDate"])
                p["errorDays"] = (ad - pd).days if pd and ad else None
            continue
        if p or ref not in pending_now or r.get("decision") or not parse_date(r.get("received")):
            continue
        start_field = "validated" if parse_date(r.get("validated")) else "received"
        med, n, basis = typical_days(rows_v if start_field == "validated" else rows, r.get("workType"), r.get("applicationType"))
        if med is None:
            continue
        predicted = parse_date(r[start_field]) + timedelta(days=round(med))
        predicted += timedelta(days=(7 - predicted.weekday()) % 7 if predicted.weekday() >= 5 else 0)  # no weekend decisions
        predictions[ref] = {"madeOn": today.isoformat(), "received": r["received"], "validated": r.get("validated"),
                            "from": start_field, "workType": r.get("workType"),
                            "predictedDate": predicted.strftime("%a %d %b %Y"), "typicalDays": round(med),
                            "basedOn": n, "basis": basis}
    save_history(history)
    save(PREDICTIONS, predictions)
    write_timings(history)
    resolved = [p for p in predictions.values() if p.get("errorDays") is not None]
    print(f"history {len(history)} · predictions {len(predictions)} ({len(resolved)} resolved)", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--from", dest="frm")
    ap.add_argument("--to")
    ap.add_argument("--delay", type=float, default=0.5)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--update")
    args = ap.parse_args()
    if args.backfill:
        backfill(args.frm, args.to or date.today().strftime("%Y-%m"), args.delay, args.workers)
    if args.update:
        update(args.update)


if __name__ == "__main__":
    main()
