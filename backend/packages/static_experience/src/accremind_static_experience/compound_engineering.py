import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from accremind_contracts import (
    Applicability,
    CandidateDraft,
    ExperienceValidation,
    Phase,
    Scope,
    StaticExperienceDocument,
)
from pydantic import ValidationError

HEADING_PATTERN = re.compile(r"^(?P<marks>#{2,4})\s+(?P<title>.+?)\s*$")
META_PATTERN = re.compile(r"^\s*>\s*\*\*meta\*\*\s*(?P<values>.+?)\s*$")
TAGS_PATTERN = re.compile(r"^\s*>\s*\*\*tags\*\*\s*(?P<values>.+?)\s*$")
BACKTICK_PATTERN = re.compile(r"`([^`]*)`")
REQUIRED_META = frozenset({"type", "tech", "domain", "severity", "validated"})
TYPE_PHASES = {
    "fix": Phase.TROUBLESHOOT,
    "pattern": Phase.IMPLEMENT,
    "ref": Phase.DESIGN,
}


@dataclass(frozen=True)
class ConversionIssue:
    source_path: str
    line: int
    title: str
    message: str


@dataclass(frozen=True)
class CompoundEngineeringConversion:
    documents: tuple[StaticExperienceDocument, ...]
    issues: tuple[ConversionIssue, ...]


@dataclass(frozen=True)
class _EntryStart:
    line_index: int
    heading_level: int
    title: str
    meta_line_index: int


def convert_compound_engineering_markdown(
    text: str,
    *,
    source_path: str,
    owner_id: str,
    scope: Scope,
) -> CompoundEngineeringConversion:
    """Convert every legacy Compound Engineering entry in one Markdown file."""

    normalized_text = _normalize_text(text)
    lines = normalized_text.splitlines()
    starts = _find_entry_starts(lines)
    documents: list[StaticExperienceDocument] = []
    issues: list[ConversionIssue] = []

    for position, start in enumerate(starts):
        next_entry = starts[position + 1].line_index if position + 1 < len(starts) else len(lines)
        end = _entry_end(lines, start, next_entry)
        result = _convert_entry(
            lines,
            start=start,
            end=end,
            source_path=source_path,
            owner_id=owner_id,
            scope=scope,
        )
        if isinstance(result, ConversionIssue):
            issues.append(result)
        else:
            documents.append(result)

    return CompoundEngineeringConversion(documents=tuple(documents), issues=tuple(issues))


def _normalize_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _find_entry_starts(lines: list[str]) -> list[_EntryStart]:
    starts: list[_EntryStart] = []
    for index, line in enumerate(lines):
        heading = HEADING_PATTERN.match(line)
        if heading is None:
            continue
        next_index = index + 1
        while next_index < len(lines) and not lines[next_index].strip():
            next_index += 1
        if next_index < len(lines) and META_PATTERN.match(lines[next_index]):
            starts.append(
                _EntryStart(
                    line_index=index,
                    heading_level=len(heading.group("marks")),
                    title=heading.group("title").strip(),
                    meta_line_index=next_index,
                )
            )
    return starts


def _entry_end(lines: list[str], start: _EntryStart, next_entry: int) -> int:
    for index in range(start.meta_line_index + 1, next_entry):
        heading = HEADING_PATTERN.match(lines[index])
        if heading is not None and len(heading.group("marks")) <= start.heading_level:
            return index
    return next_entry


def _convert_entry(
    lines: list[str],
    *,
    start: _EntryStart,
    end: int,
    source_path: str,
    owner_id: str,
    scope: Scope,
) -> StaticExperienceDocument | ConversionIssue:
    meta_match = META_PATTERN.match(lines[start.meta_line_index])
    if meta_match is None:
        return _issue(source_path, start, "缺少 meta 行")
    metadata = _parse_metadata(meta_match.group("values"))
    missing = sorted(REQUIRED_META - metadata.keys())
    if missing:
        return _issue(source_path, start, f"meta 缺少必填字段：{', '.join(missing)}")

    tags_line_index = _next_nonempty_line(lines, start.meta_line_index + 1, end)
    if tags_line_index is None:
        return _issue(source_path, start, "缺少 tags 行")
    tags_match = TAGS_PATTERN.match(lines[tags_line_index])
    if tags_match is None:
        return _issue(source_path, start, "meta 后缺少 tags 行")
    tags = _parse_tags(tags_match.group("values"))
    if not tags:
        return _issue(source_path, start, "tags 不能为空")

    body = _clean_body(lines[tags_line_index + 1 : end])
    if not body:
        return _issue(source_path, start, "经验正文不能为空")

    try:
        verified_on = date.fromisoformat(metadata["validated"][0])
    except ValueError:
        return _issue(source_path, start, "validated 必须是 YYYY-MM-DD 日期")

    entry_type = metadata["type"][0]
    phase = TYPE_PHASES.get(entry_type)
    if phase is None:
        return _issue(source_path, start, f"不支持的经验类型：{entry_type}")

    domain = metadata["domain"][0]
    severity = metadata["severity"][0]
    technologies = _unique([metadata["tech"][0], *metadata.get("version", [])])
    file_id = _stable_file_id(source_path, start.title, domain)
    content_hash = _content_hash(start.title, metadata, tags, body)

    try:
        candidate = CandidateDraft(
            title=start.title,
            problem=_problem_for(entry_type, start.title),
            context=(
                f"来源于 {source_path} 的 Compound Engineering 静态经验；"
                f"type={entry_type}，severity={severity}。"
            ),
            solution=body,
            validation=ExperienceValidation(
                method="按来源条目的验证记录复核；发布前仍需由审核者确认适用性。",
                result=f"来源条目标记 validated={verified_on.isoformat()}。",
                verified_on=verified_on,
            ),
            applicability=Applicability(
                domains=[domain],
                technologies=technologies,
                phases=[phase],
                triggers=tags,
            ),
        )
        return StaticExperienceDocument(
            file_id=file_id,
            owner_id=owner_id,
            scope=scope,
            experience=candidate,
            content_hash=content_hash,
        )
    except ValidationError as error:
        return _issue(source_path, start, f"契约校验失败：{error.errors()[0]['msg']}")


def _parse_metadata(value: str) -> dict[str, list[str]]:
    metadata: dict[str, list[str]] = {}
    for token in BACKTICK_PATTERN.findall(value):
        if "=" not in token:
            continue
        key, item = token.split("=", 1)
        key = key.strip()
        item = item.strip()
        if key and item:
            metadata.setdefault(key, []).append(item)
    return metadata


def _parse_tags(value: str) -> list[str]:
    tokens = BACKTICK_PATTERN.findall(value)
    raw_tags = ",".join(tokens)
    return _unique(tag.strip() for tag in raw_tags.split(",") if tag.strip())


def _next_nonempty_line(lines: list[str], start: int, end: int) -> int | None:
    for index in range(start, end):
        if lines[index].strip():
            return index
    return None


def _clean_body(lines: list[str]) -> str:
    cleaned = list(lines)
    while cleaned and (not cleaned[0].strip() or cleaned[0].strip() == "---"):
        cleaned.pop(0)
    while cleaned and (not cleaned[-1].strip() or cleaned[-1].strip() == "---"):
        cleaned.pop()
    return "\n".join(line.rstrip() for line in cleaned).strip()


def _problem_for(entry_type: str, title: str) -> str:
    prefixes = {
        "fix": "需要排查并修复：",
        "pattern": "需要采用可复用的实现模式：",
        "ref": "需要正确使用相关 API 或能力：",
    }
    return f"{prefixes[entry_type]}{title}"


def _stable_file_id(source_path: str, title: str, domain: str) -> str:
    identity = f"{source_path}\0{title}".encode()
    digest = hashlib.sha256(identity).hexdigest()[:24]
    safe_domain = re.sub(r"[^A-Za-z0-9._-]+", "-", domain).strip("-") or "general"
    return f"ce:{safe_domain}:{digest}"


def _content_hash(
    title: str,
    metadata: dict[str, list[str]],
    tags: list[str],
    body: str,
) -> str:
    payload = {
        "title": title,
        "metadata": metadata,
        "tags": tags,
        "body": body,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _issue(source_path: str, start: _EntryStart, message: str) -> ConversionIssue:
    return ConversionIssue(
        source_path=source_path,
        line=start.line_index + 1,
        title=start.title,
        message=message,
    )
