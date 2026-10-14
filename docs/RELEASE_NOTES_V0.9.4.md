# Typsastra v0.9.4 release notes

Typsastra v0.9.4 improves contextual Typst completion and workspace reliability,
and adds more editor feedback and selection tools.

## Typst editing and completion

- Import and image paths offer completions immediately inside quotes, refresh
  suggestions as each path component is typed, and keep the menu open while
  results update.
- Typst bindings that are declared but unused are marked in the editor.
- Typing `*`, `_`, or backticks around a selection toggles the matching wrapper.
- Surround With adds common alignment, paragraph, figure, block, and text-style
  presets.

## Workspace and preview reliability

- Workspace image changes and included drafts refresh more reliably.
- Preview recovery handles unready source-map sessions more robustly.
- Private font discovery scans nested folders.
- Completion avoids unnecessary language-server requests for unused bindings.

## Compatibility

v0.9.4 does not change the `.typsastra` project archive schema. Existing projects
remain compatible.
