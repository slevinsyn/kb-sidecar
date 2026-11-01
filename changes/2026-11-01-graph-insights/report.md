# Report: 2026-11-01-graph-insights

_Written by `.phased/bin/phase.py report` on 2026-11-02T00:08._

| Phase | Title | Size | Model | Minutes | Test files | Review rounds | Bugs found and fixed | Retests | Commit |
|---|---|---|---|---|---|---|---|---|---|
| 08 | Clean topics | medium | sonnet | 4.3 | 3 | 2 | 1 | 0 | e0c156e613 |
| 09 | `kb context` - token-light context for assistants (GraphRAG) | medium | sonnet | 4.3 | 2 | 2 | 1 | 0 | 9ea9520b0b |

| Total | Value |
|---|---|
| Phases done | 2 of 2 |
| Time | about 9 minutes |
| Risk | High -> 2 people approve the merge |
| Old problems seen, not blocking | 1 |

## Problems met and how they were solved

- Phase 08: Ordinary words (meeting, deployment, reviewer, query, invoice, partition, server) must stay topic candidates -> EXTRA_STOP_WORDS holds exactly the spec's word list and nothing more
- Phase 08: A stop word could slip through as a plural (goals, indexes, tries) -> tokenize_clean checks both the original token and its normalised form against STOP_WORDS and EXTRA_STOP_WORDS
- Phase 08: kubernetes and postgres are in TECH_TERMS but normalize_term stripped their trailing "s" before the lookup, so the 1.5 boost never applied and topic names were misspelt -> tokenize_clean now returns TECH_TERMS tokens unchanged, skipping normalisation (spec text and tests are locked, so no new test was added)
- Phase 09: Truncation had to be counted in characters (not bytes) and keep whole lines with the "... [truncated]" marker inside max_chars -> counted with chars().count() and split_inclusive('\n').
- Phase 09: A query word could look like a flag, and flag values must not become query words -> any argument starting with "-" (other than a lone "-") is treated as a flag, so unknown ones exit 2; values are consumed with their flag, and usage errors are checked before graph.json is read.
- Phase 09: A session with duplicate or plural topics (proposal and proposals) could score 3 twice or be counted twice in related topics -> topic matches are collected into a set of normalised forms; related-topic and file counts are per session.
- Phase 09: Review round 1: topic matching normalised stored topics unconditionally while query terms keep tech terms verbatim (kubernetes vs kubernete), losing the topic score and listing the topic as related to itself -> one helper, topic_matches_term (lowercase or normalised form), used in scoring and the related-topics exclusion (spec text and tests are locked, so no new test was added)
