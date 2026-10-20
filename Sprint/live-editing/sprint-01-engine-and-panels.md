# Sprint 01 — tex2word 1.0.8, e2e harness, collapsible panels

## Goal

Confirm the web UI works on the new tex2word release, add a browser test
harness the later sprints can build on, and let the editor use the full width.

## 1. tex2word 1.0.8

- The full pytest suite passes unchanged on 1.0.8.
- `tests/e2e/smoke.e2e.js` drives the core flows in Chromium: version chip,
  new project → preview → convert → download a valid `.docx` (zip), a
  multi-file project with `\input` and a forward `\ref` across files,
  Markdown import → convert → round-trip back to LaTeX, the coverage dashboard.
- Real arXiv sources (1706.03762, 2010.11929, 1810.04805; 11–23 files each)
  import and convert cleanly — they were also the stress corpus for sprint 02.
- `pyproject.toml` now requires `tex2word>=1.0.8`.
- Engine quirks found along the way are listed in [README](README.md#engine-notes-tex2word-108).

## 2. Collapsible, resizable side panels

| Action | Files (left) | Report / Structure / Assistant (right) |
| --- | --- | --- |
| Hide | chevron in the pane header, **Ctrl/Cmd+B**, double-click the edge | chevron, **Ctrl/Cmd+Alt+B**, double-click the edge |
| Show | the rail's chevron or "FILES" label | the rail's chevron, or a tab icon (opens that tab) |
| Resize | drag the edge (160–480 px) | drag the edge (280–720 px) |

A collapsed pane becomes a 38 px rail. Widths and collapsed state persist per
browser (`localStorage["tw_layout"]`, guarded); on a first visit narrower than
1100 px the right pane starts collapsed. Shortcuts use `KeyboardEvent.code`, so
they work with Option on macOS.

**Tests** — `tests/e2e/panels.e2e.js`: buttons and rail tabs, both shortcuts,
persistence across reload, drag-resize with clamping, double-click collapse.
