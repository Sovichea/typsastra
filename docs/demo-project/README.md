# Typsastra documentation demo project

Open this folder as a project in Typsastra. The configured main document is
[`main.typ`](main.typ); it includes four chapter files, two local raster images,
two Fletcher diagrams, and a CeTZ canvas so the Explorer, Image Tools, and
multi-file preview have useful content.

## Explore the project

1. Open `main.typ` and inspect the PDF preview. It includes the files under
   `chapters/` and the images under `assets/`.
2. Switch to **Image Tools**, select either image, and inspect its dimensions,
   references, crop controls, and optimization preview.
3. Open `chapters/04-diagrams.typ` and switch the preview between **Normal** and
   **Draft**. Draft replaces the two Fletcher diagrams and the CeTZ canvas with
   labeled placeholders while preserving their layout.
4. Switch to **Table Tools** and select the **Basic table** already stored in
   this demo project's configuration. Its ID matches the `//@table:basic_table`
   anchor in `main.typ`, and its generated Typst block is synchronized there.
5. Change a table cell and inspect the live preview update.
6. Open **Search Project** and search for `research` to see matches across the
   main document and chapters. Enter a replacement and use **Review** to inspect
   the before/after changes before applying them.
7. Edit a chapter, wait for the unsaved-work snapshot, and reopen the project to
   review the recovered text as a unified diff. Restoring opens an unsaved
   buffer; it does not overwrite the source file.

The project declares Latin script → English (United States) in
`.typsastra/config.json`, so the language status and spellcheck tools have a
usable default. New projects inherit this assignment from **Settings → Language →
Default document languages**.

## Follow the guides

- [Getting started](../tutorials/GETTING_STARTED.md) covers opening this project
  and working with its main document.
- [Explorer and projects](../tutorials/EXPLORER_AND_PROJECTS.md) explains its
  included chapters and project files.
- [Image Tools](../tutorials/IMAGE_TOOLS.md) walks through the bundled images.
- [Draft Preview](../tutorials/DRAFT_PREVIEW.md) compares the Fletcher and CeTZ
  placeholders with their rendered diagrams.
- [Table Tools](../tutorials/TABLE_TOOLS.md) uses the linked **Basic table** in
  this project.
- [Editor and PDF preview](../tutorials/EDITOR_AND_PREVIEW.md) describes the
  shared main-document preview.
- [Standalone files and PDFs](../tutorials/STANDALONE_FILES_AND_PDFS.md) explains
  the optional Enhanced Unicode Engine used for explicit PDF export. See also
  the [engine validation guide](../ENHANCED_UNICODE_ENGINE_VALIDATION.md).

The project contains ordinary Typst source and image files. Table state is
created by the tool and stored in the local `.typsastra/config.json` project
metadata when opened; generated preview caches remain machine-local.
