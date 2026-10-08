# Feature guide

Typsastra is a desktop authoring environment around ordinary Typst projects. Use
this guide to find a feature area, then open its tutorial for a task-by-task
walkthrough.

## Project and document work

- [Explorer and projects](tutorials/EXPLORER_AND_PROJECTS.md) — open a workspace,
  manage files and tabs, and set the main document.
- [Create from templates](tutorials/PROJECT_TEMPLATES.md) — browse cached/online
  Universe templates and reusable user templates.
- [Editor and PDF preview](tutorials/EDITOR_AND_PREVIEW.md) — edit source, choose
  preview behavior, navigate pages, and synchronize source with the PDF.
- [Editor productivity](tutorials/EDITOR_PRODUCTIVITY.md) — search, shortcuts,
  Typst-aware editing, drag/drop and paste, and save/recompile behavior.
- [Standalone files and PDFs](tutorials/STANDALONE_FILES_AND_PDFS.md) — open
  individual documents and use PDF reading, search, selection, and copy tools;
  opt into the experimental Unicode export engine when needed.
- [Long-document workflow](tutorials/LONG_DOCUMENT_WORKFLOW.md) — use large-file
  guardrails, on-save rendering, and long-project organization.
- [Project import and export](tutorials/PROJECT_IMPORT_AND_EXPORT.md) — share a
  portable `.typsastra` archive.

## Visual authoring tools

- [Image Tools](tutorials/IMAGE_TOOLS.md) — inspect, crop, optimize, and replace
  project image references.
- [Table Tools](tutorials/TABLE_TOOLS.md) — build and edit structured tables,
  import data, and synchronize generated Typst.
- [PDF preview and source synchronization](tutorials/PDF_PREVIEW_AND_SYNC.md) —
  configure color, page navigation, links, and source mapping.
- [Low-Memory Mode](tutorials/LOW_MEMORY_MODE.md) — compile long documents with
  a one-shot compiler and indexed navigation.
- [Draft Preview](tutorials/DRAFT_PREVIEW.md) — preview image-heavy documents
  with layout-preserving image placeholders.
- [Document typography](tutorials/DOCUMENT_TYPOGRAPHY.md) — configure fonts and
  script-specific typography.
- [Toolchain and storage](tutorials/TOOLCHAIN_AND_STORAGE.md) — manage Tinymist,
  private fonts, local caches, WebView storage, and compatibility settings.

## Language and writing support

- [Multilingual spellcheck](tutorials/MULTILINGUAL_SPELLCHECK.md)
- [Keyboard language completion](tutorials/KEYBOARD_LANGUAGE_COMPLETION.md)
- [Language provider installation](tutorials/LANGUAGE_PROVIDER_INSTALLATION.md)
- [Markdown live preview](tutorials/MARKDOWN_PREVIEW.md)

## Behaviors that are easy to miss

- **One main-document preview:** included chapters share the configured main
  document's compiler, PDF, page position, and source map. Switching tabs does
  not start unrelated chapter previews.
- **Script editing is independent from fonts:** cursor movement, deletion,
  spellcheck, and completion are separate capabilities. A font choice does not
  silently select a language provider.
- **External edits are reconciled:** project file changes are read from disk,
  synchronized to open editor/LSP documents, and cause the preview to refresh.
  Replacement-by-rename events are checked against current disk state before
  being reported to Tinymist.
- **Generated data stays out of source:** render mirrors, PDFs, source maps,
  Draft thumbnails, and scaled-font variants are kept in machine-local caches.
  Portable project archives intentionally exclude font binaries and generated
  output.
- **Author intent is explicit:** large documents require confirmation before
  editor/compiler initialization; image optimization previews never overwrite
  originals; and exporting a PDF requires an explicit destination.

See the [demo project](demo-project/README.md) for a small workspace that
combines included chapters, local images, Khmer text, and a linked table.
