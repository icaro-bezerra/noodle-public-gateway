#!/usr/bin/env python3
"""Classify every Noodle API route for the public gateway allowlist.

Usage: python3 classify-routes.py <openapi-spec.json> <output-dir>
Writes route-classification.json and route-classification.md.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

METHODS = ("get", "head", "post", "put", "patch", "delete")


def classify(method: str, op: dict) -> str:
    if not op.get("security"):
        return "public"
    if op.get("x-immich-admin-only"):
        return "admin"
    perm = op.get("x-immich-permission")
    if perm is None:
        return "full"  # requires the `all` permission: unusable with a read-only key
    if perm.endswith(".read"):
        return "read"
    return "write"


def main() -> None:
    spec_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    spec = json.loads(spec_path.read_text())
    routes = []
    for path, item in sorted(spec["paths"].items()):
        for method in METHODS:
            op = item.get(method)
            if op is None:
                continue
            routes.append(
                {
                    "method": method.upper(),
                    "path": "/api" + path,
                    "operationId": op.get("operationId"),
                    "permission": op.get("x-immich-permission"),
                    "class": classify(method, op),
                    "tags": op.get("tags", []),
                }
            )

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "route-classification.json").write_text(json.dumps(routes, indent=2) + "\n")

    by_class = defaultdict(list)
    for r in routes:
        by_class[r["class"]].append(r)

    lines = ["# Noodle route classification", "", f"Generated from `{spec_path.name}` ({len(routes)} operations).", ""]
    lines += ["| Class | Count |", "|---|---|"]
    lines += [f"| {c} | {len(by_class[c])} |" for c in ("read", "public", "full", "write", "admin")]
    for c in ("read", "public", "full", "write", "admin"):
        lines += ["", f"## {c}", "", "| Method | Path | Permission | operationId |", "|---|---|---|---|"]
        lines += [f"| {r['method']} | `{r['path']}` | {r['permission'] or '-'} | {r['operationId']} |" for r in by_class[c]]
    (out_dir / "route-classification.md").write_text("\n".join(lines) + "\n")

    for c in ("read", "public", "full", "write", "admin"):
        print(f"{c:7} {len(by_class[c])}")


if __name__ == "__main__":
    main()
