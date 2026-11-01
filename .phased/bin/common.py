"""Shared helpers for the phased workflow locks.

Everything here reads files from the project only. Nothing honours environment
variable overrides, on purpose: an override would be an easy way around the locks.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

PHASED_DIR = ".phased"
CONFIG = ".phased/config.json"
STATE = ".phased/state.json"
LOCK = ".phased/tests.lock.json"
ALLOWLIST = ".phased/cheat-allowlist.json"
PROGRESS = "PROGRESS.md"

# Agent names as Claude Code reports them: plain when installed as personal agents,
# "waddaya-dev:<name>" from the waddaya marketplace plugin ("phased:<name>" before 2.0).
DEFAULT_WRITERS = ["test-writer", "waddaya-dev:test-writer", "phased:test-writer"]
DEFAULT_REVIEWERS = ["test-reviewer", "waddaya-dev:test-reviewer", "phased:test-reviewer"]
DEFAULT_KBA_WRITERS = ["kba-writer", "waddaya-dev:kba-writer"]
# Human-facing documents of a change (report, knowledge base article). They may be committed
# alone, after the last phase, as "Phase 00: docs <change>".
CHANGE_DOC_GLOBS = ["changes/*/report.md", "changes/*/kba/**"]
# Files that may be committed alone as a "Phase 00: guardrails ..." change at any time.
INFRA_COMMIT_EXTRA = [".gitignore", "CLAUDE.md"]

# Files only a human may change once the project is initialised.
INFRA_GLOBS = [
    ".phased/**",
    ".githooks/**",
    ".github/workflows/phased-ci.yml",
    ".github/CODEOWNERS",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/agents/**",
    ".claude/skills/**",
    ".git/**",
    PROGRESS,
]

ATTRIBUTION_PATTERNS = [
    r"co-authored-by:.*(claude|anthropic)",
    r"noreply@anthropic\.com",
    r"generated (with|by) \[?claude",
    r"claude-session:",
    r"claude\.ai/code/session",
    r"\U0001F916\s*generated",
]


class PhasedError(Exception):
    pass


# ---------------------------------------------------------------- paths

def find_root(start=None):
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env and Path(env, PHASED_DIR).is_dir():
        return Path(env).resolve()
    here = Path(start or os.getcwd()).resolve()
    try:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=here,
                             capture_output=True, text=True, timeout=20)
        if top.returncode == 0 and top.stdout.strip():
            return Path(top.stdout.strip()).resolve()
    except Exception:
        pass
    return here


def rel(path, root, cwd=None):
    """Repo-relative POSIX path, or None when the path is outside the repo."""
    if path is None or path == "":
        return None
    p = Path(os.path.expanduser(str(path)))
    if not p.is_absolute():
        p = Path(cwd or root) / p
    try:
        p = Path(os.path.normpath(str(p)))
        r = p.relative_to(Path(root))
    except ValueError:
        return None
    s = r.as_posix()
    return "" if s == "." else s


def glob_to_regex(pattern):
    i, out = 0, "^"
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif c == "*":
            out += "[^/]*"
            i += 1
        elif c == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(c)
            i += 1
    return re.compile(out + "$")


_GLOB_CACHE = {}


def matches(path, globs):
    if path is None:
        return False
    for g in globs:
        rx = _GLOB_CACHE.get(g)
        if rx is None:
            rx = _GLOB_CACHE[g] = glob_to_regex(g)
        if rx.match(path):
            return True
    return False


def literal_prefix(glob):
    """'tests/unit/**' -> 'tests/unit'. '' when the glob starts with a wildcard."""
    parts = []
    for seg in glob.split("/"):
        if any(ch in seg for ch in "*?["):
            break
        parts.append(seg)
    return "/".join(parts)


def covers(path, globs):
    """True when `path` is a directory that contains (or is) something the globs protect."""
    if path is None:
        return False
    if matches(path, globs):
        return True
    p = path.rstrip("/")
    if p in ("", "."):
        return True
    for g in globs:
        pre = literal_prefix(g)
        if pre and (pre == p or pre.startswith(p + "/")):
            return True
    return False


# ---------------------------------------------------------------- files

def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False)
        f.write("\n")
    os.replace(tmp, path)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_config(root):
    cfg = read_json(Path(root, CONFIG))
    if cfg is None:
        return None
    for c in cfg.get("components", []):
        c.setdefault("test_globs", [])
        c.setdefault("test_config_globs", [])
        c.setdefault("source_globs", [])
        c.setdefault("manifest_files", [])
    return cfg


def load_state(root):
    return read_json(Path(root, STATE), {
        "initialized": False, "self_test_passed": False,
        "phase": None, "title": None, "stage": None, "history": []})


def save_state(root, state):
    write_json(Path(root, STATE), state)


# ---------------------------------------------------------------- config views

def test_globs(cfg):
    out = []
    for c in cfg.get("components", []):
        out += c.get("test_globs", []) + c.get("test_config_globs", [])
        if c.get("holdout_dir"):
            out.append(c["holdout_dir"].rstrip("/") + "/**")
    return out


def holdout_globs(cfg):
    return [c["holdout_dir"].rstrip("/") + "/**"
            for c in cfg.get("components", []) if c.get("holdout_dir")]


def source_globs(cfg):
    out = []
    for c in cfg.get("components", []):
        out += c.get("source_globs", [])
    return out


def is_test(path, cfg):
    return matches(path, test_globs(cfg))


def is_infra(path):
    return matches(path, INFRA_GLOBS)


def is_change_doc(path):
    return matches(path, CHANGE_DOC_GLOBS)


def is_spec(path):
    return path is not None and (path == "specs" or path.startswith("specs/"))


def component_for(path, cfg):
    best = None
    for c in cfg.get("components", []):
        root = c.get("root", ".").strip("/")
        if root in ("", "."):
            if best is None:
                best = c
        elif path == root or path.startswith(root + "/"):
            if best is None or len(root) > len(best.get("root", "").strip("/")):
                best = c
    return best


# ---------------------------------------------------------------- git / processes

def git(root, *args, check=False):
    r = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise PhasedError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def tracked_and_untracked(root):
    r = git(root, "ls-files", "-co", "--exclude-standard", "-z")
    return [p for p in r.stdout.split("\0") if p]


def run_shell(cmd, cwd, timeout=1800):
    """Run a configured command. Returns (exit_code, combined_output)."""
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, executable="/bin/bash" if os.name != "nt" else None)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, out + f"\n[phased] command timed out after {timeout}s"


def first_match(patterns, text):
    for p in patterns:
        m = re.search(p, text, flags=re.MULTILINE)
        if m:
            return p, m.group(0)
    return None


def attribution_hits(message):
    hits = []
    for p in ATTRIBUTION_PATTERNS:
        for m in re.finditer(p, message, flags=re.IGNORECASE):
            hits.append(m.group(0))
    return hits


def say(msg, stream=sys.stdout):
    print(msg, file=stream, flush=True)
