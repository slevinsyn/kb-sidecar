# Report: 2026-11-01-graph-map

_Written by `.phased/bin/phase.py report` on 2026-11-02T00:50._

| Phase | Title | Size | Model | Minutes | Test files | Review rounds | Bugs found and fixed | Retests | Commit |
|---|---|---|---|---|---|---|---|---|---|
| 10 | Explorer analysis - communities, rank, bridges, gaps, timeline | large | opus | 5.6 | 2 | 1 | 0 | 0 | 913cb8229e |
| 11 | Offline insights - executive summary, roadmap, Markdown export | medium | sonnet | 2.0 | 2 | 1 | 0 | 0 | 8d31ca122e |
| 12 | Explorer UI - 2D labelled community map, insights panel, month filter | medium | sonnet | 7.9 | 2 | 1 | 0 | 0 | 98cf4a41df |

| Total | Value |
|---|---|
| Phases done | 3 of 3 |
| Time | about 16 minutes |
| Risk | Medium -> 1 person approves the merge |
| Old problems seen, not blocking | 0 |

## Problems met and how they were solved

- Phase 10: Spec says firstAt/lastAt/latestAt are the "smallest/largest started_at string", which is ambiguous for timestamps with time-zone offsets -> compared by Date.parse time, with the raw string as tie-break (same result for UTC ISO strings)
- Phase 10: Louvain "ties: lower community index" can make a node bounce between equal-gain communities forever -> a node moves only on a strictly positive gain strictly better than staying put (epsilon 1e-10), ties go to the lower index, plus a cap on passes
- Phase 10: PageRank on a star graph flips back and forth when run for the default 50 iterations -> checked that the leftover error (about 8e-5) is well inside the 3-decimal tolerance and kept the default the spec gives; the result is normalised so it sums to 1
- Phase 10: Spec does not say how pageRank treats noisy edges -> it uses the same edge filter as louvain (unknown endpoints, self-loops and non-positive or non-finite weights dropped; parallel edges add up)
- Phase 10: Spec says "label ascending" without saying how -> plain code-unit string compare (no locale, no lowercasing) so the order is deterministic
- Phase 11: Spec headline rule gives "2025-03 to 2025-03" when the timeline has a single bucket -> kept the literal spec (first and last timeline month), no special case, since the spec does not define one
- Phase 11: Spec wording "Bridges: <l1>, <l2>, <l3> link separate themes." reads wrongly with one bridge -> kept the fixed wording as specified and tested; only the label list shrinks
- Phase 11: "Recent" says "at or before latestAt", so a date after latestAt is ambiguous -> treated as not recent (date <= latestAt and latestAt - date <= 30 days), which keeps the exact-30-day edge inclusive and 31 days out
- Phase 11: Recent focus ties and community order in hand-built analyses -> compared by lower community id explicitly instead of relying on array order
- Phase 11: Share must divide by all session nodes in the graph, not only sessions inside communities -> counted session nodes from the graph directly, guarded against S = 0
- Phase 11: Pipe characters in theme labels break the Markdown table -> escaped "|" as "\|" in table cells only
- Phase 12: Spec does not say whether orphan pruning (files, tools, topics or projects with no link to a kept session) applies without a month range -> applied it with or without a range, but only when 'session' is among the visible types.
- Phase 12: Spec does not say what happens to sessions with a missing or invalid started_at -> they are dropped only when a from or to month is set, and kept when no range is set. "Invalid" means: not a string, Date.parse gives NaN, or the first 7 characters are not YYYY-MM.
- Phase 12: Phase 10 timeline month key is d.slice(0,7), so non-ISO dates could give odd month keys -> the From/To selects only offer keys matching /^\d{4}-\d{2}$/.
- Phase 12: tsc --noEmit failed with TS2591 on node:fs and node:url in tests/view.test.ts -> added "node" to the tsconfig types.
- Phase 12: First 2D render showed the whole graph tiny in the middle of the canvas -> cooldownTicks(250) plus zoomToFit on onEngineStop, only after a data change.
- Phase 12: 2D canvas sat under the left-hand panels, so zoom-to-fit hid clusters behind them -> the 2D container starts at x=324px and width2d() accounts for it. The 3D view still uses the full width.
- Phase 12: force-graph's default node and link tooltips read labels as HTML -> nodeLabel returns escapeHtml(label) and linkLabel returns ''. Everything else is built with textContent. Checked with a session labelled <img src=x onerror=alert(1)>: it shows as text, 0 img elements were injected, no dialog.
- Phase 12: main.ts was patched twice with a script instead of the Edit tool (small changes); tsc and the gate pass.

## Suggested REVIEW.md lines (same bug type in 2+ phases)

- Check for: none
