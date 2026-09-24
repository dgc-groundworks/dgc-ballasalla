#!/usr/bin/env python3
"""
Pulls planning applications from the Isle of Man Planning & Building
Control register (pbc.gov.im — an IDOX Public Access system) and writes
them as JSON for the Silverdale Canvassing app to read.

Runs server-side (GitHub Action) because the register doesn't allow
cross-origin browser requests and the applicant/agent name for each
application only appears on that application's own detail page — this
is a real multi-step scrape, not something a static page can do itself.

Usage:
    python3 pull_register.py --months 3 --out ../register-data/latest.json

--months N   pull the N most recent calendar months (default 3, max 6 —
             that's the ceiling the register itself keeps).
--out PATH   where to write the resulting JSON.
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup

BASE = "https://pbc.gov.im"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
}
DETAIL_DELAY_SECONDS = 0.3  # be polite to a small government server


def month_labels(n):
    """Last n calendar months as IDOX's own labels, e.g. 'Sep 26'."""
    labels = []
    d = datetime.utcnow().replace(day=1)
    for _ in range(n):
        labels.append(d.strftime("%b %y"))
        d = (d - timedelta(days=1)).replace(day=1)
    return labels


def new_session():
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def fetch_month_list(session, month_label, date_type):
    """date_type: 'DC_Validated' or 'DC_Decided'."""
    r = session.get(f"{BASE}/online-applications/search.do?action=monthlyList", timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    csrf_input = soup.find("input", {"name": "_csrf"})
    csrf = csrf_input["value"] if csrf_input else ""
    data = {
        "_csrf": csrf,
        "searchCriteria.parish": "",
        "month": month_label,
        "dateType": date_type,
        "searchType": "Application",
    }
    r2 = session.post(f"{BASE}/online-applications/monthlyListResults.do?action=firstPage", data=data, timeout=20)
    r2.raise_for_status()
    return r2.text


def parse_results_page(html):
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for li in soup.select("li.searchresult"):
        a = li.select_one("a.summaryLink")
        href = a["href"] if a else ""
        m = re.search(r"keyVal=([^&]+)", href)
        key_val = m.group(1) if m else None
        desc_el = li.select_one(".summaryLinkTextClamp")
        desc = desc_el.get_text(strip=True) if desc_el else ""
        addr_el = li.select_one("p.address")
        addr = addr_el.get_text(strip=True) if addr_el else ""
        meta_el = li.select_one("p.metaInfo")
        meta_text = meta_el.get_text(" ", strip=True) if meta_el else ""
        ref_m = re.search(r"Ref\.?\s*No:?\s*([^|]+?)\s*(?:\||$)", meta_text)
        recv_m = re.search(r"Received:\s*([^|]+?)\s*(?:\||$)", meta_text)
        val_m = re.search(r"Validated:\s*([^|]+?)\s*(?:\||$)", meta_text)
        dec_m = re.search(r"Decided:\s*([^|]+?)\s*(?:\||$)", meta_text)
        stat_m = re.search(r"Status:\s*([^|]+?)\s*$", meta_text)
        if not key_val or not ref_m:
            continue
        items.append({
            "keyVal": key_val,
            "ref": ref_m.group(1).strip(),
            "description": desc,
            "address": addr,
            "received": recv_m.group(1).strip() if recv_m else None,
            "validated": val_m.group(1).strip() if val_m else None,
            "decided": dec_m.group(1).strip() if dec_m else None,
            "status": stat_m.group(1).strip() if stat_m else None,
        })
    pager = soup.find(class_="pager")
    next_href = None
    if pager:
        next_a = pager.find("a", class_="next")
        if next_a:
            next_href = next_a["href"]
    return items, next_href


def fetch_all_for_month(session, month_label, date_type):
    html = fetch_month_list(session, month_label, date_type)
    all_items, next_href = parse_results_page(html)
    seen_pages = {1}
    while next_href:
        pm = re.search(r"searchCriteria\.page=(\d+)", next_href)
        page_num = int(pm.group(1)) if pm else None
        if page_num in seen_pages:
            break
        seen_pages.add(page_num)
        r = session.get(f"{BASE}{next_href}", timeout=20)
        r.raise_for_status()
        items, next_href = parse_results_page(r.text)
        all_items.extend(items)
        time.sleep(DETAIL_DELAY_SECONDS)
    return all_items


def fetch_detail(session, key_val):
    r = session.get(
        f"{BASE}/online-applications/applicationDetails.do?activeTab=printPreview&keyVal={key_val}",
        timeout=20,
    )
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    fields = {}
    for row in soup.select("table tr"):
        th = row.find("th")
        td = row.find("td")
        if th and td:
            fields[th.get_text(strip=True)] = td.get_text(strip=True)
    return fields


def not_available(value):
    return None if not value or value.strip().lower() == "not available" else value.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=3, help="how many recent months to pull (max 6)")
    ap.add_argument("--out", default="register-data/latest.json")
    args = ap.parse_args()
    months = min(max(args.months, 1), 6)

    session = new_session()
    by_ref = {}
    for month_label in month_labels(months):
        for date_type in ("DC_Validated", "DC_Decided"):
            print(f"Pulling {month_label} ({date_type})...", file=sys.stderr)
            try:
                items = fetch_all_for_month(session, month_label, date_type)
            except requests.RequestException as e:
                print(f"  failed: {e}", file=sys.stderr)
                continue
            print(f"  {len(items)} results", file=sys.stderr)
            for item in items:
                # Validated and Decided lists overlap once an application
                # has moved on — keep one entry per ref, merging in
                # whichever fields either pass found.
                existing = by_ref.setdefault(item["ref"], {})
                existing.update({k: v for k, v in item.items() if v})

    print(f"Fetching applicant/agent detail for {len(by_ref)} applications...", file=sys.stderr)
    results = []
    for i, (ref, item) in enumerate(by_ref.items(), 1):
        detail = {}
        if item.get("keyVal"):
            try:
                detail = fetch_detail(session, item["keyVal"])
            except requests.RequestException as e:
                print(f"  detail fetch failed for {ref}: {e}", file=sys.stderr)
            time.sleep(DETAIL_DELAY_SECONDS)
        if i % 20 == 0:
            print(f"  {i}/{len(by_ref)}", file=sys.stderr)

        status = item.get("status") or ""
        is_decided = bool(item.get("decided")) or "decision" in status.lower() and "pending" not in status.lower()
        results.append({
            "ref": ref,
            "description": item.get("description") or "",
            "address": item.get("address") or "",
            "parish": not_available(detail.get("Parish")),
            "received": item.get("received"),
            "validated": item.get("validated"),
            "decided": item.get("decided"),
            "status": status,
            "isDecided": is_decided,
            "applicationType": not_available(detail.get("Application Type")),
            "applicantName": not_available(detail.get("Applicant Name")),
            "agentName": not_available(detail.get("Agent Name")),
            "agentCompanyName": not_available(detail.get("Agent Company Name")),
            "agentAddress": not_available(detail.get("Agent Address")),
        })

    output = {
        "source": "pbc.gov.im",
        "pulledAt": datetime.utcnow().isoformat() + "Z",
        "monthsRequested": months,
        "count": len(results),
        "applications": sorted(results, key=lambda r: r["ref"], reverse=True),
    }

    import os
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(results)} applications to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
