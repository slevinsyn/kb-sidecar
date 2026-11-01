#!/usr/bin/env python3
"""Phase state machine: spec -> tests -> implementing -> done.

  status                    where are we, what is next
  route                     model + effort for this phase's agents (from the spec's Complexity)
  brief                     short briefing re-added to context after compaction (hook)
  plan --change DIR         start planning a change (changes/<date>-<slug>): write change.md and
                            ALL phase specs at once (stage: planning)
  estimate                  the approval table: phases, agents at once, models, time, risk, warnings
  approve-plan              user approves change.md + every spec in one go    (asks the user)
  prefetch                  after approve-plan: test-writers for ALL phases work in parallel (stage: prefetch)
  prefetch-done             stage reviewed tests per phase; they move in when the phase starts
  start NN "title"          begin the next approved phase (stage: tests); moves in and locks
                            prefetched tests; prints the model/effort route
  approve-spec              only after 'reopen --to spec': re-approve that spec (asks the user)
  red                       run tests, prove they fail for the right reason -> stage: implementing
  review-prep               self review: write this round's diff for the code-reviewer (max 3 rounds)
  review-done --verdict PASS|FAIL [--important N --nits N --preexisting N --classes "a; b"]
  finish                    after the "Phase NN:" commit -> stage: done (records how long it took)
  risk                      final risk level (change.md + changed paths) and approvals needed
  report                    end-of-run table -> changes/<change>/report.md
  kba-facts                 facts for the kba-writer -> changes/<change>/kba/facts.json
  reopen --to spec|tests    go back a stage                           (asks the user)
  retest --reason "..."     main session only: reopen THIS phase's tests once, without asking,
                            when the implementer and a fresh test-reviewer agree a locked test
                            contradicts the spec (limit: auto_retest_limit, default 1)
  hook-review               SubagentStop hook for test-reviewer (not for agents)
  review-verdict --agent-id ID   fallback: read a test-reviewer's verdict from its own transcript
                            (only ids the hook recorded; for when the hook got no message)
"""
import datetime as dt
import json
import os
import re
import sys
import time
sys.dont_write_bytecode = True
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import lock as L  # noqa: E402

REQUIRED_SPEC_SECTIONS = ["## Intent", "## Complexity", "## Interface contract", "## Acceptance criteria"]
LEVELS = ["S", "M", "L"]
DEFAULT_ROUTING = {
    "S": {"implementer": ["sonnet", "medium"], "test-writer": ["sonnet", "medium"], "test-reviewer": ["sonnet", "medium"],
          "code-reviewer": ["sonnet", "medium"]},
    "M": {"implementer": ["sonnet", "high"], "test-writer": ["sonnet", "high"], "test-reviewer": ["sonnet", "high"],
          "code-reviewer": ["sonnet", "high"]},
    "L": {"implementer": ["opus", "high"], "test-writer": ["opus", "high"], "test-reviewer": ["opus", "high"],
          "code-reviewer": ["opus", "high"]},
    "escalate": {"implementer": ["opus", "xhigh"]},
}
KBA_ROUTE = {"model": "sonnet", "effort": "medium"}
DEFAULT_MINUTES = {"S": 8, "M": 15, "L": 30}   # first-run guess per phase, replaced by real timings
TEST_WAVE_MINUTES = 6
LEVEL_WORDS = {"S": "small", "M": "medium", "L": "large"}
APPROVALS = {"Low": "no human approval once every check passes", "Medium": "1 person approves the merge",
             "High": "2 people approve the merge"}
DEFAULT_HIGH_RISK_PATHS = ["**/auth/**", "**/*auth*", "**/*login*", "**/*password*", "**/*billing*", "**/*payment*",
                           "**/*secret*", "**/*security*", "**/migrations/**", ".github/workflows/**",
                           "**/*install*", ".github/CODEOWNERS"]


def spec_complexity(text):
    sec = text.split("## Complexity", 1)
    if len(sec) < 2:
        return None
    body = re.sub(r"<!--.*?-->", "", sec[1].split("\n## ", 1)[0], flags=re.S)
    m = re.search(r"\b([SML])\b", body)
    return m.group(1) if m else None


def route_for(cfg, level):
    routing = {**DEFAULT_ROUTING, **(cfg.get("routing") or {})}
    out = {k: {"model": v[0], "effort": v[1]} for k, v in routing.get(level, routing["M"]).items()}
    esc = routing.get("escalate", {}).get("implementer")
    if esc:
        out["implementer-escalated"] = {"model": esc[0], "effort": esc[1]}
    return out


def now():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def log(state, event, **kw):
    state.setdefault("history", []).append({"at": now(), "event": event, "phase": state.get("phase"), **kw})


def write_progress(root, state):
    rows = {}
    for h in state.get("history", []):
        ph = h.get("phase")
        if not ph:
            continue
        r = rows.setdefault(ph, {"title": "", "started": "", "spec": "", "tests": "", "red": "", "commit": "", "stage": ""})
        if h["event"] == "start":
            r["title"], r["started"] = h.get("title", ""), h["at"][:16]
        elif h["event"] == "approve-spec":
            r["spec"] = h["at"][:16]
        elif h["event"] == "red":
            r["tests"], r["red"] = str(h.get("tests", "")), h["at"][:16]
        elif h["event"] == "finish":
            r["commit"] = h.get("commit", "")[:10]
    for ph, r in rows.items():
        r["stage"] = state.get("stage") if ph == state.get("phase") else "done"
    lines = ["# Progress", "",
             "_Written by `.phased/bin/phase.py`. Do not edit by hand._", "",
             "| Phase | Title | Stage | Started | Spec approved | Locked test files | Red verified | Commit |",
             "|---|---|---|---|---|---|---|---|"]
    for ph in sorted(rows):
        r = rows[ph]
        lines.append(f"| {ph} | {r['title']} | {r['stage']} | {r['started']} | {r['spec']} | {r['tests']} | {r['red']} | {r['commit']} |")
    ev = Path(root, ".phased/evidence")
    if ev.is_dir() and any(ev.iterdir()):
        lines += ["", "Evidence of failing-first test runs is in `.phased/evidence/`."]
    Path(root, C.PROGRESS).write_text("\n".join(lines) + "\n", encoding="utf-8")


def require(cond, msg):
    if not cond:
        raise C.PhasedError(msg)


def cmd_status(root, cfg, state):
    C.say(f"phase: {state.get('phase') or '-'}  title: {state.get('title') or '-'}  stage: {state.get('stage') or '-'}")
    cur = int(state.get("phase") or 0)
    waiting = sorted(n for n in (state.get("approved_specs") or {}) if int(n) > cur)
    if state.get("stage") == "prefetch":
        pf = state.get("prefetch") or {}
        revs = prefetch_reviews(root)
        C.say("prefetch reviews: " + ", ".join(f"{n}={(revs.get(n) or {}).get('verdict', 'not run')}"
                                              for n in pf.get("phases", [])))
        C.say("next: finish parallel test-writers/reviewers, then: python3 .phased/bin/phase.py prefetch-done")
        return 0
    if waiting and state.get("stage") in (None, "done"):
        ready = sorted((state.get("pending_tests") or {}))
        C.say(f"plan: APPROVED and locked. Phases waiting: {', '.join(waiting)}"
              + (f". Prefetched tests ready for: {', '.join(ready)}" if ready else ""))
        if not ready and not state.get("phase"):
            C.say("next: python3 .phased/bin/phase.py prefetch   (write all phases' tests in parallel)")
            return 0
        C.say(f"next: python3 .phased/bin/phase.py start {waiting[0]}   (no further approval needed)")
        return 0
    nxt = {
        None: "plan a change: python3 .phased/bin/phase.py plan --change changes/<YYYY-MM-DD>-<slug>",
        "planning": "write change.md and specs/phase-NN.md for every phase, run phase.py estimate, show the table, then: python3 .phased/bin/phase.py approve-plan",
        "spec": "reopened by the user: fix specs/phase-NN.md with them, then: python3 .phased/bin/phase.py approve-spec",
        "tests": "create interface stubs, use test-writer then test-reviewer (models: phase.py route), then: python3 .phased/bin/phase.py red",
        "implementing": "implementer agent (phase.py route) until READY, then review-prep -> code-reviewer -> review-done; commit 'Phase NN:'; then: python3 .phased/bin/phase.py finish",
        "done": "start the next phase:  python3 .phased/bin/phase.py start NN \"title\"",
    }
    C.say("next: " + nxt.get(state.get("stage"), "?"))
    rv = state.get("review") or {}
    if state.get("stage") == "tests":
        C.say(f"test review: {rv.get('verdict', 'not run')}")
    return 0


def cmd_start(root, cfg, state, args):
    require(state.get("initialized") and state.get("self_test_passed"),
            "Not initialised: run /build (it sets the project up and self-tests) first.")
    require(state.get("stage") in (None, "done"),
            f"Phase {state.get('phase')} is still in stage '{state.get('stage')}'. Finish it first.")
    require(len(args) >= 1, 'usage: phase.py start NN ["title"]')
    nn = args[0].zfill(2)
    require(re.fullmatch(r"\d{2}", nn) and nn != "00", "Phase number must be 01-99.")
    prev = state.get("phase")
    expected = f"{int(prev) + 1:02d}" if prev else "01"
    require(nn == expected, f"Next phase must be {expected}.")
    spec = Path(root, f"specs/phase-{nn}.md")
    title = " ".join(args[1:]).strip()
    if not title and spec.exists():
        m = re.search(rf"^#\s*Phase\s+{nn}:\s*(.+)$", spec.read_text(encoding="utf-8"), flags=re.MULTILINE)
        title = m.group(1).strip() if m else ""
    require(title, 'usage: phase.py start NN "title"')
    pre = (state.get("approved_specs") or {}).get(nn)
    if pre:
        require(spec.exists() and C.sha256_file(spec) == pre,
                f"specs/phase-{nn}.md changed after the plan was approved. Ask the user to re-approve "
                "(phase.py plan, then approve-plan).")
        acs = validate_spec(spec, nn)
        state.update({"phase": nn, "title": title, "stage": "tests", "review": None, "red": None, "spec_sha256": pre})
        log(state, "start", title=title)
        log(state, "approve-spec", criteria=acs, preapproved=True)
        moved = move_in_prefetched(root, cfg, state, nn)
        level = spec_complexity(spec.read_text(encoding="utf-8")) or "M"
        C.say(f"Phase {nn} started with its pre-approved spec. Stage: tests.")
        if moved:
            C.say(f"Prefetched tests moved in and locked ({moved} file(s)); review PASS carried over. "
                  "Tests are READY: go straight to the implementer (it creates stubs, runs red, builds, commits, finishes).")
        else:
            C.say("No prefetched tests: use test-writer, then test-reviewer, then the implementer.")
        C.say("route: " + json.dumps({"complexity": level, **route_for(cfg, level)}))
        return 0
    require(False, f"Phase {nn} has no approved spec. Plan first: phase.py plan --change <dir>, write "
                   "change.md and the specs, then phase.py approve-plan.")
    return 1


def validate_spec(spec, nn):
    """Raise PhasedError if the spec is not ready. Returns its acceptance-criteria IDs."""
    require(spec.is_file(), f"{spec} is missing.")
    text = spec.read_text(encoding="utf-8")
    missing = [s for s in REQUIRED_SPEC_SECTIONS if s.lower() not in text.lower()]
    require(not missing, f"phase-{nn}.md is missing sections: " + ", ".join(missing))
    acs = re.findall(rf"\bAC-{nn}-\d{{2}}\b", text)
    require(acs, f"phase-{nn}.md has no acceptance criteria IDs like AC-{nn}-01.")
    require(spec_complexity(text) in LEVELS, f"phase-{nn}.md: '## Complexity' must start with S, M or L.")
    empty = re.findall(rf"^\s*[-*]\s*(AC-{nn}-\d{{2}}):\s*$", text, flags=re.MULTILINE)
    require(not empty, f"phase-{nn}.md has acceptance criteria without text: " + ", ".join(empty))
    contract = text.lower().split("## interface contract", 1)[1].split("\n## ", 1)[0]
    rows = [l for l in contract.splitlines() if l.strip().startswith("|") and "---" not in l
            and l.replace("|", "").strip() and not l.lower().startswith("| item")]
    require(rows, f"phase-{nn}.md: the Interface contract table is empty. The test-writer needs exact names.")
    require("{{" not in text and "TODO" not in text, f"phase-{nn}.md still has template placeholders or TODOs.")
    return sorted(set(acs))


def cmd_approve_spec(root, cfg, state):
    """Only after 'reopen --to spec': the user re-approves the corrected spec of this phase."""
    require(state.get("stage") == "spec", f"Stage is '{state.get('stage')}', not 'spec'.")
    nn = state["phase"]
    spec = Path(root, f"specs/phase-{nn}.md")
    acs = validate_spec(spec, nn)
    state["spec_sha256"] = C.sha256_file(spec)
    state["stage"] = "tests"
    log(state, "approve-spec", criteria=acs)
    C.say(f"Spec approved ({len(acs)} acceptance criteria). Stage: tests.")
    return 0


def pending_specs(root, state):
    done = int(state.get("phase") or 0) if state.get("stage") in (None, "done", "planning") else int(state["phase"]) - 1
    out = []
    for p in sorted(Path(root, "specs").glob("phase-*.md")):
        m = re.fullmatch(r"phase-(\d{2})\.md", p.name)
        if m and int(m.group(1)) > done:
            out.append((m.group(1), p))
    return out


def cmd_plan(root, cfg, state, args=()):
    require(state.get("initialized") and state.get("self_test_passed"),
            "Not initialised: run /build (it sets the project up and self-tests) first.")
    require(state.get("stage") in (None, "done", "planning"),
            f"Phase {state.get('phase')} is in stage '{state.get('stage')}'. Finish it first.")
    if "--change" in args and args.index("--change") + 1 < len(args):
        cdir = args[args.index("--change") + 1].strip().rstrip("/")
        require(re.fullmatch(r"changes/[A-Za-z0-9._-]+", cdir), "usage: phase.py plan --change changes/<YYYY-MM-DD>-<slug>")
        Path(root, cdir, "kba", "screenshots").mkdir(parents=True, exist_ok=True)
        state["change_dir"] = cdir
    require(state.get("change_dir"), "usage: phase.py plan --change changes/<YYYY-MM-DD>-<slug>")
    state["base_commit"] = C.git(root, "rev-parse", "HEAD").stdout.strip()
    state["stage"] = "planning"
    log(state, "plan", change=state["change_dir"])
    nxt = f"{int(state.get('phase') or 0) + 1:02d}"
    C.say(f"Planning {state['change_dir']}. Write {state['change_dir']}/change.md, then specs/phase-{nxt}.md, "
          f"specs/phase-{int(nxt) + 1:02d}.md, ... from .phased/templates/spec-template.md. Then: "
          "python3 .phased/bin/phase.py estimate (show its table), then: python3 .phased/bin/phase.py approve-plan")
    return 0


def cmd_approve_plan(root, cfg, state):
    require(state.get("stage") == "planning", f"Stage is '{state.get('stage')}', not 'planning'. Run 'phase.py plan' first.")
    specs = pending_specs(root, state)
    require(specs, "No new specs/phase-NN.md files found.")
    first = int(state.get("phase") or 0) + 1
    nums = [int(n) for n, _ in specs]
    require(nums == list(range(first, first + len(nums))), f"Specs must be numbered from {first:02d} with no gaps: {nums}")
    approved, total = {}, 0
    for nn, p in specs:
        total += len(validate_spec(p, nn))
        approved[nn] = C.sha256_file(p)
    cm = Path(root, state.get("change_dir") or "-", "change.md")
    require(cm.is_file(), f"{state.get('change_dir')}/change.md is missing. Write change.md first.")
    state["change_sha256"] = C.sha256_file(cm)
    state["approved_specs"] = {**(state.get("approved_specs") or {}), **approved}
    state["change_phases"] = sorted(approved)
    state["stage"] = "done" if state.get("phase") else None
    log(state, "approve-plan", phases=sorted(approved))
    levels = {nn: spec_complexity(p.read_text(encoding="utf-8")) for nn, p in specs}
    C.say(f"Plan approved: {len(approved)} phase spec(s), {total} acceptance criteria. Specs are now locked.")
    C.say("Complexity per phase: " + ", ".join(f"{nn}={lv}" for nn, lv in levels.items()))
    return 0


def cmd_red(root, cfg, state):
    import check as K
    require(state.get("stage") == "tests", f"Stage is '{state.get('stage')}', not 'tests'.")
    nn = state["phase"]
    files = L.phase_files(root, nn)
    require(files, "No test files are locked for this phase. Use the test-writer agent first.")
    d = L.diff(root, cfg)
    require(not (d["unlocked"] or d["changed"] or d["deleted"]),
            f"Test files are not all locked: {d}. Only test-writer may change tests (they lock when it finishes).")
    rv = state.get("review") or {}
    require(rv.get("verdict") == "PASS" and rv.get("lock_digest") == L.digest(root, nn),
            "The test-reviewer has not passed the current tests "
            f"(recorded: {rv.get('verdict') or 'nothing'}). Run the test-reviewer agent again; the last line "
            "of its reply must be 'VERDICT: PASS'. If it said PASS and this still shows NO VERDICT, run: "
            "python3 .phased/bin/phase.py review-verdict --agent-id <that reviewer's agent id> "
            f"(details: .phased/evidence/hook-payload.log, phase-{nn}-review-unparsed.log).")
    spec = Path(root, f"specs/phase-{nn}.md")
    require(state.get("spec_sha256") == C.sha256_file(spec), "The spec changed after approval. Ask the user to reopen.")
    ok, output, results = K.run_tests(root, cfg, include_holdout=True, runs=1, hide_holdout=True)
    evidence = Path(root, f".phased/evidence/phase-{nn}-red.log")
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(output[-60000:], encoding="utf-8")
    retested = state.get("red_after_retest") == nn
    require(not ok or retested, "All tests PASS before implementation. The new tests are too weak or already "
                                "satisfied. Send this back to test-writer.")
    if ok and retested:  # implementation already exists; red was proven for the first version of the tests
        with open(evidence, "a", encoding="utf-8") as f:
            f.write("\n[phased] Tests were rewritten after implementation began (retest); they pass already. "
                    "Red was proven for the first version of the tests.\n")
    wrong = []
    for r in results:
        hit = C.first_match(r["component"].get("wrong_reason_patterns", []), r.get("raw", r["output"]))
        if hit and r["code"] != 0:
            if r.get("holdout"):
                wrong.append(f"{r['component']['name']} hidden tests (details hidden; send back to test-writer "
                             "or check the stubs match the Interface contract)")
            else:
                wrong.append(f"{r['component']['name']}: {hit[1]}")
    require(not wrong, "Tests fail for the wrong reason (" + "; ".join(wrong) + "). "
                       "Create interface stubs from the spec's Interface contract so imports resolve, "
                       "then run red again. Do not change the tests.")
    no_tests = [r["component"]["name"] for r in results if r.get("no_tests")]
    require(not no_tests, f"No tests were collected in: {', '.join(no_tests)}.")
    state["red"] = {"ok": True, "lock_digest": L.digest(root, nn), "evidence": str(evidence.relative_to(root))}
    state.pop("red_after_retest", None)
    state["stage"] = "implementing"
    log(state, "red", tests=len(files))
    C.say(f"Red verified: tests fail for the right reason. Evidence: {evidence.relative_to(root)}. Stage: implementing.")
    return 0


def phase_started_at(state, nn):
    for h in reversed(state.get("history", [])):
        if h.get("event") == "start" and h.get("phase") == nn:
            return h["at"]
    return None


def record_duration(root, state, nn):
    t0 = phase_started_at(state, nn)
    if not t0:
        return
    minutes = round((dt.datetime.now().astimezone() - dt.datetime.fromisoformat(t0)).total_seconds() / 60, 1)
    sp = Path(root, f"specs/phase-{nn}.md")
    level = (spec_complexity(sp.read_text(encoding="utf-8")) if sp.is_file() else None) or "M"
    d = state.setdefault("durations", [])
    d.append({"phase": nn, "level": level, "minutes": minutes})
    del d[:-60]


def cmd_finish(root, cfg, state):
    require(state.get("stage") == "implementing", f"Stage is '{state.get('stage')}', not 'implementing'.")
    nn = state["phase"]
    msg = C.git(root, "log", "-1", "--pretty=%B").stdout
    require(re.match(rf"^Phase {nn}: ", msg), f"The latest commit is not 'Phase {nn}: ...'. Commit the phase first.")
    require(C.git(root, "status", "--porcelain").stdout.strip() == "" or
            all(l[3:].startswith((".phased/", C.PROGRESS)) for l in C.git(root, "status", "--porcelain").stdout.splitlines()),
            "Working tree is not clean.")
    sha = C.git(root, "rev-parse", "HEAD").stdout.strip()
    state["stage"] = "done"
    record_duration(root, state, nn)
    log(state, "finish", commit=sha)
    C.say(f"Phase {nn} done ({sha[:10]}).")
    return 0


def cmd_reopen(root, cfg, state, args):
    to = args[args.index("--to") + 1] if "--to" in args and args.index("--to") + 1 < len(args) else None
    require(to in ("spec", "tests"), "usage: phase.py reopen --to spec|tests")
    require(state.get("stage") in ("tests", "implementing"), "Nothing to reopen.")
    state["stage"] = to
    state["review"], state["red"] = None, None
    if to == "spec":
        state["spec_sha256"] = None
    log(state, "reopen", to=to)
    C.say(f"Phase {state['phase']} reopened to stage '{to}'.")
    return 0


def cmd_retest(root, cfg, state, args):
    """Limited automatic reopen of the tests (never the spec), so a wrong test does not stop the run."""
    require(state.get("stage") == "implementing",
            "retest is only for the 'implementing' stage (tests locked and proven red).")
    reason = " ".join(args[args.index("--reason") + 1:]).strip() if "--reason" in args else ""
    require(reason, 'usage: phase.py retest --reason "<why the locked test contradicts the spec>"')
    nn = state["phase"]
    limit = int(cfg.get("auto_retest_limit", 1))
    used = int((state.get("retests") or {}).get(nn, 0))
    require(used < limit, f"Phase {nn} already used its {limit} automatic test reopen(s). "
                          "Stop and ask the user (phase.py reopen --to tests).")
    state.setdefault("retests", {})[nn] = used + 1
    state["stage"] = "tests"
    state["review"] = None
    state["red_after_retest"] = nn
    log(state, "retest", reason=reason[:300])
    C.say(f"Phase {nn}: tests reopened automatically ({used + 1}/{limit}). Next: test-writer (normal run, "
          "with the reason), then test-reviewer, then the implementer again. Stage: tests.")
    return 0


def cmd_route(root, cfg, state):
    nn = state.get("phase")
    require(nn and state.get("stage") in ("spec", "tests", "implementing"), "No phase in progress.")
    level = spec_complexity(Path(root, f"specs/phase-{nn}.md").read_text(encoding="utf-8")) or "M"
    print(json.dumps({"phase": nn, "complexity": level, **route_for(cfg, level)}, indent=2))
    return 0


def cmd_brief(root, cfg, state):
    """Printed by the SessionStart hook (startup/resume/clear/compact). Claude Code adds this
    text to Claude's context, so a compacted or fresh session knows exactly where it is."""
    try:
        if not sys.stdin.isatty():
            sys.stdin.read()
    except Exception:
        pass
    stage = state.get("stage")
    approved = state.get("approved_specs") or {}
    if stage in (None, "done") and not any(int(n) > int(state.get("phase") or 0) for n in approved):
        return 0
    lines = ["[phased] A /build run is in progress in this repository. Facts from .phased/state.json:"]
    lines.append(f"- current phase: {state.get('phase') or '-'} ({state.get('title') or '-'}), stage: {stage}")
    rows = []
    for nn in sorted(approved):
        p = Path(root, f"specs/phase-{nn}.md")
        title = ""
        if p.exists():
            t = p.read_text(encoding="utf-8")
            m = re.search(r"^#\s*Phase\s+\d{2}:\s*(.+)$", t, flags=re.M)
            title = (m.group(1).strip() if m else "") + f" [{spec_complexity(t) or '?'}]"
        done = state.get("phase") and int(nn) < int(state["phase"]) or (nn == state.get("phase") and stage == "done")
        rows.append(f"{nn} {title} {'done' if done else 'todo'}")
    if rows:
        lines.append("- approved plan: " + "; ".join(rows))
    lines.append("- next step: run 'python3 .phased/bin/phase.py status' and continue /build from there "
                 "(it is safe: tests, specs and progress are on disk, not in this conversation).")
    lines.append("- rules: never edit/skip tests or specs; one 'Phase NN:' commit per phase; no AI attribution; "
                 "build each phase with the implementer agent using 'phase.py route'.")
    print("\n".join(lines))
    return 0


PENDING = ".phased/pending"


def pending_files(root, nn, suffix=None):
    base = Path(root, PENDING, f"phase-{nn}")
    if not base.is_dir():
        return []
    out = []
    for p in sorted(base.rglob("*")):
        if p.is_file() and "__pycache__" not in p.parts and p.suffix not in (".pyc", ".pyo"):
            if suffix is None or p.name.endswith(suffix):
                out.append(p)
    return out


def prefetch_reviews(root):
    """Prefetch verdicts, one file per phase: parallel reviewers finishing at the same moment
    never overwrite each other's result."""
    out = {}
    for f in sorted(Path(root, PENDING, "reviews").glob("phase-*.json")):
        try:
            out[f.stem[6:]] = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    return out


def pending_digest(root, nn):
    import hashlib
    h = hashlib.sha256()
    base = Path(root, PENDING, f"phase-{nn}")
    for p in pending_files(root, nn):
        h.update(f"{p.relative_to(base).as_posix()}:{C.sha256_file(p)}\n".encode())
    return h.hexdigest()


def cmd_prefetch(root, cfg, state):
    require(state.get("stage") in (None, "done"), f"Stage is '{state.get('stage')}'. Prefetch runs between phases.")
    cur = int(state.get("phase") or 0)
    phases = sorted(n for n in (state.get("approved_specs") or {}) if int(n) > cur)
    require(phases, "No approved phases waiting. Approve the plan first.")
    import shutil
    shutil.rmtree(Path(root, PENDING, "reviews"), ignore_errors=True)
    state["prefetch"] = {"phases": phases}
    state["stage"] = "prefetch"
    log(state, "prefetch", phases=phases)
    for nn in phases:
        sp = Path(root, f"specs/phase-{nn}.md")
        level = (spec_complexity(sp.read_text(encoding="utf-8")) if sp.is_file() else None) or "M"
        r = route_for(cfg, level)
        C.say(f"route {nn}: " + json.dumps({"complexity": level, "test-writer": r["test-writer"],
                                             "test-reviewer": r["test-reviewer"]}))
    cap = max(1, int(cfg.get("max_parallel_agents", 4)))
    waves = [phases[i:i + cap] for i in range(0, len(phases), cap)]
    C.say(f"waves (at most {cap} agents at once): " + " | ".join(f"wave {i + 1}: {' '.join(w)}" for i, w in enumerate(waves)))
    C.say(f"Prefetch open for phases {', '.join(phases)}. Wave by wave: start that wave's test-writers together "
          f"(each writes only under {PENDING}/phase-NN/<normal test path>), wait for them, then the next wave. "
          "Then the test-reviewers, wave by wave (last line 'VERDICT PHASE NN: PASS|FAIL'). "
          "Then: python3 .phased/bin/phase.py prefetch-done")
    return 0


def cmd_prefetch_done(root, cfg, state):
    require(state.get("stage") == "prefetch", f"Stage is '{state.get('stage')}', not 'prefetch'.")
    pf = state.get("prefetch") or {}
    reviews = prefetch_reviews(root)
    ready, dropped = {}, []
    for nn in pf.get("phases", []):
        files = pending_files(root, nn)
        rv = reviews.get(nn) or {}
        if files and rv.get("verdict") == "PASS" and rv.get("digest") == pending_digest(root, nn):
            entries = {}
            base = Path(root, PENDING, f"phase-{nn}")
            for p in files:
                rel = p.relative_to(base).as_posix()
                staged = p if p.name.endswith(".pending") else p.with_name(p.name + ".pending")
                if staged != p:
                    p.rename(staged)  # .pending: test runners never collect staged tests
                entries[rel[:-8] if rel.endswith(".pending") else rel] = C.sha256_file(staged)
            ready[nn] = entries
        else:
            import shutil
            shutil.rmtree(Path(root, PENDING, f"phase-{nn}"), ignore_errors=True)
            if files or rv:
                dropped.append(nn)
    import shutil
    shutil.rmtree(Path(root, PENDING, "reviews"), ignore_errors=True)
    state["pending_tests"] = {**(state.get("pending_tests") or {}), **ready}
    state["stage"] = "done" if state.get("phase") else None
    state.pop("prefetch", None)
    log(state, "prefetch-done", ready=sorted(ready), dropped=dropped)
    C.say(f"Prefetched tests ready for phases: {', '.join(sorted(ready)) or 'none'}."
          + (f" Not ready (will be written inside their phase): {', '.join(dropped)}." if dropped else ""))
    return 0


def move_in_prefetched(root, cfg, state, nn):
    entries = (state.get("pending_tests") or {}).get(nn)
    if not entries:
        return 0
    base = Path(root, PENDING, f"phase-{nn}")
    for rel, sha in entries.items():
        src = base / (rel + ".pending")
        require(src.is_file() and C.sha256_file(src) == sha, f"Prefetched test {rel} is missing or was changed.")
        dst = Path(root, rel)
        require(not dst.exists(), f"Cannot move prefetched test in: {rel} already exists.")
    lock = L.load_lock(root)
    for rel, sha in entries.items():
        dst = Path(root, rel)
        dst.parent.mkdir(parents=True, exist_ok=True)
        (base / (rel + ".pending")).rename(dst)
        lock["files"][rel] = {"sha256": C.sha256_file(dst), "phase": nn}
    L.save_lock(root, lock)
    import shutil
    shutil.rmtree(base, ignore_errors=True)
    state["pending_tests"].pop(nn, None)
    state["review"] = {"verdict": "PASS", "lock_digest": L.digest(root, nn), "at": now(), "prefetched": True}
    log(state, "tests-moved-in", files=len(entries))
    return len(entries)


VERDICT_RE = re.compile(r"VERDICT(?:\s+(?:FOR\s+)?PHASE\s+(\d{1,2}))?\s*[:=\-]+\s*(PASS|FAIL)\b", re.IGNORECASE)


def transcript_texts(path, role):
    """Text blocks of one role from a subagent transcript, oldest first."""
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") != role:
                    continue
                c = (d.get("message") or {}).get("content")
                if isinstance(c, str):
                    out.append(c)
                elif isinstance(c, list):
                    for x in c:
                        if not isinstance(x, dict):
                            continue
                        if x.get("type") == "text":
                            out.append(x.get("text", ""))
                        elif x.get("type") == "tool_use" and x.get("name") == "SubagentHandback":
                            out.extend(v for v in (x.get("input") or {}).values() if isinstance(v, str))
    except (OSError, TypeError):
        pass
    return out


def parse_verdicts(text):
    """[(phase or None, 'PASS'|'FAIL')] in order. Tolerates markdown (**VERDICT:** PASS), any case,
    and the prefetch form 'VERDICT PHASE NN: PASS'."""
    clean = re.sub(r"[*_`#>]", "", text or "")
    return [(n.zfill(2) if n else None, v.upper()) for n, v in VERDICT_RE.findall(clean)]


CLAUDE_HOMES = [Path(os.path.expanduser("~/.claude"))]
if os.environ.get("CLAUDE_CONFIG_DIR"):
    CLAUDE_HOMES.append(Path(os.path.expanduser(os.environ["CLAUDE_CONFIG_DIR"])))
REVIEW_AGENTS = ".phased/evidence/review-agents"


def under_claude_homes(path):
    try:
        real = Path(os.path.realpath(str(path)))
    except OSError:
        return False
    for h in CLAUDE_HOMES:
        try:
            real.relative_to(Path(os.path.realpath(str(h))))
            return True
        except ValueError:
            pass
    return False


def subagent_transcript(data):
    """The reviewer's own transcript, written by Claude Code under ~/.claude (agents cannot
    write there: the guard blocks it). Tried in order: the path Claude Code passes, the
    sessions folder next to the main transcript, then a search by agent id."""
    tp = data.get("agent_transcript_path")
    if tp and Path(tp).is_file():
        return Path(tp)
    aid = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("agent_id") or ""))
    if not aid:
        return None
    main = data.get("transcript_path")
    if main:
        mp = Path(main)
        for c in (mp.with_suffix("") / "subagents" / f"agent-{aid}.jsonl",
                  mp.parent / str(data.get("session_id") or "-") / "subagents" / f"agent-{aid}.jsonl"):
            if c.is_file():
                return c
        if mp.parent.is_dir():
            for c in mp.parent.rglob(f"*{aid}*.jsonl"):
                return c
    for h in CLAUDE_HOMES:
        proj = h / "projects"
        if proj.is_dir():
            for c in proj.rglob(f"*{aid}*.jsonl"):
                return c
    return None


def reviewer_text(data, wait=True):
    """(verdicts, last text, transcript path, where it came from). The transcript is written
    asynchronously, so wait briefly for it when the message itself is not in the payload."""
    text = data.get("last_assistant_message") or ""
    found = parse_verdicts(text)
    if found:
        return found, text, data.get("agent_transcript_path") or "", "last_assistant_message"
    tries = 8 if wait else 1
    tpath = None
    for i in range(tries):
        tpath = subagent_transcript(data)
        if tpath and under_claude_homes(tpath) or (tpath and tpath == Path(data.get("agent_transcript_path") or "-")):
            texts = transcript_texts(tpath, "assistant")
            for t in reversed(texts):
                found = parse_verdicts(t)
                if found:
                    return found, t, str(tpath), "subagent transcript"
            text = texts[-1] if texts else text
        if i < tries - 1:
            time.sleep(1)
    return [], text, str(tpath or ""), "nothing found"


def log_payload(root, data, source):
    """Which fields Claude Code sent (names and sizes only, never contents)."""
    try:
        ev = Path(root, ".phased/evidence")
        ev.mkdir(parents=True, exist_ok=True)
        shape = {k: (len(v) if isinstance(v, (str, list, dict)) else v if isinstance(v, bool) else type(v).__name__)
                 for k, v in data.items()}
        with open(ev / "hook-payload.log", "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": now(), "event": data.get("hook_event_name"), "agent_type": data.get("agent_type"),
                                "verdict_from": source, "fields": shape}) + "\n")
    except OSError:
        pass


def remember_reviewer(root, data, phase):
    """Agent ids the test-reviewer hook saw (one file each, so parallel reviewers never clash).
    'review-verdict' accepts only these, so another agent's transcript can never be passed off
    as a test review."""
    aid = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("agent_id") or ""))
    if not aid:
        return
    try:
        d = Path(root, REVIEW_AGENTS)
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{aid}.json").write_text(json.dumps({"phase": phase, "transcript_path": data.get("transcript_path"),
                                                   "session_id": data.get("session_id"), "at": now()}), encoding="utf-8")
    except OSError:
        pass


def apply_review(root, cfg, state, found, text, tpath):
    """Record verdicts. Returns 'prefetch' when state.json must not be rewritten."""
    if state.get("stage") == "prefetch":
        phases = (state.get("prefetch") or {}).get("phases", [])
        if any(n is None for n, _ in found):  # 'VERDICT: PASS' without a phase: take it from the task prompt
            asked = set()
            for t in transcript_texts(tpath, "user")[:1]:
                asked |= {m.zfill(2) for m in re.findall(r"(?i)phase[\s-]*(\d{1,2})\b", t)} & set(phases)
            found = [(n or (next(iter(asked)) if len(asked) == 1 else None), v) for n, v in found]
        rdir = Path(root, PENDING, "reviews")
        for nn, verdict in found:
            if nn in phases:
                rdir.mkdir(parents=True, exist_ok=True)
                tmp = rdir / f".phase-{nn}.{os.getpid()}.tmp"
                tmp.write_text(json.dumps({"verdict": verdict, "digest": pending_digest(root, nn), "at": now()}))
                os.replace(tmp, rdir / f"phase-{nn}.json")
        if not any(nn in phases for nn, _ in found):
            note_unparsed(root, "prefetch", text)
        return "prefetch", [nn for nn, _ in found if nn in phases]
    if state.get("stage") != "tests":
        return "ignored", []
    mine = [v for n, v in found if n in (None, state["phase"])]
    verdict = mine[-1] if mine else "NO VERDICT"
    if not mine:
        note_unparsed(root, state["phase"], text)
    state["review"] = {"verdict": verdict, "lock_digest": L.digest(root, state["phase"]), "at": now()}
    log(state, "review", verdict=verdict)
    return "tests", [verdict]


def cmd_hook_review(root, cfg, state):
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    found, text, tpath, source = reviewer_text(data)
    log_payload(root, data, source)
    remember_reviewer(root, data, "prefetch" if state.get("stage") == "prefetch" else state.get("phase"))
    kind, _ = apply_review(root, cfg, state, found, text, tpath)
    if kind == "prefetch":
        raise SystemExit(0)  # do not rewrite state.json: other reviewers may be finishing right now
    return 0


def cmd_review_verdict(root, cfg, state, args):
    """Fallback when the hook could not read the verdict: read it from that reviewer's own
    transcript. Only agent ids the test-reviewer hook recorded are accepted."""
    aid = argval(args, "--agent-id") or ""
    require(aid, "usage: phase.py review-verdict --agent-id <id of the test-reviewer agent>")
    aid = re.sub(r"[^A-Za-z0-9_-]", "", aid)
    rec_file = Path(root, REVIEW_AGENTS, f"{aid}.json")
    require(aid and rec_file.is_file(), f"Agent {aid} is not a test-reviewer this project's hook has seen. "
                                        "Run the test-reviewer agent again.")
    seen = C.read_json(rec_file, {}) or {}
    data = {"agent_id": aid, **{k: v for k, v in seen.items() if k in ("transcript_path", "session_id")}}
    found, text, tpath, source = reviewer_text(data, wait=False)
    require(found, f"No VERDICT line found in that reviewer's transcript ({tpath or 'transcript not found'}). "
                   "Run the test-reviewer again.")
    kind, rec = apply_review(root, cfg, state, found, text, tpath)
    log_payload(root, {"agent_id": aid, "hook_event_name": "review-verdict"}, source)
    C.say(f"Verdict recorded from the reviewer's transcript ({kind}): {', '.join(rec) or 'nothing matched this stage'}.")
    if kind == "prefetch":
        raise SystemExit(0)
    return 0


def note_unparsed(root, nn, text):
    """Keep the reviewer's last words when no verdict could be read, so the cause is visible."""
    try:
        ev = Path(root, ".phased/evidence")
        ev.mkdir(parents=True, exist_ok=True)
        with open(ev / f"phase-{nn}-review-unparsed.log", "a", encoding="utf-8") as f:
            f.write(f"--- {now()}\n{(text or '(empty: no reviewer message reached the hook)')[-1500:]}\n")
    except OSError:
        pass


# ------------------------------------------------------------------ estimate, review, risk, report, kba


def argval(args, name, default=None):
    if name in args and args.index(name) + 1 < len(args):
        return args[args.index(name) + 1]
    return default


def plan_phase_specs(root, state):
    """(nn, spec path) of the plan being approved, or of the approved phases not built yet."""
    if state.get("stage") == "planning":
        return pending_specs(root, state)
    cur = int(state.get("phase") or 0) - (0 if state.get("stage") in (None, "done") else 1)
    return [(nn, Path(root, f"specs/phase-{nn}.md")) for nn in sorted(state.get("approved_specs") or {})
            if int(nn) > cur]


def spec_title(path, nn):
    try:
        m = re.search(rf"^#\s*Phase\s+{nn}:\s*(.+)$", path.read_text(encoding="utf-8"), flags=re.M)
        return m.group(1).strip() if m else ""
    except OSError:
        return ""


def minutes_for(state, level):
    xs = [d["minutes"] for d in state.get("durations", []) if d.get("level") == level][-10:]
    return (sum(xs) / len(xs), len(xs)) if xs else (DEFAULT_MINUTES[level], 0)


def change_text(root, state):
    p = Path(root, state.get("change_dir") or "-", "change.md")
    return p.read_text(encoding="utf-8") if p.is_file() else ""


def stated_risk(root, state):
    m = re.search(r"^\s*(?:#+\s*|[-*]\s*)?\**Risk\**\s*[:|]\s*\**\s*(Low|Medium|High)\b", change_text(root, state), flags=re.M | re.I)
    return m.group(1).capitalize() if m else None


def changed_files(root, state):
    base = state.get("base_commit")
    files = set()
    if base:
        files |= set(C.git(root, "diff", "--name-only", f"{base}..HEAD").stdout.split())
    files |= set(C.git(root, "diff", "--name-only", "--cached").stdout.split())
    return sorted(files)


def compute_risk(root, cfg, state):
    stated = stated_risk(root, state) or "Medium"
    hits = [f for f in changed_files(root, state)
            if C.matches(f, cfg.get("high_risk_paths") or DEFAULT_HIGH_RISK_PATHS) and not C.is_change_doc(f)]
    final = "High" if hits else stated
    return {"stated": stated, "final": final, "approvals": APPROVALS[final], "high_risk_files": hits[:20]}


def cmd_estimate(root, cfg, state):
    specs = plan_phase_specs(root, state)
    require(specs, "No phases to estimate. Write the specs first (phase.py plan --change ...).")
    levels = {}
    for nn, p in specs:
        levels[nn] = (spec_complexity(p.read_text(encoding="utf-8")) if p.is_file() else None) or "M"
    count = {lv: sum(1 for v in levels.values() if v == lv) for lv in LEVELS}
    cap = max(1, int(cfg.get("max_parallel_agents", 4)))
    phases = sorted(levels)
    waves = [phases[i:i + cap] for i in range(0, len(phases), cap)]
    by_model = {}
    for nn, lv in levels.items():
        by_model.setdefault(route_for(cfg, lv)["implementer"]["model"], []).append(nn)
    total, learned = 0.0, 0
    for lv in levels.values():
        m, n = minutes_for(state, lv)
        total += m
        learned += n
    total += 2 * len(waves) * TEST_WAVE_MINUTES  # test-writing and test-review waves
    minutes = max(5, int(round(total / 5.0)) * 5)
    risk = stated_risk(root, state) or "Medium (not stated in change.md)"
    rkey = risk.split()[0]
    warn = []
    if len(phases) > int(cfg.get("usage_warn_phases", 10)):
        warn.append(f"{len(phases)} phases is a big plan: consider splitting it into two changes")
    if count["L"] > int(cfg.get("usage_warn_large", 3)):
        warn.append(f"{count['L']} large phases run on Opus: usage will be high")
    if minutes > int(cfg.get("usage_warn_minutes", 120)):
        warn.append(f"about {minutes} minutes: consider splitting, or check your usage limits first")
    sizes = ", ".join(f"{count[lv]} {LEVEL_WORDS[lv]}" for lv in LEVELS if count[lv])
    rows = [
        ("Phases", f"{len(phases)} ({sizes})"),
        ("Agents at once", f"up to {min(cap, len(phases))} (" + " | ".join(f"wave {i + 1}: {' '.join(w)}" for i, w in enumerate(waves)) + ")"),
        ("Models", " · ".join(f"{m.capitalize()}: {', '.join(v)}" for m, v in sorted(by_model.items()))),
        ("Estimated time", f"about {minutes} minutes" + (f" (from {learned} timed phases)" if learned else " (first-run guess; improves as phases are timed)")),
        ("Risk", f"{risk} -> {APPROVALS.get(rkey, APPROVALS['Medium'])}"),
        ("Needs from you", "nothing until the end, unless the spec turns out to be wrong"),
        ("Tip", "switch to auto mode (Shift+Tab) for an unattended run"),
    ] + [("WARNING", w) for w in warn]
    print("| Item | Value |\n|---|---|")
    for k, v in rows:
        print(f"| {'**' + k + '**' if k == 'WARNING' else k} | {v} |")
    return 0


def cmd_review_prep(root, cfg, state):
    require(state.get("stage") == "implementing", f"Stage is '{state.get('stage')}', not 'implementing'.")
    nn = state["phase"]
    rv = state.setdefault("code_reviews", {}).setdefault(nn, {"rounds": []})
    limit = int(cfg.get("review_rounds", 3))
    rnd = len(rv["rounds"]) + 1
    require(rnd <= limit, f"Phase {nn} already had {limit} review rounds. Do not review again: ask one fresh "
                          "implementer to rethink the approach for the open findings, or stop and report.")
    unstaged = C.git(root, "diff", "--name-only").stdout.split()
    untracked = C.git(root, "ls-files", "--others", "--exclude-standard").stdout.split()
    require(not unstaged and not untracked, "Stage everything first (git add -A), so the review sees exactly what will be committed.")
    tree = C.git(root, "write-tree").stdout.strip()
    ev = Path(root, ".phased/evidence")
    ev.mkdir(parents=True, exist_ok=True)
    full = ev / f"phase-{nn}-review-r{rnd}.diff"
    noise = ["--", ".", ":(exclude).phased", f":(exclude){C.PROGRESS}"]  # machine files are not code to review
    full.write_text(C.git(root, "diff", "--cached", "--no-color", *noise).stdout, encoding="utf-8")
    out = {"phase": nn, "round": rnd, "max_rounds": limit, "full_diff": str(full.relative_to(root))}
    if rv["rounds"]:
        delta = ev / f"phase-{nn}-review-r{rnd}-changes.diff"
        delta.write_text(C.git(root, "diff", "--no-color", rv["rounds"][-1]["tree"], tree, *noise).stdout, encoding="utf-8")
        out["changes_since_last_round"] = str(delta.relative_to(root))
        out["earlier_findings"] = rv["rounds"][-1].get("classes", [])
        out["instruction"] = ("Round > 1: review ONLY the changes file, check that the earlier findings are fixed, "
                              "and never repeat a finding already reported.")
    else:
        out["instruction"] = "Round 1: review the full diff against change.md, the phase spec and REVIEW.md."
    rv["rounds"].append({"tree": tree, "at": now()})
    log(state, "review-prep", round=rnd)
    print(json.dumps(out, indent=2))
    return 0


def cmd_review_done(root, cfg, state, args):
    require(state.get("stage") == "implementing", f"Stage is '{state.get('stage')}', not 'implementing'.")
    nn = state["phase"]
    rounds = ((state.get("code_reviews") or {}).get(nn) or {}).get("rounds") or []
    require(rounds, "Run phase.py review-prep first.")
    verdict = (argval(args, "--verdict") or "").upper()
    require(verdict in ("PASS", "FAIL"), 'usage: phase.py review-done --verdict PASS|FAIL [--important N --nits N --preexisting N --classes "a; b"]')
    r = rounds[-1]
    r.update({"verdict": verdict, "important": int(argval(args, "--important", 0) or 0),
              "nits": int(argval(args, "--nits", 0) or 0), "preexisting": int(argval(args, "--preexisting", 0) or 0),
              "classes": [c.strip() for c in (argval(args, "--classes", "") or "").split(";") if c.strip()]})
    log(state, "review", round=len(rounds), verdict=verdict, important=r["important"])
    if verdict == "PASS":
        C.say(f"Review round {len(rounds)} PASS. Commit the phase ('Phase {nn}: <title>' with a Challenges: section), then: phase.py finish")
    elif len(rounds) >= int(cfg.get("review_rounds", 3)):
        C.say("Review FAIL on the last allowed round. Ask one fresh implementer to rethink the approach for the open "
              "Important findings; if that is still not enough, stop and report.")
    else:
        C.say(f"Review FAIL. Send only the Important findings (by bug type) to a fresh implementer: fix every instance, "
              f"re-run check.py, stage, stop READY. Then review-prep again (round {len(rounds) + 1}).")
    return 0


def cmd_risk(root, cfg, state):
    print(json.dumps(compute_risk(root, cfg, state), indent=2))
    return 0


def commit_info(root, sha):
    if not sha:
        return "", []
    msg = C.git(root, "log", "-1", "--pretty=%B", sha).stdout
    sec = re.split(r"^Challenges:[ \t]*", msg, maxsplit=1, flags=re.M | re.I)
    bullets = re.findall(r"^\s*[-*]\s+(.+)$", sec[1], flags=re.M) if len(sec) > 1 else []
    return msg.strip(), bullets


def change_summary(root, cfg, state):
    rows = []
    hist = state.get("history", [])
    for nn in state.get("change_phases") or []:
        sp = Path(root, f"specs/phase-{nn}.md")
        lv = (spec_complexity(sp.read_text(encoding="utf-8")) if sp.is_file() else None) or "M"
        fin = next((h for h in reversed(hist) if h.get("event") == "finish" and h.get("phase") == nn), None)
        red = next((h for h in reversed(hist) if h.get("event") == "red" and h.get("phase") == nn), None)
        dur = next((d["minutes"] for d in reversed(state.get("durations", [])) if d.get("phase") == nn), None)
        revs = ((state.get("code_reviews") or {}).get(nn) or {}).get("rounds") or []
        msg, challenges = commit_info(root, (fin or {}).get("commit"))
        rows.append({"phase": nn, "title": spec_title(sp, nn), "level": lv,
                     "model": route_for(cfg, lv)["implementer"]["model"], "minutes": dur,
                     "test_files": (red or {}).get("tests"), "commit": ((fin or {}).get("commit") or "")[:10],
                     "review_rounds": len(revs), "important_found": sum(r.get("important", 0) for r in revs),
                     "preexisting": sum(r.get("preexisting", 0) for r in revs[:1]),
                     "bug_types": sorted({c for r in revs for c in r.get("classes", [])}),
                     "retests": (state.get("retests") or {}).get(nn, 0), "challenges": challenges,
                     "commit_message": msg, "done": bool(fin)})
    return rows


def ensure_change(root, state):
    """Builds approved before 2.0 have no change folder: give them one, so they can finish."""
    if not state.get("change_dir"):
        state["change_dir"] = f"changes/{dt.date.today().isoformat()}-build"
        Path(root, state["change_dir"], "kba", "screenshots").mkdir(parents=True, exist_ok=True)
    if not state.get("change_phases"):
        state["change_phases"] = sorted(state.get("approved_specs") or {})
    return state["change_dir"]


def cmd_report(root, cfg, state):
    cdir = ensure_change(root, state)
    rows = change_summary(root, cfg, state)
    risk = compute_risk(root, cfg, state)
    types = {}
    for r in rows:
        for t in r["bug_types"]:
            types[t] = types.get(t, 0) + 1
    repeated = sorted(t for t, n in types.items() if n >= 2)
    done = [r for r in rows if r["done"]]
    total_min = sum(r["minutes"] or 0 for r in rows)
    lines = [f"# Report: {cdir.split('/', 1)[-1]}", "",
             f"_Written by `.phased/bin/phase.py report` on {now()[:16]}._", "",
             "| Phase | Title | Size | Model | Minutes | Test files | Review rounds | Bugs found and fixed | Retests | Commit |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['phase']} | {r['title']} | {LEVEL_WORDS[r['level']]} | {r['model']} | {r['minutes'] or '-'} | "
                     f"{r['test_files'] or '-'} | {r['review_rounds']} | {r['important_found']} | {r['retests']} | {r['commit'] or 'not done'} |")
    lines += ["", "| Total | Value |", "|---|---|",
              f"| Phases done | {len(done)} of {len(rows)} |",
              f"| Time | about {int(round(total_min))} minutes |",
              f"| Risk | {risk['final']} -> {risk['approvals']}" + (" (raised: high-risk files changed)" if risk['final'] != risk['stated'] else "") + " |",
              f"| Old problems seen, not blocking | {sum(r['preexisting'] for r in rows)} |"]
    ch = [(r["phase"], c) for r in rows for c in r["challenges"] if c.strip().lower() not in ("none", "none.")]
    if ch:
        lines += ["", "## Problems met and how they were solved", ""] + [f"- Phase {p}: {c}" for p, c in ch]
    if risk["high_risk_files"]:
        lines += ["", "## High-risk files changed", ""] + [f"- `{f}`" for f in risk["high_risk_files"]]
    if repeated:
        lines += ["", "## Suggested REVIEW.md lines (same bug type in 2+ phases)", ""] + \
                 [f"- Check for: {t}" for t in repeated]
    out = Path(root, cdir, "report.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(state, "report")
    C.say(f"Report written: {out.relative_to(root)}")
    print("\n".join(lines))
    return 0


SECRET_RX = re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*|\s+)(\S+)")


def redact(text):
    return SECRET_RX.sub(lambda m: f"{m.group(1)}{m.group(2)}***", text or "")


def tail(path, n=3000):
    try:
        return redact(Path(path).read_text(encoding="utf-8", errors="replace")[-n:])
    except OSError:
        return ""


def cmd_kba_facts(root, cfg, state):
    cdir = ensure_change(root, state)
    phases = state.get("change_phases") or []
    ev = Path(root, ".phased/evidence")
    kdir = Path(root, cdir, "kba")
    shots = sorted(p.relative_to(kdir).as_posix() for p in (kdir / "screenshots").glob("*")
                   if p.suffix.lower() in (".png", ".jpg", ".jpeg"))
    facts = {
        "company": cfg.get("company_name", "Waddaya Solutions Private Limited"),
        "change": cdir, "generated_at": now(), "base_commit": state.get("base_commit"),
        "change_md": redact(change_text(root, state)),
        "risk": compute_risk(root, cfg, state),
        "commands": {k: v for c in cfg.get("components", []) for k, v in
                     ((f"{c.get('name')} test", c.get("test_command")), (f"{c.get('name')} lint", c.get("lint_command")),
                      (f"{c.get('name')} type check", c.get("typecheck_command"))) if v},
        "timeline": [h for h in state.get("history", []) if h.get("phase") in phases
                     or h.get("event") in ("plan", "approve-plan", "report")][-400:],
        "phases": [],
        "screenshots": shots,
    }
    for r in change_summary(root, cfg, state):
        nn = r["phase"]
        sp = Path(root, f"specs/phase-{nn}.md")
        intent = ""
        if sp.is_file():
            t = sp.read_text(encoding="utf-8")
            if "## Intent" in t:
                intent = re.sub(r"<!--.*?-->", "", t.split("## Intent", 1)[1].split("\n## ", 1)[0], flags=re.S).strip()
        r = {**r, "intent": redact(intent), "commit_message": redact(r["commit_message"]),
             "gate_attempts": tail(ev / f"phase-{nn}-gate.log", 2500),
             "failing_first_evidence": tail(ev / f"phase-{nn}-red.log", 2500),
             "screenshots": [s for s in shots if f"phase-{nn}" in s]}
        facts["phases"].append(r)
    kdir.mkdir(parents=True, exist_ok=True)
    out = kdir / "facts.json"
    out.write_text(json.dumps(facts, indent=2), encoding="utf-8")
    log(state, "kba-facts")
    C.say(f"KBA facts written: {out.relative_to(root)}. Next: kba-writer agent, then python3 .phased/bin/kba_docx.py {cdir}/kba/kba.md")
    return 0


def main(argv):
    root = C.find_root()
    cfg = C.load_config(root)
    if cfg is None:
        C.say("phased: not initialised (run /build, it sets the project up).", sys.stderr)
        return 2
    state = C.load_state(root)
    cmd, args = (argv[1] if len(argv) > 1 else "status"), argv[2:]
    try:
        if cmd == "status":
            return cmd_status(root, cfg, state)
        if cmd == "route":
            return cmd_route(root, cfg, state)
        if cmd == "brief":
            return cmd_brief(root, cfg, state)
        if cmd == "estimate":
            return cmd_estimate(root, cfg, state)
        if cmd == "risk":
            return cmd_risk(root, cfg, state)
        handlers = {
            "start": lambda: cmd_start(root, cfg, state, args),
            "plan": lambda: cmd_plan(root, cfg, state, args),
            "prefetch": lambda: cmd_prefetch(root, cfg, state),
            "prefetch-done": lambda: cmd_prefetch_done(root, cfg, state),
            "approve-plan": lambda: cmd_approve_plan(root, cfg, state),
            "approve-spec": lambda: cmd_approve_spec(root, cfg, state),
            "red": lambda: cmd_red(root, cfg, state),
            "finish": lambda: cmd_finish(root, cfg, state),
            "reopen": lambda: cmd_reopen(root, cfg, state, args),
            "retest": lambda: cmd_retest(root, cfg, state, args),
            "review-prep": lambda: cmd_review_prep(root, cfg, state),
            "review-done": lambda: cmd_review_done(root, cfg, state, args),
            "report": lambda: cmd_report(root, cfg, state),
            "kba-facts": lambda: cmd_kba_facts(root, cfg, state),
            "hook-review": lambda: cmd_hook_review(root, cfg, state),
            "review-verdict": lambda: cmd_review_verdict(root, cfg, state, args),
        }
        if cmd not in handlers:
            C.say(__doc__)
            return 2
        code = handlers[cmd]()
        C.save_state(root, state)
        write_progress(root, state)
        return code
    except C.PhasedError as e:
        C.say(f"phased: {e}", sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
