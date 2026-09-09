import json
from pathlib import Path

from accremind_contracts import (
    Experience,
    ExperienceFeedbackRequest,
    ExperiencePack,
    ExperienceSubmitRequest,
    ExperienceSubmitResult,
    ExperienceVersion,
    RecallRequest,
    StaticExperienceDocument,
    TaskCompleteRequest,
    TaskCompleteResult,
)
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "schemas" / "json-schema"

SCHEMAS: dict[str, type[BaseModel]] = {
    "experience": Experience,
    "experience-version": ExperienceVersion,
    "experience-recall-input": RecallRequest,
    "experience-recall-output": ExperiencePack,
    "experience-submit-input": ExperienceSubmitRequest,
    "experience-submit-output": ExperienceSubmitResult,
    "experience-feedback-input": ExperienceFeedbackRequest,
    "task-complete-input": TaskCompleteRequest,
    "task-complete-output": TaskCompleteResult,
    "static-experience-document": StaticExperienceDocument,
}


def main() -> None:
    SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    expected_paths = set()
    for name, model in sorted(SCHEMAS.items()):
        path = SCHEMA_DIR / f"{name}.schema.json"
        expected_paths.add(path)
        payload = model.model_json_schema(mode="validation")
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    for path in SCHEMA_DIR.glob("*.schema.json"):
        if path not in expected_paths:
            path.unlink()


if __name__ == "__main__":
    main()
