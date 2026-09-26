#!/usr/bin/env python3
"""
Keeps every application the canvassing list has ever shown. The weekly pull
only fetches the last few months, so without this anything older would drop
off the list before anyone had decided whether to write to it (Ash, 26 Sep
2026: "keep stacking them, keep all the old ones"). Run straight after the pull:

  python3 merge_register.py register-data/latest.previous.json register-data/latest.json

Applications in the new pull win (fresher status). Earlier ones missing from
it are kept, with their decision refreshed from history.json where that has
something newer.
"""
import json
import os
import sys

from planning_history import load_history


def main(prev_path, new_path):
    if not os.path.exists(prev_path):
        print("no earlier list to keep")
        return
    with open(prev_path) as f:
        prev = json.load(f).get("applications", [])
    with open(new_path) as f:
        out = json.load(f)
    apps = out.get("applications", [])
    have = {a["ref"] for a in apps}
    history = load_history()
    kept = 0
    for a in prev:
        if a["ref"] in have:
            continue
        h = history.get(a["ref"], {})
        if h.get("decision") and not a.get("decision"):
            a.update(decision=h["decision"], decisionDate=h.get("decisionDate"), isDecided=True, status="Decided")
        apps.append(a)
        have.add(a["ref"])
        kept += 1
    out["applications"] = sorted(apps, key=lambda r: r["ref"], reverse=True)
    out["count"] = len(apps)
    out["keptFromEarlier"] = kept
    with open(new_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"kept {kept} earlier applications; {len(apps)} on the list")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
