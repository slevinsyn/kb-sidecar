#!/usr/bin/env python3
"""git commit-msg hook: no AI attribution, and 'Phase NN: title' format.

  msgcheck.py <message-file>
"""
import re
import sys
sys.dont_write_bytecode = True
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def check(root, message):
    body = "\n".join(l for l in message.splitlines() if not l.startswith("#")).strip()
    problems = []
    hits = C.attribution_hits(body)
    if hits:
        problems.append("AI attribution is not allowed in commit messages (found: "
                        + ", ".join(repr(h) for h in hits[:3]) + "). Remove those lines.")
    cfg = C.load_config(root)
    if cfg and cfg.get("enforce_phase_messages", True):
        merging = Path(root, ".git", "MERGE_HEAD").exists()
        state = C.load_state(root)
        staged = C.git(root, "diff", "--cached", "--name-only").stdout.split()
        infra_only = bool(staged) and all(C.is_infra(f) or f in C.INFRA_COMMIT_EXTRA or C.is_change_doc(f) for f in staged)
        expected = "00" if infra_only else (state.get("phase") or "00")
        m = re.match(r"^Phase (\d{2}): \S", body)
        if not merging:
            if not m:
                problems.append(f"The first line must be 'Phase {expected}: <title>'.")
            elif m.group(1) != expected:
                problems.append(f"This commit belongs to phase {expected}, not {m.group(1)}.")
            elif m.group(1) != "00" and cfg.get("require_challenges", True):
                sec = re.search(r"^Challenges:[ \t]*(.*)$", body, flags=re.M | re.I)
                rest = body[sec.end():] if sec else ""
                bullets = re.findall(r"^\s*[-*]\s+\S.{9,}", rest, flags=re.M)
                inline = sec.group(1).strip().lower() if sec else ""
                if not sec:
                    problems.append("Phase commits need a 'Challenges:' section: one bullet per real problem met "
                                    "in this phase and how it was solved, or 'Challenges: none'.")
                elif not bullets and inline not in ("none", "none.", "no challenges", "no challenges."):
                    problems.append("'Challenges:' needs at least one '- <problem> -> <how it was solved>' "
                                    "bullet, or the word 'none'.")
    return problems


def main(argv):
    if len(argv) < 2:
        C.say(__doc__)
        return 2
    root = C.find_root()
    message = Path(argv[1]).read_text(encoding="utf-8", errors="replace")
    problems = check(root, message)
    for p in problems:
        C.say(f"commit-msg: {p}", sys.stderr)
    if problems:
        C.say("commit-msg: commit rejected.", sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
