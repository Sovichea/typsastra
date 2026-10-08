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

The Outline pane is built from the active Typst document. Select a heading to
navigate to its source. Pane focus and keyboard navigation let you move between
the editor, preview, Explorer, Outline, and Spellcheck without reaching for the
mouse.

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
