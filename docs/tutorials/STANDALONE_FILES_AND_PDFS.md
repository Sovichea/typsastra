# Standalone files and PDF tools

Typsastra can open supported files without first opening a project. This keeps
quick edits and reading tasks available while preserving the richer shared-main
preview workflow for multi-file documents.

## Standalone Typst and Markdown files

Open a `.typ`, `.md`, or `.markdown` file directly from the system file manager
or use **File → Open File**. Standalone mode keeps the editor and application
menu, but hides project-only tools and project chrome. A standalone Typst file
with no local includes can use a private single-file preview cache. A document
with local dependencies is recommended for promotion to a project so its full
file tree can be compiled and synchronized.

Within an open project, supported off-project files can be opened in temporary
tabs beside project files. They don't become project dependencies or replace the
configured main document.

Markdown receives sanitized live preview with workspace-bound local resources.
See [Markdown live preview](MARKDOWN_PREVIEW.md) for supported content and
security boundaries.

## Direct PDF viewing

Open a PDF in Typsastra to use the in-app viewer. The viewer virtualizes rendered
pages and provides page navigation, zoom, color modes, document outline when
available, internal and external links, and text search.

For text-based PDFs, drag to select logical text and copy it as plain or
formatted text. The selection model maps displayed glyphs back to extracted
Unicode text, preserves paragraph boundaries and supported formatting, and
keeps multi-codepoint complex-script clusters together. Image-only scanned pages
do not become searchable text automatically; Typsastra does not perform OCR.

Hold the platform modifier key while hovering over the PDF to reveal link
targets. Click an internal PDF link to navigate within the document. PDF text
selection and links are separate interactions; a regular drag selects text,
while the modifier activates links.

<video controls preload="none" playsinline width="100%">
  <source src="https://github.com/user-attachments/assets/508ff81f-525e-48cf-9674-a60a1e6d52f2" type="video/mp4">
  Your browser cannot play the embedded video. <a href="https://github.com/user-attachments/assets/508ff81f-525e-48cf-9674-a60a1e6d52f2">Open the standalone PDF viewer demo.</a>
</video>

## Exporting

**Export PDF** writes the current compiled output to a user-selected destination.
PDF export is separate from the live preview and asks before creating or
replacing a user-facing PDF in the project. **Export Source ZIP** creates a
font-free source snapshot; **Export Typsastra Project** creates a version-bound
`.typsastra` archive with integrity metadata and exact toolchain versions. See
[Project import and export](PROJECT_IMPORT_AND_EXPORT.md).

An optional **Enhanced Unicode PDF engine** can be enabled under Settings →
Developer for explicit PDF exports. It is experimental and affects export only;
live preview, diagnostics, completion, and source synchronization remain owned
by Tinymist. See the [engine validation guide](../ENHANCED_UNICODE_ENGINE_VALIDATION.md)
for its requirements and known text-extraction limitations.

<video controls preload="none" playsinline width="100%">
  <source src="https://github.com/user-attachments/assets/f4730ab5-437f-4dbb-af4b-cb21c7cde3e3" type="video/mp4">
  Your browser cannot play the embedded video. <a href="https://github.com/user-attachments/assets/f4730ab5-437f-4dbb-af4b-cb21c7cde3e3">Open the Unicode PDF export demo.</a>
</video>

Large PDF files require explicit confirmation before decoding and rendering.
Large Typst files and aggregate previews have a corresponding confirmation
before editor initialization or compilation.
