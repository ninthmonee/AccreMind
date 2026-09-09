import json
from pathlib import Path

from accremind_api.main import create_app

ROOT = Path(__file__).resolve().parents[1]
OPENAPI_PATH = ROOT / "schemas" / "openapi" / "accremind.openapi.json"


def main() -> None:
    OPENAPI_PATH.parent.mkdir(parents=True, exist_ok=True)
    OPENAPI_PATH.write_text(json.dumps(create_app().openapi(), ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
