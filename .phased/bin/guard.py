#!/usr/bin/env python3
"""Claude Code PreToolUse hook: the "Claude Code lock" layer.

Reads the hook JSON on stdin and denies tool calls that would break the phased
rules. Silence (exit 0, no output) means "no objection": the normal permission
flow then applies. Wired with onFailure="block", so if this script crashes the
tool call is blocked rather than let through.
"""
import json
import os
import re
import shlex
import sys
sys.dont_write_bytecode = True
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

CLAUDE_HOMES = {Path(os.path.expanduser("~/.claude")).resolve()}
if os.environ.get("CLAUDE_CONFIG_DIR"):
    CLAUDE_HOMES.add(Path(os.path.expanduser(os.environ["CLAUDE_CONFIG_DIR"])).resolve())


def under_claude_home(p):
    for h in CLAUDE_HOMES:
        try:
            p.relative_to(h)
            return True
        except ValueError:
            pass
    return False


def plugin_roots():
    """Where Claude Code itself says the phased plugin lives: its cache copy, or the local
    marketplace folder it loads in place. Read from files under ~/.claude, which agents
    cannot change (the guard blocks it)."""
    roots = set()
    for home in CLAUDE_HOMES:
        base = home / "plugins"
        try:
            inst = json.loads((base / "installed_plugins.json").read_text(encoding="utf-8"))
            known = json.loads((base / "known_marketplaces.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for key, entries in (inst.get("plugins") or {}).items():
            name, _, market = key.partition("@")
            if name not in ("waddaya-dev", "phased"):
                continue
            for e in entries or []:
                if e.get("installPath"):
                    roots.add(Path(e["installPath"]).resolve())
            loc = (known.get(market) or {}).get("installLocation")
            if loc:
                roots.add(Path(loc).resolve())
    return roots


def is_init_script(raw, name=None):
    """True for /phased-init's own scripts: under ~/.claude (personal skills or plugin cache)
    or inside a location Claude Code registered for the installed phased plugin."""
    try:
        p = Path(os.path.expanduser(raw)).resolve()
    except OSError:
        return False
    trusted = under_claude_home(p)
    if not trusted:
        for r in plugin_roots():
            try:
                p.relative_to(r)
                trusted = True
                break
            except ValueError:
                pass
    if not trusted:
        return False
    return p.parent.name == "scripts" and p.parent.parent.name in ("build", "phased-init") and \
        (name is None or p.name == name) and p.is_file()

SAFE_READ = {"cat", "head", "tail", "less", "more", "wc", "ls", "stat", "file", "diff",
             "cmp", "grep", "egrep", "fgrep", "rg", "tree", "sha256sum", "shasum",
             "md5sum", "nl", "column", "jq", "echo", "printf", "true", "pwd", "realpath",
             "basename", "dirname", "test", "["}
SAFE_GIT = {"add", "diff", "status", "log", "show", "ls-files", "blame", "grep",
            "rev-parse", "branch", "describe", "shortlog", "cat-file", "check-ignore"}
DESTRUCTIVE = {"rm", "rmdir", "unlink", "shred", "truncate", "mv", "cp", "rsync", "chmod",
               "chown", "ln", "sed", "perl", "awk", "gawk", "tee", "dd", "install",
               "touch", "patch", "ed", "ex", "vi", "vim", "nano", "emacs", "xargs"}
RUNNERS = [["pytest"], ["python", "-m", "pytest"], ["python3", "-m", "pytest"],
           ["npx", "jest"], ["npx", "vitest"], ["npx", "mocha"], ["npm", "test"],
           ["npm", "run", "test"], ["yarn", "test"], ["pnpm", "test"], ["go", "test"],
           ["cargo", "test"], ["mvn"], ["./gradlew"], ["gradle"], ["dotnet", "test"],
           ["make", "test"]]
GATED = {  # sensitive subcommands: must be run in exactly this form (an "ask" rule then prompts you)
    "phase.py": {"approve-spec", "approve-plan", "reopen"},
    "lock.py": {"relock"},
}
HOOK_ONLY = {"phase.py": {"hook-review"}, "lock.py": {"autolock"}}
OPERATORS = {";", "&&", "||", "|", "&", "\n", "(", ")", "|&"}


CURRENT_TOOL = {"name": ""}


def deny(reason):
    if CURRENT_TOOL["name"] in ("Bash", "PowerShell"):
        reason += " NOTHING in this command ran (no part of it), so redo any other steps it contained separately."
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "[phased lock] " + reason}}))
    sys.exit(0)


class Ctx:
    def __init__(self, data):
        self.data = data
        self.root = C.find_root(data.get("cwd"))
        self.cwd = data.get("cwd") or str(self.root)
        self.cfg = C.load_config(self.root)
        self.state = C.load_state(self.root)
        self.agent = data.get("agent_type") or ""
        self.writers = set((self.cfg or {}).get("test_writer_agents", C.DEFAULT_WRITERS))
        self.reviewers = set((self.cfg or {}).get("test_reviewer_agents", C.DEFAULT_REVIEWERS))
        self.kba_writers = set((self.cfg or {}).get("kba_writer_agents", C.DEFAULT_KBA_WRITERS))
        self._files = None

    @property
    def is_writer(self):
        return self.agent in self.writers

    @property
    def is_kba_writer(self):
        return self.agent in self.kba_writers

    @property
    def is_reviewer(self):
        return self.agent in self.reviewers

    def rel(self, p):
        return C.rel(p, self.root, self.cwd)

    def current_spec(self):
        ph = self.state.get("phase")
        return f"specs/phase-{ph}.md" if ph else None

    def tracked(self):
        if self._files is None:
            self._files = C.tracked_and_untracked(self.root)
        return self._files

    def dir_holds_protected(self, rp):
        if rp is None:
            return False
        if rp in ("", "."):
            return True
        if not Path(self.root, rp).is_dir():
            return False
        pre = rp.rstrip("/") + "/"
        globs = C.test_globs(self.cfg) + C.INFRA_GLOBS
        return any(f.startswith(pre) and C.matches(f, globs) for f in self.tracked())


# ------------------------------------------------------------------ helpers

def home_claude_path(raw, cwd):
    if not raw:
        return False
    p = Path(os.path.expanduser(str(raw)))
    if not p.is_absolute():
        p = Path(cwd) / p
    return under_claude_home(Path(os.path.normpath(str(p))))


def protected_for_main_write(ctx, rp):
    """Why the main agent may not change this repo path, or None."""
    if rp is None:
        return None
    if C.is_infra(rp):
        return f"'{rp}' is guardrail infrastructure. Only a human changes it (re-run /build setup to repair)."
    if C.matches(rp, C.test_globs(ctx.cfg)):
        return (f"'{rp}' is a test file. Only the test-writer agent writes tests, and only in the "
                "'tests' stage. If a test looks wrong, stop and tell the user.")
    if C.is_spec(rp):
        stage, cur = ctx.state.get("stage"), ctx.current_spec()
        if stage == "spec" and rp == cur:
            return None
        if stage == "planning" and rp not in (ctx.state.get("approved_specs") or {}) and \
                not any(rp == f"specs/phase-{n}.md" for n in (ctx.state.get("approved_specs") or {})):
            return None
        return (f"'{rp}' is a spec. Specs can only be edited during the 'spec' stage of their own "
                f"phase (current phase spec: {cur or 'none'}, stage: {stage or 'none'}).")
    return None


# ------------------------------------------------------------------ file tools

def check_write(ctx, raw):
    if home_claude_path(raw, ctx.cwd):
        deny("Changing ~/.claude (skills, agents, settings) is blocked during the phased workflow.")
    rp = ctx.rel(raw)
    if rp is None:
        return
    if ctx.is_kba_writer:
        if re.match(r"^changes/[^/]+/kba/[^/]+$", rp) and not C.is_infra(rp):
            return
        deny(f"The kba-writer only writes its article under changes/<change>/kba/. '{rp}' is not allowed.")
    if ctx.is_writer and ctx.state.get("stage") == "prefetch":
        m = re.match(r"^\.phased/pending/phase-(\d{2})/(.+)$", rp)
        phases = (ctx.state.get("prefetch") or {}).get("phases", [])
        if m and m.group(1) in phases and C.matches(m.group(2), C.test_globs(ctx.cfg)):
            return
        deny("During prefetch the test-writer writes ONLY under .phased/pending/phase-NN/<normal test path> "
             f"for an approved phase ({', '.join(phases)}). '{rp}' is not allowed.")
    if ctx.is_writer:
        if C.is_infra(rp):
            deny(f"'{rp}' is guardrail infrastructure.")
        if C.matches(rp, C.test_globs(ctx.cfg)):
            if ctx.state.get("stage") != "tests":
                deny("Tests are locked: they can only be written in the 'tests' stage. "
                     "Report back instead; the user can reopen the phase.")
            return
        deny(f"The test-writer may only write test files. '{rp}' is not a test file "
             "(check .phased/config.json test_globs / holdout_dir).")
    why = protected_for_main_write(ctx, rp)
    if why:
        deny(why)


def check_read(ctx, raw, tool):
    rp = ctx.rel(raw)
    if rp is None:
        return
    holdout = C.holdout_globs(ctx.cfg) + [".phased/pending/**"]
    if ctx.is_reviewer:
        return
    if ctx.is_writer:
        if C.is_spec(rp) or C.matches(rp, C.test_globs(ctx.cfg)):
            return
        if C.matches(rp, C.source_globs(ctx.cfg)):
            deny(f"The test-writer must not read implementation code ('{rp}'). Work from the spec's "
                 "Interface contract. If something is missing there, report it as a spec gap.")
        return
    if tool == "Grep":
        if rp == "" or C.covers(rp, holdout):
            if any(Path(ctx.root, h[:-3]).exists() for h in holdout):
                deny("This search would include the hidden (holdout) tests. Pass a narrower 'path', "
                     "for example the source folder or tests/phase-NN/.")
        return
    if C.matches(rp, holdout):
        deny("Hidden (holdout) and prefetched tests are not readable by the implementing agent.")


# ------------------------------------------------------------------ bash

def tokenize(cmd):
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()<>")
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        return list(lex)
    except ValueError:
        return None


def segments(tokens):
    seg, out = [], []
    for t in tokens:
        if t in OPERATORS or set(t) <= set(";&|()") and t:
            if seg:
                out.append(seg)
            seg = []
        else:
            seg.append(t)
    if seg:
        out.append(seg)
    return out


SHELL_KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!", "{", "time"}
LOOP_HEADERS = {"for", "case", "select", "done", "fi", "esac", "}", "function"}


def split_heredocs(cmd):
    """Return (command lines joined with ';', [heredoc bodies]).
    Bodies are checked separately (see check_bash) so inline scripts cannot hide paths."""
    out, bodies, lines, i = [], [], cmd.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        tags = re.findall(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", line)
        i += 1
        for tag in tags:
            body = []
            while i < len(lines) and lines[i].strip() != tag:
                body.append(lines[i])
                i += 1
            bodies.append("\n".join(body))
            i += 1
    return " ; ".join(l for l in out if l.strip()), bodies


def strip_heredocs(cmd):
    return split_heredocs(cmd)[0]


def strip_env(seg):
    while seg and seg[0] in SHELL_KEYWORDS:
        seg = seg[1:]
    if seg and seg[0] in LOOP_HEADERS:
        return []  # loop/case headers and terminators run nothing themselves
    i = 0
    while i < len(seg) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", seg[i]):
        i += 1
    if i < len(seg) and seg[i] in ("env", "command", "builtin", "exec", "nohup", "time", "sudo"):
        i += 1
        while i < len(seg) and (seg[i].startswith("-") or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", seg[i])):
            i += 1
    return seg[i:]


PATHLIKE = re.compile(r"[\w.\-~/@+]+")


def path_candidates(token):
    """Things inside a token that might be file paths (also catches paths inside -c '...' code)."""
    out = {token}
    for m in PATHLIKE.findall(token):
        if "/" in m or "." in m:
            out.add(m)
    return out


def git_rules(ctx, seg):
    i, opts = 1, []
    while i < len(seg) and seg[i].startswith("-"):
        if seg[i] in ("-C", "-c", "--git-dir", "--work-tree", "--namespace") and i + 1 < len(seg):
            opts.append(seg[i + 1])
            i += 2
            continue
        opts.append(seg[i])
        i += 1
    if any("hookspath" in o.lower() for o in opts) or any(o.startswith(("--git-dir", "--work-tree")) for o in opts):
        deny("Changing git's hook path or work tree is blocked.")
    sub = seg[i] if i < len(seg) else ""
    args = seg[i + 1:]
    if sub == "push":
        deny("Pushing is the user's call. Ask the user to push (or to approve it explicitly).")
    if sub in ("rebase", "filter-branch", "filter-repo", "replace", "update-ref", "reflog", "gc", "prune", "clean"):
        deny(f"'git {sub}' can rewrite history or delete files and is blocked in the phased workflow.")
    if sub == "commit":
        skip_next = False
        for a in args:
            if skip_next:
                skip_next = False
                continue
            if a in ("--message", "--file", "--author", "--date", "--template", "--reuse-message",
                     "--reedit-message", "--trailer", "--cleanup"):
                skip_next = True
                continue
            if a.startswith("--"):
                if a.startswith(("--amend", "--no-verify", "--fixup", "--squash")):
                    deny(f"'git commit {a}' is blocked: commits must pass the hooks and must not rewrite earlier phases.")
                continue
            if a.startswith("-") and len(a) > 1:
                for j, ch in enumerate(a[1:]):
                    if ch == "n":
                        deny("'git commit -n' skips the safety hooks and is blocked.")
                    if ch in "mFCct":  # option that takes a value
                        if j == len(a) - 2:
                            skip_next = True
                        break
    if sub == "reset":
        for a in args:
            if a in ("--hard", "--soft", "--mixed", "--keep", "--merge") or re.match(r"^(HEAD|@)[~^]", a) or re.match(r"^[0-9a-f]{7,40}$", a):
                deny("'git reset' to another commit rewrites history and is blocked. Unstaging files ('git reset <path>') is fine.")
    if sub in ("checkout", "restore", "switch", "stash", "rm", "mv", "apply", "am", "cherry-pick", "revert", "merge", "pull", "config", "worktree"):
        if sub == "config" and any("hookspath" in a.lower() for a in args):
            deny("Changing core.hooksPath is blocked.")
        for a in args:
            for cand in path_candidates(a):
                rp = ctx.rel(cand)
                if rp is not None and (ctx.dir_holds_protected(rp) or protected_for_main_write(ctx, rp)):
                    deny(f"'git {sub}' on protected files ('{a}') is blocked.")
    return sub


def our_tool(ctx, seg, raw_cmd, single):
    """Rules for our own scripts in .phased/bin."""
    joined = " ".join(seg)
    if "phase.py" in joined and "retest" in seg and ctx.agent:
        deny("Only the main /build session may reopen tests (phase.py retest), "
             "after a fresh test-reviewer agrees the test contradicts the spec.")
    for script, subs in list(GATED.items()) + list(HOOK_ONLY.items()):
        if script not in joined:
            continue
        sub = next((t for t in seg if t in subs), None)
        if sub is None:
            continue
        if sub in HOOK_ONLY.get(script, set()):
            deny(f"'{script} {sub}' is run by Claude Code hooks only.")
        canonical = re.match(rf"^python3? \.phased/bin/{re.escape(script)} {re.escape(sub)}(\s|$)", raw_cmd.strip())
        if not (single and canonical and not re.search(r"[`$;&|<>]", raw_cmd)):
            deny(f"Run this exactly as: python3 .phased/bin/{script} {sub} ... (on its own, no cd, no pipes) "
                 "so Claude Code asks the user to approve it.")
    for script in ("install.py", "self_test.py"):
        if script in joined:
            if ctx.state.get("stage") in ("planning", "spec", "tests", "implementing"):
                deny(f"the build setup's {script} can only run between phases (phase {ctx.state.get('phase')} "
                     f"is in stage '{ctx.state.get('stage')}').")
            same = len(seg) > 1 and seg[0] == "python3" and is_init_script(seg[1], script)
            if not (single and same and not re.search(r"[`;&|<>]", raw_cmd) and "$(" not in raw_cmd):
                deny(f"Run the build setup's {script} on its own, with no pipes, redirects or other commands: "
                     f"python3 <installed build skill dir>/scripts/{script} --project <path>")


def is_runner(ctx, seg):
    cands = [r for r in RUNNERS]
    for c in (ctx.cfg or {}).get("components", []):
        for key in ("test_command", "holdout_command", "lint_command", "typecheck_command"):
            cmd = c.get(key) or ""
            toks = tokenize(cmd) or []
            first = segments(toks)
            if first:
                cands.append(strip_env(first[0])[:2])
    return any(c and seg[:len(c)] == c for c in cands)


def seg_is_safe(ctx, seg):
    if not seg:
        return True
    head = os.path.basename(seg[0])
    if head == "find":
        return not any(t in ("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls") for t in seg)
    if head in SAFE_READ:
        return True
    if head == "git":
        rest = [t for t in seg[1:] if not t.startswith("-")]
        return bool(rest) and rest[0] in SAFE_GIT
    if head.startswith("python") and len(seg) > 1 and \
            os.path.normpath(seg[1]).replace("\\", "/").startswith(".phased/bin/"):
        return True
    if head.startswith("python") and len(seg) > 1 and is_init_script(seg[1]):
        return True  # the build setup's own scripts (install/self_test are additionally gated above)
    return is_runner(ctx, seg)


def check_hidden_reads(ctx, head, seg, roots):
    """The implementing agent must not see hidden (holdout) or prefetched tests through the shell."""
    if head.startswith("python") and len(seg) > 1 and seg[1].startswith(".phased/bin/"):
        return  # our own scripts run hidden tests without showing them
    recursive = head in ("rg", "ag") or (head in ("grep", "egrep", "fgrep") and
                                         any(t.startswith("-") and not t.startswith("--") and ("r" in t or "R" in t)
                                             or t in ("--recursive", "--dereference-recursive") for t in seg[1:]))
    prev = ""
    for t in seg[1:]:
        skip = t.startswith("-") or re.match(r"^--?(exclude|ignore|testPathIgnorePatterns|deselect|x)$", prev)
        prev = t
        if skip:
            continue
        rp = ctx.rel(t.strip("'\""))
        if rp is None:
            continue
        for r in roots:
            if rp == r or rp.startswith(r + "/"):
                deny("Hidden (holdout) and prefetched tests are not readable by the implementing agent.")
            if recursive and (rp in ("", ".") or r.startswith(rp.rstrip("/") + "/")) and Path(ctx.root, r).exists():
                deny(f"This recursive search would include hidden tests ({r}). Search a narrower folder.")
    if recursive and not [t for t in seg[1:] if not t.startswith("-")][1:]:
        if any(Path(ctx.root, r).exists() for r in roots):
            deny("This recursive search (current folder) would include hidden tests. Pass a narrower folder.")


def check_bash(ctx, cmd):
    if re.search(r"--no-verify\b", cmd):
        deny("--no-verify skips the safety hooks and is blocked.")
    if re.search(r"hookspath", cmd, re.IGNORECASE):
        deny("Changing git's hook path is blocked.")
    if re.search(r"(?i)\bgit\b.*\bcommit\b", cmd, re.S) and C.attribution_hits(cmd):
        deny("Commit messages must not carry Claude attribution (co-author or 'Generated with' lines).")
    flat, bodies = split_heredocs(cmd)
    if bodies and not re.search(r"\bgit\b[^;|&]*\bcommit\b", flat):
        # inline scripts / file contents: any protected path inside them is treated as a write
        for body in bodies:
            for word in re.findall(r"[\w.\-~/@+]+", body):
                if "/" not in word and "." not in word:
                    continue
                rp = ctx.rel(word)
                if home_claude_path(word, ctx.cwd) or (rp is not None and protected_for_main_write(ctx, rp)):
                    deny(f"An inline script or heredoc mentions a protected file ('{word}'). "
                         "Tests, specs and guardrail files are changed only through the phased workflow.")
    tokens = tokenize(flat)
    if tokens is None:
        if re.search(r"tests?/|specs/|\.phased|\.githooks|holdout", cmd):
            deny("Could not parse this command safely and it mentions protected paths.")
        return
    segs = segments(tokens)
    single = len(segs) == 1 and not re.search(r"[;&|\n]", cmd)
    has_subst = "$(" in cmd or "`" in cmd
    indirect = has_subst or re.search(r"\$\{?[A-Za-z_]|\beval\b|\bxargs\b|\bsource\b|(^|\s)\.\s", cmd)
    if indirect:
        # variables / eval / xargs can carry a protected path into another command
        for t in tokens:
            for cand in path_candidates(t.split("=", 1)[-1]):
                rp = ctx.rel(cand)
                if home_claude_path(cand, ctx.cwd) or (rp is not None and protected_for_main_write(ctx, rp)):
                    if any(not seg_is_safe(ctx, strip_env(s)) and os.path.basename(strip_env(s)[0]) != "git"
                           for s in segs if strip_env(s)):
                        deny("This command passes a protected path through variables, eval or xargs. "
                             "Use a direct command instead.")
    hidden_roots = [h[:-3] for h in C.holdout_globs(ctx.cfg)] + [".phased/pending"]
    for raw_seg in segs:
        seg = strip_env(raw_seg)
        if not seg:
            continue
        head = os.path.basename(seg[0])
        check_hidden_reads(ctx, head, seg, hidden_roots)
        our_tool(ctx, seg, cmd, single)
        if head == "git":
            git_rules(ctx, seg)  # git has its own rules (paths are checked there)
            for i, t in enumerate(seg):
                if t in (">", ">>", ">|", "&>") and i + 1 < len(seg) and protected_for_main_write(ctx, ctx.rel(seg[i + 1])):
                    deny(f"Writing into '{seg[i + 1]}' is blocked (protected file).")
            continue
        # redirection into protected files
        for i, t in enumerate(seg):
            if t in (">", ">>", ">|", "&>", "<>") and i + 1 < len(seg):
                rp = ctx.rel(seg[i + 1])
                if home_claude_path(seg[i + 1], ctx.cwd) or protected_for_main_write(ctx, rp):
                    deny(f"Writing into '{seg[i + 1]}' is blocked (protected file).")
        if seg_is_safe(ctx, seg) and not has_subst:
            continue
        mentions = []
        for t in seg[1:]:
            for cand in path_candidates(t):
                if home_claude_path(cand, ctx.cwd):
                    deny("Changing ~/.claude (skills, agents, settings) is blocked during the phased workflow.")
                rp = ctx.rel(cand)
                if rp is None:
                    continue
                if protected_for_main_write(ctx, rp):
                    mentions.append(cand)
                elif head in DESTRUCTIVE and ctx.dir_holds_protected(rp):
                    mentions.append(cand)
        if mentions:
            deny(f"'{head}' touching protected files ({', '.join(sorted(set(mentions))[:3])}) is blocked. "
                 "Tests, specs and guardrail files are changed only through the phased workflow.")


# ------------------------------------------------------------------ main

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        deny("Hook input was not valid JSON.")
    ctx = Ctx(data)
    if ctx.cfg is None:
        return  # project not initialised: the guard has nothing to enforce yet
    tool = data.get("tool_name", "")
    CURRENT_TOOL["name"] = tool
    ti = data.get("tool_input") or {}
    if tool in ("Write", "Edit", "MultiEdit"):
        check_write(ctx, ti.get("file_path"))
    elif tool == "NotebookEdit":
        check_write(ctx, ti.get("notebook_path"))
    elif tool == "Read":
        check_read(ctx, ti.get("file_path"), tool)
    elif tool == "Grep":
        check_read(ctx, ti.get("path") or ctx.cwd, tool)
    elif tool in ("Bash", "PowerShell"):
        if ctx.is_writer:
            deny("The test-writer agent does not run shell commands.")
        if ctx.is_kba_writer:
            deny("The kba-writer agent does not run shell commands. The facts are in kba/facts.json.")
        check_bash(ctx, ti.get("command", ""))


if __name__ == "__main__":
    main()
