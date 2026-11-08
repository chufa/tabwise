# Changelog

## Unreleased - 2026-11-08

### Features

- Reorganize the workbench into Tasks, Pages, Resources and History with focused page tools and persistent drafts across navigation.
- Split task editing into progress, sources and AI continuation; add local task search and preserve selected sources after saving notes.
- Keep popup tab search and quick actions separate from organizing/saved tools, and group settings into five task-oriented categories.
- Reveal advanced workspace filters/actions, statistics and operating explanations on demand; unify theme tokens, focus states and responsive layouts.
- Add a shared real-model adapter for task continuation and theme organization, supporting loopback Ollama and HTTPS OpenAI-compatible Chat Completions.
- Allow user-supplied service/model configuration, model listing, synthetic JSON self-checks and optional JSON mode; ship no endpoint/model presets.
- Store endpoint-bound BYOK credentials separately in trusted session storage by default, with explicit unencrypted local persistence and clearing.
- Add local task memory with goals, progress, confirmed notes, questions, selected sources and manually supplied excerpts.
- Generate editable, cited continuation drafts using browser models or loopback Ollama with full sanitized input previews and explicit adoption.
- Export task context as cited Markdown or JSON and resume selected sources through the durable on-demand restore ledger.
- Persist restore and batch task ledgers across browser restarts, clear stale browser bindings, and allow completed task archival.
- Add on-demand workspace restoration and configurable concurrency from one to five pages.
- Support domain idle thresholds, one-hour protection, and session protection.
- Add workspace tags, local notes, favorites, and saved filters; include public metadata in sync conflict detection while preserving local notes.
- Track requested backup downloads, optional reminders, and bounded verification drill summaries.
- Show bounded local suspension counts, restoration completion latency, and sampled pre-suspension JS heap evidence.
- Add off/low/normal adaptive sampling, per-workspace restore presets, page tags and tag-based restore selection.
- Add explicit duplicate consolidation and credential-free HEAD link checks with scoped previews, safe search highlighting, and favorite shortcuts.
- Preview selected sync workspaces with bounded chunked payloads, checksums, and compatible legacy reads.

### Reliability

- Fix toolbar popup intrinsic sizing: remove the viewport-relative body maximum, keep the 410px width and 600px height cap, and prevent header/navigation wrapping.
- Resolve omitted native-popup sender document IDs from the unique browser-reported POPUP context; retain document-bound previews and reject stale previews after reopening.
- Reveal the destination before executing palette commands, discard stale search commands immediately, and locate invalid fields across hidden settings/task steps.
- Accept view fragments only on the exact trusted extension document while preserving origin/path/query and document-ownership checks.
- Invalidate model previews and theme cache on provider, endpoint, model, JSON mode or credential revision changes.
- Bound model response sizes and output budgets, abort cancelled/time-limited requests, reject truncation, and never echo provider error bodies or retry paid requests automatically.
- Redact embedded URLs, email addresses and common credentials in theme titles/goals while retaining original local browser identities; prevent settings edits until initial state is loaded.
- Separate task memory from browser job ledgers and sync; enforce optimistic revisions, bounded local capacity, trusted storage access and sidepanel document ownership.
- Invalidate pending continuation snapshots on cancellation, input edits or worker restart; preserve confirmed user notes and mark adopted drafts stale after changes.
- Extract resource collection, scheduling and navigation revision tracking into a background module.
- Prefer durable reservations after incomplete session mirror writes; compare state independently of storage key order.
- Restore the recorded tab when requests originate from an extension dashboard.
- Strengthen backup encryption defaults, reject malformed site policies, and bound persisted history.
- Retain recovery records after ambiguous browser effects or failed final bookkeeping; refuse new suspensions near local quota.
- Commit retry/resume successor reservations atomically and show superseded task links.
- Reject stale sync previews, retain empty local policy choices, and recover local commits without multiplying conflict copies.
- Use static module imports for MV3 worker sync paths; preserve local trash and workspace page tags during incremental updates.

### Tests

- Exercise actual action popup targets with native pointer/keyboard events in Chromium and Edge, including layout, search, filters, batch previews, command routing, workspace saves and close/reopen ownership.
- Add real Chromium/Edge UI checks for view transitions, draft/search retention, keyboard focus, hidden-field validation and all routes in light/dark narrow/desktop layouts.
- Add compatible API browser coverage for task/theme generation, HTTP errors, cancellation, credential access, backup exclusion and session/local restart behavior.
- Extend isolated Ollama validation from a JSON probe to a cited continuation task with edited adoption and Markdown export.
- Cover task persistence, scoped source revalidation, provider/schema checks, late result rejection, storage failure, dirty edits, local exports and selected task restoration in Chromium and Edge.
- Cover feature controls, on-demand restoration without original-site requests, and full browser restart without task replay.
- Capture screenshots and worker diagnostics with bounded timeouts on E2E failures.
- Add matched real Chromium baseline/extension measurements using isolated synthetic pages.
- Test quota/offline failures, permission denial, real worker termination, selected sync UI and tagged restore presets; add isolated installed-Edge smoke tests.

## 0.2.2 - 2026-11-04

### Fixes

- Enable page heap sampling by default and refresh stale values when the tab list opens.
- Show latest page memory directly in tab rows without requiring a manual diagnostics action.
- Request webpage access at installation so automatic sampling is available immediately.

## 0.2.1 - 2026-11-04

### Fixes

- Show latest JavaScript heap measurements directly in tab rows after user-approved sampling.
- Refresh session-only page memory snapshots with the one-minute suspension check.
- Clear stale measurements when a tab navigates or closes.

## 0.2.0 - 2026-11-04

### Features

- Add local page-memory search in the Side Panel and Chrome omnibox.
- Add optional Renderer memory diagnostics for Chrome Dev and Canary.
- Add selectable placeholder and native-discard suspension strategies.

### Performance

- Reuse one activity snapshot during automatic suspension scans.
- Stop refreshing suspension timing while placeholder tabs are not visible.

### Tests

- Add headless Chromium extension end-to-end coverage for search, recovery, grouping, settings, and resource-diagnostic fallback.
