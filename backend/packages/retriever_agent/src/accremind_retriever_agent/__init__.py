"""Deterministic tokenization, ranking and offline retrieval metrics."""

import re

ALIASES = {
    "reactjs": "react",
    "react.js": "react",
    "ts": "typescript",
    "js": "javascript",
    "vuejs": "vue",
    "py": "python",
}


def normalize_technology(value: str) -> str:
    return ALIASES.get(value.lower().strip(), value.lower().strip())


def terms(value: str) -> list[str]:
    lowered = value.lower()
    found = {normalize_technology(token) for token in re.findall(r"[a-z0-9_.-]{2,}", lowered)}
    for sequence in re.findall(r"[\u4e00-\u9fff]+", lowered):
        found.add(sequence)
        found.update(sequence[i : i + 2] for i in range(len(sequence) - 1))
    return sorted(found)


def rrf(rankings: list[list[str]], *, k: int = 60) -> dict[str, float]:
    result: dict[str, float] = {}
    for ranking in rankings:
        for rank, identifier in enumerate(dict.fromkeys(ranking), 1):
            result[identifier] = result.get(identifier, 0) + 1 / (k + rank)
    return result


def metrics(expected: set[str], actual: list[str], k: int = 5) -> dict[str, float]:
    top = actual[:k]
    return {
        "recall_at_k": len(expected.intersection(top)) / len(expected)
        if expected
        else float(not top),
        "reciprocal_rank": next((1 / (i + 1) for i, item in enumerate(top) if item in expected), 0),
    }
