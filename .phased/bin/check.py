#!/usr/bin/env python3
"""The gate. Used by the git pre-commit hook, by CI, and by agents to check work early.

  check.py run                 run tests (twice), hidden tests, lint, type checks
  check.py pre-commit          everything in 'run' + lock check + cheat scan on staged changes
  check.py ci --base REF       everything in 'pre-commit' for REF...HEAD + commit message
                               checks + guardrail-change check
"""
import os
import re
import sys
sys.dont_write_bytecode = True
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import lock as L  # noqa: E402

MACHINE_WRITTEN = [".phased/state.json", ".phased/tests.lock.json", ".phased/evidence/**", ".phased/pending/**", C.PROGRESS]


class Report:
    def __init__(self):
        self.rows = []

    def add(self, name, ok, detail=""):
        self.rows.append((name, ok, detail))
        mark = "PASS" if ok is True else ("SKIP" if ok is None else "FAIL")
        C.say(f"[{mark}] {name}" + (f" - {detail}" if detail else ""))

    @property
    def ok(self):
        return all(r[1] is not False for r in self.rows)


def comp_dir(root, comp):
    r = comp.get("root", ".")
    return Path(root) if r in ("", ".") else Path(root, r)


def holdout_has_files(root, comp):
    h = comp.get("holdout_dir")
    if not h or not Path(root, h).is_dir():
        return False
    return any(p.is_file() and not p.name.startswith(".") and "__pycache__" not in p.parts
               and p.suffix not in (".pyc", ".pyo") for p in Path(root, h).rglob("*"))


def tail(text, n=80):
    lines = text.rstrip().splitlines()
    return "\n".join(lines[-n:])


def run_tests(root, cfg, include_holdout=True, runs=1, hide_holdout=True, baseline=False):
    """Returns (all_ok, printable_output, results)."""
    results, out, all_ok = [], [], True
    for comp in cfg.get("components", []):
        name = comp.get("name", comp.get("root", "."))
        cmd = comp.get("test_command") or ""
        if not cmd:
            if comp.get("allow_no_local_tests"):
                out.append(f"== {name}: no local test command (allowed by user at init)")
                continue
            results.append({"component": comp, "code": 1, "output": "no test_command configured", "no_tests": False})
            all_ok = False
            continue
        codes = []
        for i in range(max(1, runs)):
            code, text = C.run_shell(cmd, comp_dir(root, comp))
            no_tests = (code in comp.get("no_tests_exit_codes", [])) or bool(
                C.first_match(comp.get("no_tests_patterns", []), text))
            if no_tests and baseline:
                code = 0
            codes.append(code)
            results.append({"component": comp, "code": code, "output": text, "no_tests": no_tests, "run": i + 1})
            out.append(f"== {name} (run {i + 1}): {cmd} -> exit {code}\n{tail(text)}")
            if no_tests and not baseline:
                all_ok = False
        if any(c != 0 for c in codes):
            all_ok = False
        if len(set(codes)) > 1:
            out.append(f"== {name}: FLAKY - results differ between runs ({codes})")
            all_ok = False
        if include_holdout and comp.get("holdout_command") and holdout_has_files(root, comp):
            hcmd = comp["holdout_command"].replace("{holdout}", comp["holdout_dir"])
            code, text = C.run_shell(hcmd, Path(root))
            shown = [l for l in text.splitlines() if re.search(r"\b\d+\s+(passed|failed|errors?|tests?)\b", l)]
            summary = (shown[-1] if shown else f"exit {code}")[:200]
            results.append({"component": comp, "code": code, "output": text if not hide_holdout else summary,
                            "raw": text, "no_tests": False, "holdout": True})
            out.append(f"== {name} hidden tests -> exit {code}: {summary} (details hidden)")
            if code != 0:
                all_ok = False
    return all_ok, "\n".join(out), results


def run_static(root, cfg, report):
    for comp in cfg.get("components", []):
        for key, label in (("lint_command", "lint"), ("typecheck_command", "type check")):
            cmd = comp.get(key)
            if not cmd:
                continue
            code, text = C.run_shell(cmd, comp_dir(root, comp))
            report.add(f"{label} ({comp.get('name')})", code == 0, "" if code == 0 else "\n" + tail(text, 40))


def added_lines(diff_text):
    path = None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            p = line[4:].strip()
            path = None if p == "/dev/null" else (p[2:] if p.startswith("b/") else p)
        elif line.startswith("+") and not line.startswith("+++") and path:
            yield path, line[1:]


def cheat_scan(root, cfg, diff_text):
    allow = C.read_json(Path(root, C.ALLOWLIST), {"allow": []}).get("allow", [])
    hits = []
    tglobs = C.test_globs(cfg)
    for path, text in added_lines(diff_text):
        if os.path.basename(path) in (".gitignore", ".dockerignore", ".eslintignore", ".prettierignore"):
            pat = text.strip().lstrip("/")
            benign = re.search(r"(?i)pytest_cache|__pycache__|coverage|test-results|playwright-report|\.nyc_output", pat)
            if pat and not pat.startswith("#") and not benign and (re.search(r"(?i)test|spec|holdout|conftest", pat)
                                                     or C.matches(pat, tglobs)):
                hits.append(f"{path}: '{pat}' would hide test files from the lock")
            continue
        if C.is_infra(path) or path.endswith((".md", ".txt", ".rst")):
            continue
        comp = C.component_for(path, cfg)
        if not comp:
            continue
        patterns = []
        in_code = C.matches(path, comp.get("source_globs", []) + comp.get("test_globs", [])) or \
            (comp.get("holdout_dir") and path.startswith(comp["holdout_dir"].rstrip("/") + "/"))
        if in_code:
            patterns += comp.get("skip_patterns", []) + comp.get("suppression_patterns", [])
        is_cfg = C.matches(path, comp.get("test_config_globs", [])) or \
            os.path.basename(path) in comp.get("manifest_files", []) or path.startswith(".github/workflows/")
        if is_cfg:
            patterns += comp.get("config_skip_patterns", []) + comp.get("skip_patterns", [])
        for p in patterns:
            if re.search(p, text):
                if any(C.matches(path, [a.get("path", "**")]) and a.get("contains", "\0") in text for a in allow):
                    continue
                hits.append(f"{path}: '{text.strip()[:100]}' (rule: {p})")
                break
    return hits


def message_checks(root, rng):
    r = C.git(root, "log", "--format=%H%x1f%P%x1f%B%x1e", rng)
    problems = []
    for rec in r.stdout.split("\x1e"):
        rec = rec.strip()
        if not rec:
            continue
        sha, parents, body = (rec.split("\x1f") + ["", ""])[:3]
        hits = C.attribution_hits(body)
        if hits:
            problems.append(f"{sha[:10]} has AI attribution: {hits[0]!r}")
        if len(parents.split()) < 2 and not re.match(r"^Phase \d{2}: \S", body):
            problems.append(f"{sha[:10]} message does not start with 'Phase NN: ': {body.splitlines()[0][:60]!r}")
    return problems


def gate(mode, base=None):
    root = C.find_root()
    cfg = C.load_config(root)
    if cfg is None:
        C.say("phased: not initialised; gate skipped.")
        return 0
    state = C.load_state(root)
    report = Report()
    C.say(f"phased gate ({mode}) - phase {state.get('phase') or '00'}, stage {state.get('stage') or 'setup'}")

    if mode in ("pre-commit", "ci"):
        report.add("initialised and self-test passed", bool(state.get("initialized") and state.get("self_test_passed")),
                   "" if state.get("self_test_passed") else "run /build (it sets the project up)")
    if mode == "pre-commit":
        staged = C.git(root, "diff", "--cached", "--name-only").stdout.split()
        infra_only = bool(staged) and all(C.is_infra(f) or f in C.INFRA_COMMIT_EXTRA or C.is_change_doc(f) for f in staged)
        stage_ok = state.get("phase") is None or state.get("stage") == "implementing" or infra_only
        report.add("phase stage allows a commit", stage_ok,
                   "" if stage_ok else f"stage is '{state.get('stage')}'; commits happen only in 'implementing' "
                                       "(after 'phase.py red'), or as a 'Phase 00:' guardrails- or docs-only commit")
        unstaged = C.git(root, "diff", "--name-only").stdout.split()
        report.add("everything staged (tests run on exactly what is committed)", not unstaged,
                   "" if not unstaged else "unstaged: " + ", ".join(unstaged[:5]) + " - run 'git add -A'")

    if mode in ("pre-commit", "ci"):
        d = L.diff(root, cfg)
        bad = d["unlocked"] + d["changed"] + d["deleted"]
        report.add("test files match their locked fingerprints", not bad,
                   "" if not bad else "; ".join(f"{k}: {', '.join(v[:4])}" for k, v in d.items() if v))
        if mode == "pre-commit":
            diff_text = C.git(root, "diff", "--cached", "-U0", "--no-color").stdout
        else:
            diff_text = C.git(root, "diff", "-U0", "--no-color", f"{base}...HEAD").stdout
        hits = cheat_scan(root, cfg, diff_text)
        report.add("no skipped tests / suppressions / test-config tricks added", not hits,
                   "" if not hits else "\n  " + "\n  ".join(hits[:15]) +
                   "\n  (if one is genuinely needed, the user can allow it in .phased/cheat-allowlist.json)")

    if mode == "ci":
        probs = message_checks(root, f"{base}..HEAD")
        report.add("commit messages: 'Phase NN:' format, no AI attribution", not probs, "\n  " + "\n  ".join(probs[:10]) if probs else "")
        changed = C.git(root, "diff", "--name-only", f"{base}...HEAD").stdout.split()
        infra = [f for f in changed if C.is_infra(f) and not C.matches(f, MACHINE_WRITTEN)]
        approved = os.environ.get("PHASED_INFRA_APPROVED", "").lower() == "true"
        # First-time setup: the base branch has no guardrails yet, so there is nothing to weaken.
        first_setup = C.git(root, "cat-file", "-e", f"{base}:.phased/config.json").returncode != 0
        why = "approved: " if approved else ("first-time setup: " if first_setup else "changed: ")
        report.add("guardrail files unchanged (first-time setup, or 'phased-infra-approved' label)",
                   not infra or approved or first_setup, "" if not infra else why + ", ".join(infra[:8]))

    baseline = state.get("phase") is None
    runs = int(cfg.get("runs_per_gate", 2))
    ok, output, results = run_tests(root, cfg, include_holdout=True, runs=runs, hide_holdout=True, baseline=baseline)
    report.add(f"tests pass {runs}x in a row (+ hidden tests)", ok, "" if ok else "\n" + output)
    run_static(root, cfg, report)

    if mode == "run" and state.get("phase") and state.get("stage") == "implementing":
        # Factual attempt log: the implementer cites it in the commit's 'Challenges:' section.
        import datetime as _dt
        log = Path(root, f".phased/evidence/phase-{state['phase']}-gate.log")
        log.parent.mkdir(parents=True, exist_ok=True)
        failed = [r[0] + (": " + r[2].strip().splitlines()[-1][:160] if r[2].strip() else "")
                  for r in report.rows if r[1] is False]
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{_dt.datetime.now().isoformat(timespec='seconds')} "
                    f"{'PASS' if report.ok else 'FAIL'}{' - ' + ' | '.join(failed) if failed else ''}\n")
    C.say("GATE PASSED" if report.ok else "GATE FAILED - nothing was committed. Fix the code (not the tests) and retry.")
    return 0 if report.ok else 1


def main(argv):
    mode = argv[1] if len(argv) > 1 else "run"
    if mode not in ("run", "pre-commit", "ci"):
        C.say(__doc__)
        return 2
    base = None
    if mode == "ci":
        base = argv[argv.index("--base") + 1] if "--base" in argv else "origin/main"
    return gate(mode, base)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
