#!/usr/bin/env python3
"""
Finds the original application behind paperwork and follow-on applications on
the canvassing list (e.g. "Information in relation to Condition 5 of PA
19/01234/B") when it is older than the history we hold, looks it up on the
planning register by reference and adds it to history.json. The estimator can
then price the real job, and the app can show when the original was applied for
and decided (Ash, 26 Sep 2026: "go find the original application that would have
been approved a long time ago").

Follows the chain one step further (an original's own original, e.g. condition
details -> reserved matters -> approval in principle). Runs in the weekly pull
and in pricing-only runs, before the estimator.

  python3 fetch_originals.py [--max 150]
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import date

import requests
from bs4 import BeautifulSoup

from estimate_values import load_estimates, valued_under
from planning_history import DATA, load_history, record_from, save_history, write_timings
from pull_register import BASE, DETAIL_DELAY_SECONDS, fetch_detail, new_session, not_available

LATEST = os.path.join(DATA, "latest.json")
REF_RE = re.compile(r"(?<!\d)\d{2}/\d{5}/[A-Z]{1,4}\b")


def mentioned(r):
    return [m for m in REF_RE.findall(r.get("description") or "") if m != r["ref"]]


def lookup(session, ref):
    """The register's own record for one reference, or None if it isn't there."""
    page = session.get(f"{BASE}/online-applications/search.do?action=advanced", timeout=30)
    page.raise_for_status()
    csrf = BeautifulSoup(page.text, "html.parser").find("input", {"name": "_csrf"})["value"]
    res = session.post(f"{BASE}/online-applications/advancedSearchResults.do?action=firstPage", timeout=30,
                       data={"_csrf": csrf, "searchType": "Application", "caseAddressType": "Application",
                             "searchCriteria.reference": ref})
    res.raise_for_status()
    for key_val in dict.fromkeys(re.findall(r"keyVal=([A-Z0-9]+)", res.url + " " + res.text)):
        detail = fetch_detail(session, key_val)
        if (detail.get("Reference") or "").strip() == ref:
            item = {"ref": ref, "keyVal": key_val, "description": not_available(detail.get("Proposal")) or "",
                    "address": not_available(detail.get("Address")) or ""}
            return {**record_from(item, detail), "firstSeen": date.today().isoformat(), "foundAs": "original"}
        time.sleep(DETAIL_DELAY_SECONDS)
    return None


def main(max_lookups):
    history = load_history()
    with open(LATEST) as f:
        on_list = json.load(f).get("applications", [])
    est = load_estimates()
    wanted = list(dict.fromkeys([m for a in on_list for m in mentioned(a) if m not in history]
                                + [m for a in on_list for m in valued_under(est.get(a["ref"])) if m not in history and m != a["ref"]]))
    print(f"{len(wanted)} originals named on the list are older than the history held", file=sys.stderr)
    session, found, missing, looked = new_session(), 0, [], 0
    for depth in (1, 2):
        for ref in wanted:
            if looked >= max_lookups:
                break
            looked += 1
            try:
                rec = lookup(session, ref)
            except requests.RequestException as e:
                print(f"  {ref}: register error {e}", file=sys.stderr)
                session = new_session()
                continue
            if rec:
                history[ref] = rec
                found += 1
            else:
                missing.append(ref)
            time.sleep(DETAIL_DELAY_SECONDS)
        # The originals' own originals, one step further back.
        wanted = list(dict.fromkeys(m for ref in wanted if ref in history for m in mentioned(history[ref]) if m not in history))
        if not wanted:
            break
    if found:
        save_history(history)
        write_timings(history)
    print(f"added {found} originals to the history; not on the register: {', '.join(missing) or 'none'}", file=sys.stderr)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=150, help="most register look-ups in one run")
    main(ap.parse_args().max)
