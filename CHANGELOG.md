# Changelog

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
