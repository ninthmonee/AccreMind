"""Bounded, deterministic Markdown interchange and diagnostic-only sensitive-data scanning."""

import hashlib
import json
import re
from dataclasses import dataclass

import yaml
from accremind_contracts import StaticExperienceDocument
from yaml.tokens import (
    AliasToken,
    AnchorToken,
    BlockEndToken,
    BlockMappingStartToken,
    BlockSequenceStartToken,
    FlowMappingEndToken,
    FlowMappingStartToken,
    FlowSequenceEndToken,
    FlowSequenceStartToken,
)

MAX_FILE_BYTES = 128_000


@dataclass
class StaticFileError(ValueError):
    field: str
    message: str
    line: int | None = None

    def __str__(self) -> str:
        return self.message


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def _mapping(loader: UniqueKeyLoader, node: yaml.MappingNode) -> dict:
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        if not isinstance(key, str) or key in result:
            raise StaticFileError(
                "front_matter", "keys must be unique strings", key_node.start_mark.line + 2
            )
        result[key] = loader.construct_object(value_node, deep=True)
    return result


UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


def normalize_body(body: str) -> str:
    return "\n".join(
        line.rstrip() for line in body.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    ).strip()


def content_hash(document: StaticExperienceDocument, body: str) -> str:
    # experience_id is a server-assigned linkage, not authored content.
    payload = document.model_dump(
        mode="json", exclude={"content_hash", "experience_id", "base_version"}
    )
    payload["markdown_body"] = normalize_body(body)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def parse_markdown(text: str) -> tuple[StaticExperienceDocument, str]:
    if len(text.encode("utf-8")) > MAX_FILE_BYTES or "\x00" in text:
        raise StaticFileError("file", "file is binary or exceeds 128000 bytes")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    if not lines or lines[0] != "---":
        raise StaticFileError("front_matter", "expected opening ---", 1)
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise StaticFileError("front_matter", "missing closing ---") from error
    front = "\n".join(lines[1:end])
    try:
        depth = 0
        for token in yaml.scan(front):
            if isinstance(token, (AliasToken, AnchorToken)):
                raise StaticFileError("front_matter", "YAML aliases and anchors are unsupported")
            if isinstance(
                token,
                (
                    BlockMappingStartToken,
                    BlockSequenceStartToken,
                    FlowMappingStartToken,
                    FlowSequenceStartToken,
                ),
            ):
                depth += 1
            if isinstance(token, (BlockEndToken, FlowMappingEndToken, FlowSequenceEndToken)):
                depth -= 1
            if depth > 20:
                raise StaticFileError("front_matter", "YAML nesting exceeds 20 levels")
        raw = yaml.load(front, Loader=UniqueKeyLoader)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        raise StaticFileError(
            "front_matter", "invalid YAML", mark.line + 2 if mark else None
        ) from error
    if not isinstance(raw, dict):
        raise StaticFileError("front_matter", "expected a mapping")
    # A saved hash is informational: edits legitimately invalidate it. Recompute on import.
    raw["content_hash"] = "0" * 64
    document = StaticExperienceDocument.model_validate(raw)
    body = normalize_body("\n".join(lines[end + 1 :]))
    document.content_hash = content_hash(document, body)
    return document, body


def render_markdown(document: StaticExperienceDocument, body: str = "") -> str:
    document = document.model_copy(update={"content_hash": content_hash(document, body)})
    front = yaml.safe_dump(document.model_dump(mode="json"), allow_unicode=True, sort_keys=False)
    return f"---\n{front}---\n\n{normalize_body(body)}\n"


SENSITIVE_PATTERNS = {
    "private_key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "credential": r"\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b",
    "assigned_secret": (
        r"(?i)\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*"
        r"[\x22\x27]?[A-Za-z0-9_+/=-]{12,}"
    ),
    "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    "phone": r"(?<!\d)(?:\+86[- ]?)?1[3-9]\d{9}(?!\d)",
    "identity_number": r"(?<!\d)\d{17}[\dXx](?!\d)",
}


def scan_sensitive(text: str) -> list[StaticFileError]:
    issues = []
    for kind, pattern in SENSITIVE_PATTERNS.items():
        match = re.search(pattern, text)
        if match:
            issues.append(
                StaticFileError(
                    "content", f"sensitive_data:{kind}", text[: match.start()].count("\n") + 1
                )
            )
    for match in re.finditer(r"```[^\n]*\n(.*?)```", text, re.S):
        if len(match.group(1)) > 8_000 or match.group(1).count("\n") > 150:
            issues.append(
                StaticFileError(
                    "content", "oversized_code_block", text[: match.start()].count("\n") + 1
                )
            )
    return issues
