# Arrange the 3D graph like a collection of neurons - Knowledge base article

Waddaya Solutions Private Limited · KBA · 2026-11-02-graph-neurons

| Field | Value |
|---|---|
| Article ID | KBA-2026-11-02-graph-neurons |
| Type | How-to (it explains how the neuron look was built and how to use or switch it off) |
| Version | 1.0 |
| Date | 2026-11-02 |
| Status | Complete (the browser check was not run, see Verification) |
| Risk level | Low - no human approval once every check passes |
| Phases | 2 of 2 |
| Commits | 3753ea5, 6629192 |

## Summary in plain words
The 3D graph showed each theme (a group of related nodes) as one blob. We wanted it to look like a set of neurons (brain cells). Each theme now has one big "cell body", which is its top topic. The theme's other nodes sit around it like branches. Links between two different themes are drawn as long curves, like axons (the long fibres of a neuron). A "Neuron look" tick box, on by default, turns the look off and gives the old 3D picture back. Automated tests prove the maths and the wiring. The visual check in a browser was not run in this session and still needs a manual look.

## When to use this article (trigger)
- You need to know how the 3D neuron look works, or why a node sits where it does.
- You must change the numbers (cell size, curve amount, branch radius).
- The 3D picture looks wrong and you want to switch the look off or undo it.
- You are changing the 3D view and must not break the neuron look.

## Prerequisites and access
- Git access to branch `build/graph-3d` (the open pull request).
- Node tools in the `explorer` folder, and Rust tools for the core.
- Commands recorded for this change:
  - core-rust test: `cargo test --quiet`
  - core-rust lint: `cargo clippy --quiet -- -D warnings`
  - explorer-javascript test: `npx vitest run --exclude 'tests/holdout/**'`
  - explorer-javascript type check: `npx tsc --noEmit`
- The code lives in `explorer/src/scene3d.ts` (the maths) and the app shell (the wiring). The shell file name is not recorded.

## Procedure
| # | Time | What we did | Why | Evidence / screenshot |
|---|---|---|---|---|
| 1 | 2026-11-02 17:28 | Wrote the plan (change file) for this change. | To agree what to build, its risk (Low) and the two phases. | Plan event recorded |
| 2 | 2026-11-02 17:30 | Plan approved for phases 19 and 20. | Work may only start on an approved plan. | Approve-plan event recorded |
| 3 | 2026-11-02 17:30 | Phase 19 started. Its five acceptance criteria (AC-19-01 to AC-19-05) were approved ahead of time. | The criteria say what "done" means. | Spec approved (pre-approved) |
| 4 | 2026-11-02 17:33 | Spec review for phase 19. | A second check before building. | Verdict PASS |
| 5 | 2026-11-02 17:33 | Wrote tests first and proved they fail (2 test files). | A test that never failed proves nothing. | "TypeError: axonCurve is not a function"; hidden tests "8 failed \| 100 passed (108)" |
| 6 | 2026-11-02 17:34 | Built phase 19: pure maths for the cell per theme, branch spots and axon curves. The gate was run. | Maths with no screen code can be tested on its own. | Gate attempt PASS |
| 7 | 2026-11-02 17:35 | Review round 1 for phase 19. | Independent look at the code. | PASS, 0 Important findings |
| 8 | 2026-11-02 17:35 | Committed phase 19. | Save the work. | Commit 3753ea5 |
| 9 | 2026-11-02 17:36 | Phase 20 started. Criteria AC-20-01 to AC-20-04 approved ahead of time. | Same as step 3. | Spec approved (pre-approved) |
| 10 | 2026-11-02 17:44 | First review of phase 20. | Check before tests and build were locked in. | Verdict FAIL (reason not recorded) |
| 11 | 2026-11-02 17:50 | Second review of phase 20. | Re-check after changes. | Verdict FAIL (reason not recorded) |
| 12 | 2026-11-02 17:52 | Third review of phase 20. | Re-check after changes. | Verdict PASS |
| 13 | 2026-11-02 17:52 | Wrote phase 20 tests first and proved they fail (2 test files). | Same as step 5. | "expected 0 to be greater than or equal to 1"; hidden tests "4 failed \| 110 passed (114)" |
| 14 | 2026-11-02 17:53 | Built phase 20: bigger glowing cells, branch forces, curved axon links, "Neuron look" tick box. The gate was run. | Use the maths in the real 3D view. | Gate attempt PASS |
| 15 | 2026-11-02 17:55 | Review round 1 for phase 20. | Independent look at the code. | PASS, 0 Important findings |
| 16 | 2026-11-02 17:55 | Committed phase 20. | Save the work. | Commit 6629192 |
| 17 | 2026-11-02 17:55 | Report written. | Close the change. | Report event recorded |

No screenshots were recorded for this change.

## Errors and how they were solved
| # | Time | What went wrong | Cause | How it was solved | How to avoid it next time |
|---|---|---|---|---|---|
| 1 | 2026-11-02 17:30 (phase 19) | The spec left open how a link gets its bend direction. | Spec gap. | Used a 32-bit FNV-1a hash (a small fixed hashing recipe) of "source>target", scaled into [0, 2*PI). The result is always the same and never reaches 2*PI. | Name the hash in the spec. |
| 2 | 2026-11-02 17:30 (phase 19) | A theme with no topics has no top topic to be the cell. | Edge case. | Such a theme has no cell body. All its nodes become branches. | List this case in the spec. |
| 3 | 2026-11-02 17:30 (phase 19) | Risk that branch spots shift when filters change. | `branchOffsets` numbers spots from the ids it is given. | Noted that phase 20 must pass the full unfiltered id list. | Always pass the full id list. |
| 4 | 2026-11-02 17:36 (phase 20) | Branch spots would jump when filters or the time-lapse change the visible nodes. | Spots depend on which ids are passed in. | `branchOffsets` is computed once per loaded graph from all node ids, unfiltered. | Compute positions from the full data, not the visible part. |
| 5 | 2026-11-02 17:36 (phase 20) | Bigger cells must not make the picture brighter. | Bigger cells could add glare. | The halo is forced on for cells, but ring and emissive (self-light) levels still come from `glowLevels`, so the glow caps are unchanged. | Keep glow limits in one place. |
| 6 | 2026-11-02 17:36 (phase 20) | Toggling the tick box would not change the picture. | The 3D graph library only rebuilds node objects and curves when the accessors are set again. | The tick-box handler clears the node looks, re-sets `nodeThreeObject`, `linkCurvature` and `linkCurveRotation`, reinstalls the forces, then calls `d3ReheatSimulation`. | Re-set the accessors after any look change. |
| 7 | 2026-11-02 17:44 | Phase 20 review returned FAIL. | Not recorded. | Not recorded. Passed on the third review at 17:52. | Not recorded. |
| 8 | 2026-11-02 17:50 | Phase 20 review returned FAIL again. | Not recorded. | Not recorded. Passed at 17:52. | Not recorded. |
| 9 | 2026-11-02 17:55 | Browser check of AC-20-02 to AC-20-04 was not run. | Not done in this session. | Open item: needs a manual look in the preview. | Run the preview check before merging. |

No gate attempt failed (one PASS per phase). No retests were needed. No Important review findings were raised.

## Verification
- Tests failed first, then passed:
  - Phase 19: hidden tests showed 8 failed, 100 passed before the build.
  - Phase 20: hidden tests showed 4 failed, 110 passed before the build.
  - Pass counts after the build are not recorded, but each gate attempt returned PASS (phase 19 at 17:34, phase 20 at 17:53).
- Review verdicts:
  - Phase 19: spec review PASS; review round 1 PASS with 0 Important findings.
  - Phase 20: two FAIL reviews, then PASS; review round 1 PASS with 0 Important findings.
- Not verified: the browser check (AC-20-02 to AC-20-04) was not run in this session. Open the preview and check three things. Cells look bigger. Links between themes curve. Unticking "Neuron look" restores the old picture.

## How to undo
- Quick: untick "Neuron look" in the 3D controls. This gives exactly the earlier 3D picture.
- Full: revert the two phase commits, 6629192 and 3753ea5.
- There is no data, dependency, `graph.json` or ingest change to undo.

## Words explained
| Word | Meaning in plain English |
|---|---|
| Theme (community) | A group of related nodes in the graph. |
| Node | One item in the graph, such as a topic or a session. |
| Cell body | The big node of a theme: its top-ranked topic. It is drawn 2.2 times larger. |
| Branch | Any other node of a theme, placed on rings around the cell (12 per ring). |
| Axon | A curved link between two different themes (curvature 0.3). |
| Halo / glow | The soft light around a node. |
| Emissive | How much a surface lights itself. |
| Phase | One slice of the work, built and checked on its own. |
| Acceptance criteria (AC) | Written rules that say when a phase is done. |
| Gate | An automatic check run before work can move on. All tests must pass. |
| Failing first (red) | Writing tests and seeing them fail before the code exists. |
| Hidden test | A test kept apart from the builder and run by the check. |
| Review round | One independent read of the code, giving PASS or FAIL. |
| Important finding | A review point serious enough to need a fix. |
| Commit | A saved snapshot of the code in git. |
| Pull request | A request to merge the branch into the main code. |
| FNV-1a hash | A small recipe that turns text into a fixed number. |
| Reheat (`d3ReheatSimulation`) | Tells the layout engine to move the nodes again. |
| Revert | Undo a commit by adding a new commit that cancels it. |
