#!/usr/bin/env python3
"""
In-memory access to an application's own proposed-plan drawing, for a
caller (e.g. the value estimator) that wants to show it to Claude's
vision rather than trying to measure it deterministically — reading a
hand-drawn floor plan is a judgement call, not something OCR/geometry
can do reliably (see site_extent.py's docstring for why that approach
stops at the site's plot boundary and goes no further).

Nothing here is written to disk or uploaded anywhere; it hands back
bytes in memory for the caller to use and discard.
"""
import re

from pull_register import BASE, fetch_documents, new_session

# Site/location plans (site_extent.py's territory — the plot boundary,
# not the building) are explicitly excluded so this always reaches for
# the building's own drawing instead.
SITE_PLAN_RE = re.compile(r"site[\s_]*(and[\s_]*location[\s_]*)?plan|location[\s_]*plan", re.I)
PROPOSED_PLAN_RE = re.compile(r"propos|floor[\s_]*plan|layout|elevation", re.I)


def best_plan_document(docs):
    """The most likely proposed floor plan / layout / elevation document,
    or None. docs: [{"type", "description", "href"}, ...] from
    pull_register.fetch_documents()."""
    candidates = [d for d in docs
                  if PROPOSED_PLAN_RE.search(f"{d.get('type', '')} {d.get('description', '')}")
                  and not SITE_PLAN_RE.search(f"{d.get('type', '')} {d.get('description', '')}")]
    return candidates[0] if candidates else None


def best_plan_image(key_val, session=None, dpi=120):
    """Renders page 1 of the best-guess proposed-plan document to a PNG,
    in memory only. Returns PNG bytes, or None if no likely document is
    found or it can't be fetched/rendered."""
    try:
        import fitz
    except ImportError:
        return None
    session = session or new_session()
    try:
        docs, doc_url = fetch_documents(session, key_val)
        doc = best_plan_document(docs)
        if not doc:
            return None
        r = session.get(f"{BASE}{doc['href']}", headers={"Referer": doc_url}, timeout=20)
        if r.status_code != 200 or "pdf" not in r.headers.get("content-type", "").lower():
            return None
        pdf = fitz.open(stream=r.content, filetype="pdf")
        return pdf[0].get_pixmap(dpi=dpi).tobytes("png")
    except Exception:
        return None
