# Low-Memory Mode

Low-Memory Mode is an experimental preview workflow for very long documents
and memory-constrained computers. It avoids keeping Tinymist running while you
write. Typsastra starts Tinymist only when it needs to generate a PDF and a
navigation index, then terminates the process and releases its compiler state.

Use this mode when the normal language server or compiler consumes more memory
than the computer can comfortably keep available. Normal mode remains the
recommended default for projects that benefit from live diagnostics,
completion, formatting, and exact source synchronization.

https://github.com/user-attachments/assets/563b6809-4003-4901-b5ee-4c56ed959d11

## How it works

Low-Memory Mode separates document generation from everyday navigation:

```text
Save or refresh
      |
      v
one-shot Tinymist compilation
      |
      +-- PDF preview
      +-- approximate line-level sync index
      |
      v
Tinymist exits

Editor or PDF navigation
      |
      v
small persistent sync index
      |
      v
preview or editor moves without a resident Tinymist process
```

The index records approximate relationships between source files and rendered
PDF positions. It is designed for paragraph- and line-level navigation, not
exact character placement.

## Enable the mode

1. Open a project and configure its main Typst file.
2. Open **Settings -> Preview**.
3. Enable **Low-Memory Mode**.
4. Save the document or explicitly refresh the preview when a new compilation
   is needed.

The effective render mode becomes **On save** while Low-Memory Mode is active.
Typsastra preserves the project's previous render preference and restores it
when the mode is disabled.

For a guarded large document, confirm opening the main file or one of its
included files once. That approval applies to the shared main-document preview
session.

## Preview and index lifecycle

After a successful save, Typsastra:

1. prepares the private render tree under `.typsastra/cache`;
2. starts a one-shot Tinymist process;
3. compiles the main document PDF;
4. builds an approximate sync index for the main file and reachable includes;
5. stores the PDF and index together; and
6. terminates Tinymist.

The status bar reports whether the index is being prepared, is ready, or failed.
Switching between the main file and included files does not create independent
indexes. They share the configured main document's PDF, index, and preview
position.

Typsastra records a workspace-source signature with the cached result. Closing
and reopening an unchanged project can reuse the cached PDF and index without
compiling or indexing again. Saving a changed source invalidates that snapshot
and prepares a replacement. The previous valid result remains isolated until
the replacement succeeds.

## Forward sync

Low-Memory Mode does not move the PDF whenever you click or move the caret.
This prevents approximate navigation from continually pulling the preview away
from the page you are reading.

To reveal the current source position, use **Reveal Cursor in Preview** from the
editor context menu. Typsastra looks up the nearest indexed line and reveals
that PDF position with the normal forward-sync ripple. If no suitable line
anchor exists, it can fall back to the document outline.

## Inverse sync

Click rendered content in the PDF to navigate back to its approximate source
line. Typsastra compares the clicked page and vertical position with nearby
anchors, opens the corresponding source file when necessary, centers the line,
and shows the editor ripple.

Long paragraphs may map several rendered positions to the same source line.
Generated content, equations, raw blocks, or other syntax that cannot be safely
indexed may resolve to a nearby paragraph or heading instead.

## Multi-file projects

The index belongs to the configured main document, not the currently selected
tab. A single index may contain anchors for `main.typ`, chapter files,
templates, and other reachable local includes. Opening an unrelated Typst file
does not make it part of that preview; include it from the configured main
document or select a different main file.

For best editor performance, keep very large books split into included chapter
files even when Low-Memory Mode is enabled. The mode reduces compiler memory;
it does not remove the cost of displaying and syntax-highlighting one enormous
editor buffer.

## Features intentionally unavailable

Because the persistent language server is stopped, these Tinymist-backed
features are unavailable while Low-Memory Mode is active:

- live LSP diagnostics;
- Tinymist completion and formatting;
- continuous or exact cursor synchronization; and
- other requests that require a resident Tinymist session.

Compiler diagnostics still refresh after an explicit-save compilation. Search
match highlighting and search overview markers are disabled to avoid scanning
and decorating extremely large documents.

## Cache and privacy

Generated PDFs, instrumented sources, and sync indexes remain inside the
project's private `.typsastra/cache` directory. Typsastra does not create a PDF
beside the user's source without confirmation. Temporary indexing processes
and preparation files are cleaned up or replaced through the same cache
lifecycle used by normal preview generation.

If the project directory is synchronized by a cloud-storage client, that client
may still upload `.typsastra` unless the directory is excluded in the provider's
settings.

## Troubleshooting

### The status says the index failed

The PDF may still be usable even when approximate synchronization is not. Save
again after correcting compiler errors. If the document compiles but indexing
continues to fail, capture the **Forward sync** developer log and report the
first indexing error. Complex syntax may currently contain no safe anchor at a
particular location.

### The preview does not update after editing

Low-Memory Mode uses on-save rendering. Save explicitly with `Ctrl+S` (or
`Command+S` on macOS) to request a new PDF and index. Autosave preserves the
file but does not trigger an on-save preview compilation.

### Navigation lands near, but not on, the expected text

This is expected when a source line spans multiple rendered lines or pages, or
when the exact source construct was skipped by the conservative indexer. Use
the nearest paragraph or heading as the navigation target. Switch back to
normal mode when exact Tinymist source mapping is required.

### The project was reorganized outside Typsastra

Reload the project and save the main document so Typsastra can validate the new
workspace layout and generate a matching PDF/index pair. A stale index is never
silently applied to a different PDF generation.

## Current limitations

- The feature is experimental and its cache/index format may change.
- Synchronization is approximate and line-oriented.
- Not every Typst syntax context can be instrumented safely.
- Unsaved line insertions or deletions can make the last compiled index less
  accurate until the next explicit save.
- Initial index generation temporarily uses more memory than the steady-state
  editor because Tinymist must compile and inspect the document once.
- Low-Memory Mode reduces resident compiler memory; it does not guarantee low
  memory use for unusually large editor buffers, PDFs, or decoded images.

