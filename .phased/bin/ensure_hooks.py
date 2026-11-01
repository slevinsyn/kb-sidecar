#!/usr/bin/env python3
"""SessionStart hook: make sure this clone uses the project's git hooks.

core.hooksPath is a local git setting, so a teammate's fresh clone does not have it.
This turns it on at the start of every Claude Code session in the project.
"""
import subprocess
import sys
sys.dont_write_bytecode = True
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def main():
    try:
        sys.stdin.read()
    except Exception:
        pass
    root = C.find_root()
    if not Path(root, ".githooks", "pre-commit").is_file():
        return 0
    cur = C.git(root, "config", "core.hooksPath").stdout.strip()
    if cur != ".githooks":
        subprocess.run(["git", "config", "core.hooksPath", ".githooks"], cwd=root, capture_output=True)
        print("phased: turned on this project's git hooks for this clone (core.hooksPath=.githooks).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
