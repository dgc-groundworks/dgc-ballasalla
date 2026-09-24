#!/usr/bin/env python3
"""
Optional: has Claude read each planning application's description and
record what the work really is, how complex it is (1-5) and how many
homes it creates. Runs in the weekly GitHub Action only when the
ANTHROPIC_API_KEY secret is set; otherwise it does nothing and the
keyword rules in planning_history.py are used instead.

  python3 ai_classify.py [--max 2000]
"""
import argparse
import json
import os
import sys

from planning_history import WORK_TYPES, load_history, save_history, write_timings

MODEL = "claude-opus-5"
BATCH = 60

SYSTEM = f"""You classify Isle of Man planning applications from their register description.

For each application return:
- workType: exactly one of {json.dumps(WORK_TYPES)}. Use "Conditions / information" for discharging or providing information under a condition of an earlier approval, "Variation of conditions" for changing or removing conditions, "Small works" for doors, flues, fences, gates, chimneys, rendering and similar, and "Extension / alterations" for extensions, dormers, conservatories, garages, loft conversions and other alterations to an existing building. New homes are split by how many dwellings the application creates.
- complexity: 1 = trivial (a door, a flue, a sign), 2 = minor householder work, 3 = substantial householder work or a single new home, 4 = several homes, a sizeable commercial scheme or a sensitive site (registered building, conservation area, countryside), 5 = major development (10+ homes, large commercial or infrastructure).
- dwellings: net new homes created, 0 if none.
Judge only from the description and application type given. Return one result per input ref, using the ref exactly as given."""

SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string"},
                    "workType": {"type": "string", "enum": WORK_TYPES},
                    "complexity": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
                    "dwellings": {"type": "integer"},
                },
                "required": ["ref", "workType", "complexity", "dwellings"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["results"],
    "additionalProperties": False,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=2000, help="most applications to classify in one run")
    args = ap.parse_args()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set - skipping Claude classification", file=sys.stderr)
        return

    import anthropic
    client = anthropic.Anthropic()
    history = load_history()
    todo = [r for r in history.values() if r.get("description") and not r.get("aiWork")][: args.max]
    print(f"classifying {len(todo)} applications", file=sys.stderr)
    done = 0
    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        payload = [{"ref": r["ref"], "description": r["description"], "applicationType": r.get("applicationType") or ""} for r in batch]
        try:
            response = client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=SYSTEM,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
            )
        except anthropic.RateLimitError:
            print("rate limited - stopping this run, the rest carries over to next week", file=sys.stderr)
            break
        except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
            print(f"batch {i // BATCH} failed: {e}", file=sys.stderr)
            continue
        if response.stop_reason in ("refusal", "max_tokens"):
            print(f"batch {i // BATCH} stopped ({response.stop_reason}) - skipped", file=sys.stderr)
            continue
        text = next((b.text for b in response.content if b.type == "text"), "")
        try:
            results = json.loads(text)["results"]
        except (json.JSONDecodeError, KeyError):
            print(f"batch {i // BATCH}: unreadable reply - skipped", file=sys.stderr)
            continue
        for res in results:
            r = history.get(res["ref"])
            if r:
                r["aiWork"], r["aiComplexity"], r["aiDwellings"] = res["workType"], res["complexity"], res["dwellings"]
                done += 1
        save_history(history)
    write_timings(history)
    print(f"classified {done}", file=sys.stderr)


if __name__ == "__main__":
    main()
