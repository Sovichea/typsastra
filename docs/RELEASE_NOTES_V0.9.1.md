# Typsastra v0.9.1 release notes

Typsastra v0.9.1 is a maintenance release. It finishes the Table tool's sidebar
so it behaves like the Image tool, fixes several editor completion and
highlighting defects, repairs the Log Console's Clear button, and fixes Linux
packaging. It also adds Linux ARM64 bundles for Raspberry Pi.

## Table Tool

- Added a search box and a filter to the Tables sidebar, matching the Images
  panel: **All tables**, **Current document**, **Referenced elsewhere**, and
  **Unused**.
- Added keyboard navigation to the Tables list. Arrow keys, Home, and End move
  the selection, Enter opens the table in the builder, and the selection ring now
  follows the caret instead of stopping after the first press.
- Fixed the Tables list showing no selection indicator at all.
- Table links now resolve across the whole project rather than only the open
  documents. A table linked from a file that happens to be closed was previously
  reported as unused, which made the filters misleading. The **Linked from** row
  in the builder now names the file, line, and column of the `//@table:<id>`
  directive.
- The builder reports why a link lookup failed instead of showing an unlinked
  table when the project could not be scanned.
- When a table is deleted in the builder, its `//@table:<id>` directive now shows
  a warning in the editor gutter. Clicking it offers to **recreate** the table,
  rebuilt from the generated source still present in the document and reusing the
  existing id when one is already taken, or to **unlink** the directive and its
  managed markers while keeping the table.
- Split the builder's controls into a cell toolbar and a table toolbar, each
  labelled with the scope it edits. The cell toolbar is dimmed while nothing is
  selected, a mixed selection now reports as **Mixed** instead of the focus
  cell's value, and the caption position moved beside the caption text.

## Editor fixes

- Fixed completion inside a call rejecting a bare identifier argument, so a local
  such as `timeline` was offered in `#render-project-timeline-chart( time|)`.
- Fixed completion of a bare member typed inside a call. `table.hea` inside
  `#table(...)` was not recognised as a member access and offered nothing.
- Fixed accepting such a completion reusing the edit range captured when the
  request opened, which stranded the text typed since and could produce
  `table.header()hea`.
- Fixed completion of a value inside a string producing broken Typst: the closing
  quote went missing or the call bracket was doubled. The edit is now normalized
  so a string is always closed exactly once and a bracket is only added when the
  document lacks it.
- Fixed the double quote key deciding by string state rather than always stepping
  over a following quote, and fixed a quote before the caret opening a nested
  pair that left three quotes in the document.
- Fixed syntax highlighting after a nested hash expression. A `#` expression
  inside another one, such as a set rule in a content block, cleared the
  enclosing statement when it ended and the rest of the line fell back to markup
  styling.

## Log Console

- Fixed the Clear button appearing to do nothing. Entries flagged for the problem
  and severity counters were all treated as un-clearable, so every developer log
  line survived a clear. Compiler and preview failures are still preserved,
  because the subsystem that owns them re-reports them when it resolves.
- Fixed two defects that hid developer log entries: they were appended without the
  counted flag and so were filtered out of every rendered list, and the completion
  trace skipped any line without a hash.

## Linux packaging

- Fixed the AppImage's `.DirIcon` and `.desktop` entry being created as absolute
  symlinks into the build directory, which broke once the AppImage was mounted
  and caused appimage.github.io to reject the catalog entry. The Tauri CLI is
  pinned to 2.11.5, which writes relative symlinks, and the release now inspects
  the built AppImage and fails if either symlink is missing or absolute.
- Added Linux ARM64 bundles, producing `aarch64` `.deb` and `.AppImage` packages
  for Raspberry Pi.

## Compatibility and known limitations

v0.9.1 does not change the `.typsastra` project archive schema. Existing v0.9.0
and v0.8.x projects remain compatible.

Automatic preview scrolling on cursor movement (Cursor sync) remains disabled
pending the v0.9.x reliability work.

The table filters depend on a project-wide scan of every Typst file, so the
active Tinymist session is restarted when a document's table directives change,
keeping every compiler path on the same state.
