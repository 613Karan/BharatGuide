"""Retrieval evaluation (spec 11).

    python -m rag.eval                 # uses ABSTAIN_THRESHOLD from env
    python -m rag.eval --sweep         # also report abstain accuracy per threshold

Targets: recall@5 >= 0.85 on answerable, >= 4/5 abstains correct, p95 latency
< 1.5 s (retrieval only, excluding the LLM).
"""
from __future__ import annotations

import argparse
import json
import statistics
from dataclasses import replace
from pathlib import Path

from .config import ROOT, settings
from .embed import get_embedder
from .retrieval import Retriever
from .store import get_client

GOLD = ROOT / "tests" / "gold.jsonl"


def load_gold(path: Path = GOLD) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def evaluate(retriever: Retriever, gold: list[dict]) -> dict:
    rows = []
    for item in gold:
        out = retriever.search(item["query"], top_k=5)
        docs = [r["doc_id"] for r in out.results]
        sections = " ".join(r["citation"]["section_path"] or "" for r in out.results).lower()
        hit = bool(set(docs) & set(item["expected_doc_ids"]))
        if item.get("expected_section_contains"):
            hit = hit and item["expected_section_contains"].lower() in sections
        rows.append(
            {
                "id": item["id"],
                "must_abstain": item["must_abstain"],
                "abstain": out.abstain,
                "reason": out.reason,
                "top_dense": round(out.top_dense, 4),
                "hit": hit,
                "docs": docs,
                "latency_ms": out.latency_ms,
            }
        )
    answerable = [r for r in rows if not r["must_abstain"]]
    abstains = [r for r in rows if r["must_abstain"]]
    latencies = sorted(r["latency_ms"] for r in rows)
    p95 = latencies[min(len(latencies) - 1, int(round(0.95 * (len(latencies) - 1))))]
    return {
        "threshold": settings.abstain_threshold,
        "recall_at_5": round(sum(r["hit"] and not r["abstain"] for r in answerable) / max(1, len(answerable)), 3),
        "abstain_correct": f"{sum(r['abstain'] for r in abstains)}/{len(abstains)}",
        "false_abstains": [r["id"] for r in answerable if r["abstain"]],
        "p95_latency_ms": p95,
        "median_latency_ms": statistics.median(latencies),
        "rows": rows,
    }


def sweep(rows: list[dict]) -> list[str]:
    """Abstain accuracy for alternative thresholds from the recorded top cosines."""
    lines = []
    for t in [0.35, 0.40, 0.45, 0.50, 0.55, 0.60]:
        ok_abs = sum(1 for r in rows if r["must_abstain"] and (r["reason"] == "out_of_scope" or r["top_dense"] < t))
        false_abs = sum(1 for r in rows if not r["must_abstain"] and r["top_dense"] < t)
        n_abs = sum(r["must_abstain"] for r in rows)
        lines.append(f"threshold {t:.2f}: abstains correct {ok_abs}/{n_abs}, false abstains {false_abs}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sweep", action="store_true")
    args = parser.parse_args()
    retriever = Retriever(get_client(), get_embedder())
    report = evaluate(retriever, load_gold())
    for row in report["rows"]:
        flag = "ABST" if row["abstain"] else ("HIT " if row["hit"] else "MISS")
        print(f"{row['id']} {flag} cos={row['top_dense']:.3f} {row['latency_ms']:>7}ms {row['docs'][:3]}")
    print(
        f"\nrecall@5={report['recall_at_5']}  abstains={report['abstain_correct']}  "
        f"false_abstains={report['false_abstains']}  p95={report['p95_latency_ms']}ms"
    )
    if args.sweep:
        print("\n".join(sweep(report["rows"])))
    (ROOT / "eval_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    ok = report["recall_at_5"] >= 0.85 and int(report["abstain_correct"].split("/")[0]) >= 4
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
