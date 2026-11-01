#!/usr/bin/env python3
"""Test lock: fingerprints (SHA-256) of every approved test file.

  status   show locked / unlocked / changed / deleted test files
  verify   exit 1 if any test file is unlocked, changed or deleted
  autolock run by the SubagentStop hook when test-writer finishes (not for agents)
  relock   re-approve changed test files; run it only with the user's approval
"""
import json
import sys
sys.dont_write_bytecode = True
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def load_lock(root):
    return C.read_json(Path(root, C.LOCK), {"files": {}})


def save_lock(root, lock):
    C.write_json(Path(root, C.LOCK), lock)


def current_test_files(root, cfg):
    """Every test file on disk, including git-ignored ones (an ignored conftest.py or
    setup file would still be loaded by the test runner)."""
    globs = C.test_globs(cfg)
    files = set(f for f in C.tracked_and_untracked(root)
                if C.matches(f, globs) and Path(root, f).is_file())
    ign = C.git(root, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z").stdout
    for e in (x for x in ign.split("\0") if x):
        if e.endswith("/"):
            if C.matches(e + "__probe__", globs) and Path(root, e).is_dir():
                files.update(p.relative_to(root).as_posix() for p in Path(root, e).rglob("*")
                             if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
        elif C.matches(e, globs) and Path(root, e).is_file() and "__pycache__" not in e and not e.endswith(".pyc"):
            files.add(e)
    return sorted(f for f in files if not f.endswith((".gitkeep", ".keep")) and not f.startswith(".phased/"))


def diff(root, cfg, lock=None):
    lock = lock or load_lock(root)
    files = lock.get("files", {})
    now = current_test_files(root, cfg)
    unlocked, changed = [], []
    for f in now:
        if f not in files:
            unlocked.append(f)
        elif C.sha256_file(Path(root, f)) != files[f]["sha256"]:
            changed.append(f)
    deleted = sorted(f for f in files if not Path(root, f).is_file())
    return {"unlocked": unlocked, "changed": changed, "deleted": deleted}


def digest(root, phase):
    import hashlib
    files = load_lock(root).get("files", {})
    h = hashlib.sha256()
    for f in sorted(files):
        if files[f].get("phase") == phase:
            h.update(f"{f}:{files[f]['sha256']}\n".encode())
    return h.hexdigest()


def phase_files(root, phase):
    return sorted(f for f, v in load_lock(root).get("files", {}).items() if v.get("phase") == phase)


def autolock(root):
    """Lock new/changed tests into the current phase. Only works in the 'tests' stage."""
    cfg, state = C.load_config(root), C.load_state(root)
    if not cfg or state.get("stage") != "tests" or not state.get("phase"):
        return 0, "not in tests stage; nothing locked"
    phase = state["phase"]
    lock = load_lock(root)
    d = diff(root, cfg, lock)
    refused = []
    for f in d["unlocked"] + d["changed"]:
        owner = lock["files"].get(f, {}).get("phase")
        if owner and owner != phase:
            refused.append(f)  # belongs to an earlier phase: needs the user's relock
            continue
        lock["files"][f] = {"sha256": C.sha256_file(Path(root, f)), "phase": phase}
    for f in d["deleted"]:
        if lock["files"][f].get("phase") == phase:
            del lock["files"][f]
        else:
            refused.append(f)
    save_lock(root, lock)
    msg = f"locked {len(phase_files(root, phase))} test file(s) for phase {phase}"
    if refused:
        msg += f"; NOT locked (earlier phase, needs user relock): {', '.join(refused)}"
    return 0, msg


def relock(root, phase, paths):
    cfg = C.load_config(root)
    lock = load_lock(root)
    d = diff(root, cfg, lock)
    targets = paths or (d["unlocked"] + d["changed"] + d["deleted"])
    for f in targets:
        if Path(root, f).is_file():
            lock["files"][f] = {"sha256": C.sha256_file(Path(root, f)), "phase": phase or lock["files"].get(f, {}).get("phase")}
        else:
            lock["files"].pop(f, None)
    save_lock(root, lock)
    return targets


def main(argv):
    root = C.find_root()
    cfg = C.load_config(root)
    if cfg is None:
        C.say("phased: not initialised (run /build, it sets the project up).", sys.stderr)
        return 2
    cmd = argv[1] if len(argv) > 1 else "status"
    if cmd in ("status", "verify"):
        d = diff(root, cfg)
        total = len(load_lock(root).get("files", {}))
        C.say(f"locked test files: {total}")
        for k in ("unlocked", "changed", "deleted"):
            if d[k]:
                C.say(f"{k}: " + ", ".join(d[k]))
        bad = d["unlocked"] or d["changed"] or d["deleted"]
        if cmd == "verify":
            C.say("LOCK OK" if not bad else "LOCK BROKEN")
            return 1 if bad else 0
        return 0
    if cmd == "autolock":
        if "--from-hook" in argv:
            try:
                json.load(sys.stdin)
            except Exception:
                pass
        code, msg = autolock(root)
        C.say(f"phased: {msg}", sys.stderr)
        return code
    if cmd == "relock":
        phase = None
        paths = []
        args = argv[2:]
        i = 0
        while i < len(args):
            if args[i] == "--phase" and i + 1 < len(args):
                phase = args[i + 1].zfill(2)
                i += 2
                continue
            paths.append(args[i])
            i += 1
        state = C.load_state(root)
        phase = phase or state.get("phase")
        done = relock(root, phase, paths)
        C.say(f"relocked into phase {phase}: " + (", ".join(done) or "nothing to relock"))
        st = C.load_state(root)
        st.setdefault("history", []).append({"event": "relock", "phase": phase, "files": done})
        C.save_state(root, st)
        return 0
    C.say(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
