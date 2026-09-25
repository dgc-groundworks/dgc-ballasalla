#!/usr/bin/env python3
"""
Best-effort measurement of a plot's real-world size from its published
site plan drawing.

Isle of Man planning applications almost always include a location/site
plan reproduced from the Isle of Man Survey base map, printed at a stated
scale (e.g. "Scale: 1:250") with the site outlined in red. This finds
that document, OCRs the printed scale (the labels on these drawings are
vector line-art, not real text, so they can't be read directly from the
PDF), and uses the red outline's bounding box to work out the plot's
approximate width, height and area.

Deliberately conservative: returns None whenever the document, the scale,
the Survey template or a plausible red outline can't all be confirmed,
rather than reporting a number it isn't confident in. It gives the
red outline's bounding box (a rectangle around the plot), not the exact
outline shape, so it's always an upper estimate for an irregular plot —
labelled as such wherever it's shown.
"""
import io
import re

# Descriptions/filenames use underscores as separators ("SITE_PLAN"), not
# spaces, so word breaks are matched as [\s_]* rather than \s*.
SITE_PLAN_RE = re.compile(r"site[\s_]*(and[\s_]*location[\s_]*)?plan|location[\s_]*plan", re.I)
SCALE_RE = re.compile(r"scale[:\s]*1\s*[:\.]\s*(\d{2,5})", re.I)
SURVEY_RE = re.compile(r"isle\s*of\s*man\s*surve|department\s*of\s*infrastructure|isle\s*of\s*man\s*government", re.I)
MIN_AREA_M2, MAX_AREA_M2 = 20, 50000  # sanity bounds — reject an obvious mis-read rather than report it
MM_PER_PT = 25.4 / 72


def _is_reddish(color):
    if not color or len(color) < 3:
        return False
    r, g, b = color[0], color[1], color[2]
    return r > 0.55 and r > g * 1.7 and r > b * 1.7


def candidate_documents(docs):
    return [d for d in docs if SITE_PLAN_RE.search(f"{d.get('type', '')} {d.get('description', '')}")]


def measure_pdf_bytes(pdf_bytes):
    """Returns {widthM, heightM, envelopeAreaM2, scale} or None."""
    try:
        import fitz
        import pytesseract
        from PIL import Image
    except ImportError:
        return None
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page = doc[0]
        pix = page.get_pixmap(dpi=150)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        text = pytesseract.image_to_string(img)
        scale_m = SCALE_RE.search(text)
        if not scale_m or not SURVEY_RE.search(text):
            return None
        scale = int(scale_m.group(1))
        reds = [dr for dr in page.get_drawings() if _is_reddish(dr.get("color"))]
        if not reds:
            return None
        xs, ys = [], []
        for dr in reds:
            rect = dr["rect"]
            xs += [rect.x0, rect.x1]
            ys += [rect.y0, rect.y1]
        w_m = (max(xs) - min(xs)) * MM_PER_PT * scale / 1000
        h_m = (max(ys) - min(ys)) * MM_PER_PT * scale / 1000
        area = round(w_m * h_m)
        if not (MIN_AREA_M2 <= area <= MAX_AREA_M2):
            return None
        return {"widthM": round(w_m, 1), "heightM": round(h_m, 1), "envelopeAreaM2": area, "scale": scale}
    except Exception:
        return None


def measure(session, base_url, doc_page_url, docs):
    """Tries each candidate site/location plan document in turn, using the
    given session (already holding the cookies from browsing the register)
    and Referer, and returns the first successful measurement."""
    for d in candidate_documents(docs)[:3]:
        try:
            r = session.get(f"{base_url}{d['href']}", headers={"Referer": doc_page_url}, timeout=20)
        except Exception:
            continue
        if r.status_code != 200 or "pdf" not in r.headers.get("content-type", "").lower():
            continue
        result = measure_pdf_bytes(r.content)
        if result:
            result["document"] = d.get("description") or d.get("type") or ""
            return result
    return None
