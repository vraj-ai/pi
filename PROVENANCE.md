# Provenance

Third-party code in this package, what was taken, and how it was changed.
`scripts/check-provenance.mjs` verifies that every file listed here still
carries its attribution header, and `scripts/update-upstream.mjs` re-fetches an
upstream and reports what moved.

## oh-my-pi — `packages/stats` → `extensions/usage-stats`

| | |
|---|---|
| Upstream | <https://github.com/can1357/oh-my-pi> |
| Path | `packages/stats` |
| Licence | MIT, © 2025-2026 Can Bölük; © 2026 Stencil Labs, Inc. |
| Vendored as | **PI Usage Statistics** (`extensions/usage-stats`) |

The full licence text is kept at `extensions/usage-stats/LICENSE-oh-my-pi`.

### What was ported

| Upstream file | Here | Change |
|---|---|---|
| `src/shared-types.ts` | `src/shared-types.ts` | Same dashboard payload shapes and the same six ranges. Dropped `premiumRequests` and `serviceTier` (no pi equivalent); added `totalReasoningTokens` (pi reports it) and a `LimitSource` discriminator. |
| `src/parser.ts` | `src/parser.ts` | Rewritten for pi's session JSONL. Pi carries per-message `usage` and a `cost` breakdown, so upstream's price table is gone. Duration is *derived* from entry timestamps and bounded at both ends; upstream reads provider-reported `duration`/`ttft`, which pi does not record, so TTFT is absent rather than faked. Agent type comes from pi's `session_info` name instead of the transcript path. |
| `src/db.ts` | `src/db.ts` | Same schema shape, indexes, and aggregate queries. Storage is `node:sqlite` (built into Node 22) rather than `bun:sqlite`. Schema-version mismatch rebuilds instead of migrating. |
| `src/aggregator.ts`, `src/sync-worker.ts` | `src/sync.ts` | Same incremental byte-offset strategy: historical full walk, live tail-only re-read, restart-from-zero on truncation. |
| `src/usage-windows.ts` | `src/usage-windows.ts` | Same window/insight maths (`fractionConsumed`, `estTokensPerWindow`, `peakConcurrentFraction`, `idealAccounts`). Upstream sources snapshots from its own auth store; pi's auth store records none, so snapshots come from provider rate-limit response headers (`reported`) or from configured plan budgets (`estimated`), and every row is labelled. |
| `src/gain-aggregator.ts` | `src/gain.ts` | Same per-source/per-day aggregation. Upstream's only source is its `snapcompact`; here the sources are pi's real ones: the `output-compress` extension and pi's context compaction. |
| `src/server.ts` | `src/server.ts` | Same route set. `node:http`, loopback-only, falls back to an ephemeral port when the default is taken. |
| `src/client/**` (React + Chart.js + Tailwind, ~40 files) | `src/client.ts` | Same ten sections and six ranges, rebuilt as one self-contained page with plain DOM and inline SVG. A bundler would have been the single largest dependency in a repo whose only build step is `tsc --noEmit`. |
| `src/user-metrics.ts` | folded into `src/parser.ts` | The behavioural signal set (yelling, profanity, anguish, negation, repetition, blame) and the per-100-message rate. |

### Not ported

- **Premium requests and service tiers** — no pi equivalent.
- **TTFT** — pi's session log does not record it. Reporting a derived TTFT would be a guess presented as a measurement.
- **Fork deduplication** — upstream dedupes forked transcripts; pi's session tree makes each branch its own file, so the `UNIQUE(session_file, entry_id)` constraint already covers it.

## agent-stuff — Armin Ronacher

| | |
|---|---|
| Upstream | <https://github.com/mitsuhiko/agent-stuff> |
| Licence | Apache-2.0, © Armin Ronacher |

The full licence text, with the list of derived files required by section 4(b),
is kept at `extensions/session-tools/LICENSE-agent-stuff`.

| Upstream file | Here | Change |
|---|---|---|
| `extensions/no-sleep.ts` | `extensions/session-tools/src/no-sleep.ts` | Same `caffeinate` approach and process-tied assertion. Added a Linux `systemd-inhibit` path, made the platform lookup and the spawn injectable, and moved the state behind a class so it is testable without a real inhibitor. |
| `extensions/continue.ts` | `extensions/session-tools/index.ts` | The `shift+alt+enter` "send continue when idle" shortcut, including the `isIdle()` reasoning. Added a `/continue` command alias. |

## my-pi

`extensions/` in this package descends from the author's own earlier `my-pi`
package; it is the same author's work and needs no separate licence.
