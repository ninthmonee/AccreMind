"""Submit only an explicitly prepared payload; never read transcripts or infer a conclusion."""

import json
import os
import subprocess
import sys
from pathlib import Path


def main():
    event = json.loads(sys.stdin.read(64_000))
    if event.get("stop_hook_active"):
        return
    cwd = Path(event["cwd"])
    folder = cwd / ".accremind"
    payload = folder / "task-complete.json"
    if folder.is_symlink() or payload.is_symlink() or not payload.is_file():
        return
    if not os.environ.get("ACCREMIND_TOKEN"):
        print(
            "AccreMind: ACCREMIND_TOKEN is not configured; completion was not submitted.",
            file=sys.stderr,
        )
        return
    result = subprocess.run(
        ["accremind", "complete", str(payload)], capture_output=True, text=True, timeout=40
    )
    if result.returncode:
        print(
            "AccreMind: completion submission failed; rerun accremind complete manually.",
            file=sys.stderr,
        )
    else:
        # Replaying a retained payload is safe because task_complete requires an idempotency key.
        print("AccreMind: task completion accepted.", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(
            "AccreMind: hook could not submit completion; inspect the prepared payload.",
            file=sys.stderr,
        )
