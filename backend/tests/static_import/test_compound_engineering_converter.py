from pathlib import Path

from accremind_contracts import Phase, Scope
from accremind_static_experience import convert_compound_engineering_markdown

ROOT = Path(__file__).resolve().parents[3]
SOURCE_ROOT = ROOT / "compound-engineering" / "references" / "experiences"
SCOPE = Scope(organization_id="accremind", team_id="frontend")


def convert(text: str, source_path: str = "compound-engineering/references/experiences/api.md"):
    return convert_compound_engineering_markdown(
        text,
        source_path=source_path,
        owner_id="compound-maintainers",
        scope=SCOPE,
    )


def test_converts_multiple_entries_and_keeps_nested_sections_in_body() -> None:
    source = (
        """
## API patterns

### Request sequence guard

> **meta** `type=fix` `tech=vue3` `domain=api` `severity=high` """
        """`validated=2026-05-26` `version=vue@3.4`
 > **tags** `api, stale-response, api`

Guard the latest response.

#### Verification notes

Resolve requests out of order.

## Another group

### Request client methods

> **meta** `type=pattern` `tech=general` `domain=api` `severity=medium` `validated=2026-05-27`
> **tags** `request, patch`

Use the method supported by the client.
""".strip()
    )
    result = convert(source)

    assert result.issues == ()
    assert len(result.documents) == 2
    first = result.documents[0]
    assert first.file_id.startswith("ce:api:")
    assert first.experience.applicability.technologies == ["vue3", "vue@3.4"]
    assert first.experience.applicability.triggers == ["api", "stale-response"]
    assert first.experience.applicability.phases == [Phase.TROUBLESHOOT]
    assert "#### Verification notes" in first.experience.solution
    assert "## Another group" not in first.experience.solution


def test_file_id_is_stable_while_content_hash_tracks_body_changes() -> None:
    original = """
### Stable entry
> **meta** `type=pattern` `tech=general` `domain=api` `severity=low` `validated=2026-05-26`
> **tags** `api`

Original body.
""".strip()
    changed = original.replace("Original body.", "Changed body.")

    first = convert(original).documents[0]
    second = convert(changed).documents[0]

    assert first.file_id == second.file_id
    assert first.content_hash != second.content_hash


def test_invalid_entry_is_reported_without_discarding_valid_entries() -> None:
    result = convert(
        """
### Missing tags
> **meta** `type=fix` `tech=general` `domain=api` `severity=high` `validated=2026-05-26`

This entry has no tags.

### Valid entry
> **meta** `type=ref` `tech=general` `domain=api` `severity=low` `validated=2026-05-27`
> **tags** `api`

Reference body.
""".strip()
    )

    assert len(result.documents) == 1
    assert len(result.issues) == 1
    assert result.issues[0].title == "Missing tags"
    assert result.issues[0].message == "meta 后缺少 tags 行"


def test_repository_corpus_converts_with_explicit_diagnostics() -> None:
    documents = []
    issues = []
    for path in sorted(SOURCE_ROOT.glob("*.md")):
        source_path = path.relative_to(ROOT).as_posix()
        result = convert(path.read_text(encoding="utf-8"), source_path)
        documents.extend(result.documents)
        issues.extend(result.issues)

    assert len(documents) == 89
    assert len({document.file_id for document in documents}) == 89
    assert issues == []
