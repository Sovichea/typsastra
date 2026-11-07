# Typsastra v0.9 release notes

Typsastra v0.9 introduced the Table Tool and template-based project creation,
then expanded standalone authoring, programmable shortcuts, completion,
language-provider compatibility, and preview performance through v0.9.6. This
page consolidates the v0.9 line; detailed patch notes remain linked below.

## Table Tool

- Added a spreadsheet-style grid with rows, columns, multi-row headers, a header
  column, footers, merged cells, alignment, emphasis, fill, text color, inset,
  rotation, and page-break control.
- Added row and column tracks, explicit rules, and the default, report, banded,
  and booktabs styles.
- Added CSV/TSV import, sorting, transposition, and lossless `.typ` export and
  import.
- Linked tables into documents with `//@table:<id>` directives; the builder stays
  synchronized with the generated block.
- Added Tables sidebar search, filters, keyboard navigation, and cross-project
  link resolution.

## Templates and project creation

- Added Create New Project with Typst Universe, downloaded, user `.typsastra`,
  and blank project sources.
- Cached templates as portable multi-directory archives and created ordinary
  multi-directory Typst projects.

## Standalone files and shortcuts

- Open Typst and Markdown files without creating a project, including temporary
  tabs beside project files.
- Promote a standalone document and its local dependencies into a full project.
- Added programmable keyboard shortcuts with a recorder, collision checks,
  two-key chords, and reset controls.
- Added a dedicated Spellcheck pane beside the document Outline.

## Editing and completion

- Completed import and image paths inside quotes and refreshed suggestions as
  each path component was typed.
- Marked declared-but-unused Typst bindings and added Surround With presets.
- Toggled `*`, `_`, and backtick wrappers around selections.
- Fixed selection wrapping, paste fallback, completion, highlighting, and Log
  Console clear-button defects.
- Used Khmer provider word boundaries for double-click selection.
- Accepted legacy Hunspell encodings and additional LibreOffice spelling
  variants, and opened missing providers from document-language settings.
- Scanned nested folders for private fonts.

## Preview and reliability

- Reduced file-opening and tab-switching delays.
- Reused live previews when returning from images, standalone PDFs, tools, and
  non-project files; kept unsaved edits outdated instead of compiling on
  navigation.
- Preserved the viewport across tab switches, recompilation, and project reopen.
- Improved external-edit recovery, compiler-failure recovery, and minimized
  window restoration.
- Scoped preview freshness and diagnostics to the configured main document and
  cleared stale diagnostics after source changes.
- Added live-preview search, configurable zoom, a source-status indicator, and
  an undocked outline navigator.
- Kept the preview from re-scrolling after inverse sync, preserved undocked
  previews when tabs activate, and kept the Table Tools explorer visible.

## Platforms and packaging

- Added Linux ARM64 bundles for Raspberry Pi.
- Added a native Windows ARM64 MSI.
- Fixed Linux packaging and release-build warnings.

## Compatibility

v0.9 does not change the `.typsastra` project archive schema. Existing v0.8.x
projects remain compatible.

## Patch history

- [v0.9.0](RELEASE_NOTES_V0.9.0.md)
- [v0.9.1](RELEASE_NOTES_V0.9.1.md)
- [v0.9.2](RELEASE_NOTES_V0.9.2.md)
- [v0.9.3](RELEASE_NOTES_V0.9.3.md)
- [v0.9.4](RELEASE_NOTES_V0.9.4.md)
- [v0.9.5](RELEASE_NOTES_V0.9.5.md)
- [v0.9.6](RELEASE_NOTES_V0.9.6.md)
