# Editor productivity features

Typsastra includes editing tools aimed at long Typst documents and complex
scripts. These controls are designed to preserve normal text entry while making
navigation, correction, and review explicit.

## Search and document navigation

The search panel supports document-wide find and replace, diacritic-aware
matching, and navigation to visible matches before scrolling far through a long
file. Search matches are highlighted in the editor and represented in the
scrollbar overview. Search state is reset when switching projects so a previous
document's selection cannot leak into the new workspace.

Search is diacritic-aware and navigates visible matches first. Match positions
are summarized along the editor scrollbar. Compiler diagnostics and spellcheck
issues have their own gutter/scrollbar markers and can be navigated without
moving the PDF unexpectedly.

Use [Search a project](PROJECT_SEARCH.md) to search every UTF-8 source file in
the workspace, including unsaved open buffers. Project search supports literal,
regex, and fuzzy matching, include/exclude globs, and a separate activity-bar
panel that leaves the editor and preview visible.

The Outline pane shows the pinned main Typst document and its includes when the
main file or one of its included files is active. Other project Typst files show
a file-only outline for editor navigation; their own includes are not expanded
until they are pinned as the main document. While a file in the main document
is active, including the main file itself, headings from other files are muted so
the active file's headings stand out. Select a heading to open its source and
scroll the PDF to that heading.

A file included more than once appears at each inclusion point, and headings keep
stable identities based on their source file, so reordering includes does not
change which item is selected or expanded. The Outline pane shows only headings.
Includes that cannot be indexed are reported in the Log console: missing files,
dynamic includes, and include cycles appear as warnings, while local `.typ`
modules referenced with `#import` are informational because imported Typst
modules are not expanded. Only literal `#include` directives are indexed.

Back and Forward at the left of the tab bar, and in the Edit menu, return to
previous source locations from project search, the outline, definitions,
diagnostics, inverse sync, Explorer file opens, and tab selections. They default
to `Alt+Left` and `Alt+Right` and can be changed in **Settings → Shortcuts**.
Returning to a location restores its selection and editor viewport without
recompiling the preview or moving the PDF. History is kept for the current
session and is cleared when the project closes. Scroll the tab bar with the
wheel or trackpad; the chevron at its right edge opens a list of every open tab.

Pane focus and keyboard navigation let you move between the editor, preview,
Explorer, Outline, and Spellcheck without reaching for the mouse.

## Unsaved-work recovery

Typsastra snapshots unsaved text while you edit, including dirty tabs that are
not currently active. Snapshots are written after a short idle pause and at
least every five seconds during continuous typing. They live outside the
project and are separate from preview caches.

After an unexpected shutdown, opening the affected project offers its available
snapshots. The recovery prompt is not shown automatically at application startup,
and snapshots belonging to other projects are not included. Each file can be
reviewed, restored as an unsaved buffer, or discarded. If the file changed on
disk, review the unified diff before restoring; only changed hunks and nearby
context are shown, with additions and removals highlighted. Deleted files reopen
as dirty buffers so they can be kept with Save As. Saving removes only the
matching snapshot revision; newer unsaved edits are retained. Corrupt records are
reported separately and do not block other files.

## Typst-aware editing

- **Surround With** discovers available functions and wrappers from Typst
  metadata and wraps the current selection.
- Contextual quote pairing and selection wrapping avoid leaving duplicate or
  mismatched quotes around existing source.
- Bracket-pair editing can wrap or replace selected text; the behavior is
  configurable and remains aware of the active selection.
- Code folding preserves only folds explicitly made by the author. Automatic
  folds are not serialized as user intent.
- Per-tab undo history is restored when switching between open documents.
- **Show ZWS** makes zero-width spaces visible while editing script-sensitive
  text; it changes presentation, not the underlying Typst source.
- Tinymist references can mark `#let` functions and variables that have no other
  references in the current workspace. The dotted underline is a hint, not an
  error; a symbol may still be part of an API used by a project outside the
  current workspace.
- Drag images from Explorer into a Typst document, or paste an image from the
  clipboard. Typsastra saves a collision-safe project asset and inserts a
  relative Typst image reference.
- **Surround With** uses Typst function metadata and explicit content wrappers;
  it does not offer arbitrary functions that cannot accept content.
- The completion catalog uses Tinymist metadata when ready and retains a local
  fallback so common Typst completions do not depend on a live network lookup.

<video controls preload="none" playsinline width="100%">
  <source src="https://github.com/user-attachments/assets/990277b9-b9df-4154-b6b5-bba293f07dc4" type="video/mp4">
  Your browser cannot play the embedded video. <a href="https://github.com/user-attachments/assets/990277b9-b9df-4154-b6b5-bba293f07dc4">Open the drag, drop, and paste images demo.</a>
</video>

For complex scripts, cursor movement, deletion, selection, and composition can
follow a language's editing policy rather than treating each UTF-16 code unit as
an independent character. Khmer is the reference implementation; see
[Language tools](../LANGUAGE_TOOLS.md) and
[Khmer spellcheck](../KHMER_SPELLCHECK.md).

## Shortcuts

Open **Settings → Shortcuts** to record or change application commands. Typsastra
supports two-stroke shortcuts as well as single-key combinations, detects
conflicts before saving, and allows all shortcut overrides to be reset. On
macOS, the UI displays Command and Option labels; on Windows and Linux it uses
Control and Alt.

## Saving and recompile semantics

Auto-save and explicit Save have different effects:

- **Auto-save** writes dirty file contents at the configured interval. It does
  not run Format on save, send a Tinymist save notification, or request an
  On-save preview compile.
- **Save** (`Ctrl+S` / `Cmd+S`) is an author action. It applies Format on save
  when enabled, notifies Tinymist, and requests an On-save preview update.
- **Recompile** restarts the active Tinymist session and rebuilds the preview
  while preserving its viewport where possible.

External changes are watched and reconciled with open tabs. When an agent writes
a replacement file through a temporary sibling and rename, Typsastra checks the
path's current filesystem state before notifying Tinymist, so a replaced file
isn't incorrectly reported as deleted.
