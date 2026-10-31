# Typsastra v0.10.0 release notes

Typsastra v0.10.0 completes the multi-file navigation, editing, and recovery
work planned for this release, and adds built-in interface localization and
global document-language defaults.

## Project search and replacement

- Search the current project from the sidebar with literal, regular-expression,
  or fuzzy matching.
- Filter by include/exclude globs, case, whole words, diacritics, ignored files,
  or the pinned main document and its reachable sources.
- Review results grouped by file with line numbers and highlighted excerpts;
  selecting a result opens and selects the match without moving the PDF.
- Replace selected matches across files with a before/after review. Unsafe
  grapheme-splitting matches are rejected, and stale files abort the whole batch.
- Undo a replacement batch while every affected buffer still matches its output.

## Shared main-document outline

- The project outline now follows the configured main document, including while
  an included chapter is active.
- Headings from other files are muted so the active file's headings stand out.
- Outline selection and expansion survive tab changes and main-file updates.

## Source navigation

- Back and Forward navigate source locations across search, outline,
  definitions, diagnostics, inverse sync, Explorer opens, and tab selections.
- Navigation restores the editor selection and viewport without recompiling the
  preview or moving the PDF.
- The tab bar scrolls horizontally, and its menu lists every open tab.

## Unsaved-work recovery

- Typsastra snapshots unsaved editor text, including inactive dirty tabs and
  pathless untitled buffers.
- Recovery snapshots live outside the project and are reviewed through a unified
  diff before restoring.
- Restored files open as unsaved buffers; source files are never overwritten
  automatically.
- Corrupt records are reported separately and do not block valid snapshots.

## Language settings

- The interface can be localized through built-in locale catalogs. English
  remains the source locale.
- **Settings → Language → Default document languages** defines the script-language
  assignments used by new projects. Latin defaults to English (United States).
- Existing projects keep their own assignments in `.typsastra/config.json`.

## Distribution

- Added Chocolatey, Scoop, and AUR packaging metadata generated from published
  release assets.
- The AppImage build now uses Tauri CLI 2.12 so the packaged launcher is
  executable for all users.

## Compatibility

v0.10.0 does not change the `.typsastra` project archive schema. Existing
projects remain compatible. Recovery data and generated preview caches stay in
machine-local application storage.

Windows installers remain unsigned, so SmartScreen may warn on first launch. The
macOS build remains unsigned and unnotarized; use the targeted Gatekeeper
workaround in the [installation guide](INSTALL.md#open-an-unsigned-macos-release).
