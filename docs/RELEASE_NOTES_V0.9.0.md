# Typsastra v0.9.0 release notes

Typsastra v0.9.0 adds a full table authoring tool and a template-based way to
start new projects. It also updates the bundled Khmer segmenter and fixes
preview synchronization and tool-pane behavior.

## Table Tool

- Added a Tables sidebar tool that builds Typst tables from a spreadsheet-style
  grid with rows, columns, multi-row headers, a header column, footers, and
  repeat flags.
- Added per-cell content, horizontal and vertical alignment, emphasis, fill,
  text color, inset, rotation, and page-break control, plus merged cells.
- Added row and column tracks, gutter, explicit horizontal and vertical rules,
  and the default, report, banded-row, banded-column, and booktabs styles.
- Added spreadsheet-style row numbers, column letters, and a select-all control
  to select whole rows, columns, or the table for formatting and deletion.
- Added sort, transpose, and CSV/TSV import from pasted text or a file.
- Linked tables into documents with `//@table:<id>` directives: the gutter icon
  opens the builder, edits sync back into the linked block, and manual linking
  is supported by typing the directive where the table should appear.
- Added lossless `.typ` export and import, including a portable sidecar so a
  table round-trips exactly, with a strict fallback for handwritten tables.
- Added preview zoom with fit-to-width, Ctrl/Cmd+wheel, and toolbar controls.

## Create New Project from templates

- Added a **Create New Project** welcome action with **All templates**,
  **Downloaded**, and **User templates** tabs plus a blank project option.
- **All templates** lists searchable Typst Universe templates with thumbnails and
  a link to the Typst Universe template gallery. Creating a project downloads and
  caches the template as a multi-directory `.typsastra` archive.
- **Downloaded** reuses cached templates offline, and **User templates** manages
  local `.typsastra` files with automatically rendered first-page thumbnails.
- Templates are always stored as `.typsastra` archives, and projects are created
  as ordinary multi-directory projects.

## Image Tools

- Added non-destructive crop to the optimized copy: select a region over the
  preview with draggable handles, resize or move it, or reset to the full image.
  The crop is applied before resizing and the source image is never modified.
- Saving an optimized copy now selects and previews the saved copy even when
  static image paths are not replaced.

## Language tools

- Updated the bundled Khmer segmenter to v0.3.2, adding reviewed phrase-collision
  typo exclusions and out-of-vocabulary `unknown_word` diagnostics.

## Preview and workspace fixes

- Clicking the live preview to inverse-sync no longer re-scrolls the preview, and
  clicking in the editor no longer scrolls the PDF. Cursor sync remains off.
- The undocked preview window is no longer docked when inverse sync activates a
  tab.
- Table Tools keeps the table explorer visible and blocks the sidebar toggle,
  matching Image Tools.

## Compatibility and known limitations

v0.9.0 does not change the `.typsastra` project archive schema. Existing v0.8.x
projects remain compatible. Automatic preview scrolling on cursor movement
(Cursor sync) remains disabled pending the v0.9.x reliability work.
