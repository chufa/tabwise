# Changelog

## Unreleased - 2026-11-07

### Features

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

- Extract resource collection, scheduling and navigation revision tracking into a background module.
- Prefer durable reservations after incomplete session mirror writes; compare state independently of storage key order.
- Restore the recorded tab when requests originate from an extension dashboard.
- Strengthen backup encryption defaults, reject malformed site policies, and bound persisted history.
- Retain recovery records after ambiguous browser effects or failed final bookkeeping; refuse new suspensions near local quota.
- Commit retry/resume successor reservations atomically and show superseded task links.
- Reject stale sync previews, retain empty local policy choices, and recover local commits without multiplying conflict copies.
- Use static module imports for MV3 worker sync paths; preserve local trash and workspace page tags during incremental updates.

### Tests

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
