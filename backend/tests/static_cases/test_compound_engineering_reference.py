import json
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CATALOG_PATH = REPOSITORY_ROOT / "schemas" / "examples" / "compound-engineering" / "catalog.json"
ALLOWED_SOURCE_ROOT = (
    REPOSITORY_ROOT / "compound-engineering" / "references" / "experiences"
).resolve()


def test_compound_engineering_catalog_points_to_existing_cases() -> None:
    """静态案例目录中的每个来源文件和标题都必须真实存在。"""

    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    index_path = REPOSITORY_ROOT / catalog["index"]
    assert index_path.is_file()

    case_ids = [case["id"] for case in catalog["cases"]]
    assert len(case_ids) == len(set(case_ids))

    for case in catalog["cases"]:
        source_path = (REPOSITORY_ROOT / case["source"]).resolve()
        assert source_path.is_relative_to(ALLOWED_SOURCE_ROOT)
        assert source_path.is_file()

        source_text = source_path.read_text(encoding="utf-8")
        assert f"# {case['heading']}" in source_text
        assert case["domain"]
        assert case["tags"]
        assert case["target_mapping"]
