# Typsastra documentation demo project

Open this folder as a project in Typsastra. The configured main document is
[`main.typ`](main.typ); it includes three chapter files and two local raster
images so the Explorer, Image Tools, and multi-file preview have useful content.

## Explore the project

1. Open `main.typ` and inspect the PDF preview. It includes the files under
   `chapters/` and the images under `assets/`.
2. Switch to **Image Tools**, select either image, and inspect its dimensions,
   references, crop controls, and optimization preview.
3. Switch to **Table Tools** and select the **Basic table** already stored in
   this demo project's configuration. Its ID matches the `//@table:basic_table`
   anchor in `main.typ`, and its generated Typst block is synchronized there.
4. Change a table cell and inspect the live preview update.

## Follow the guides

- [Getting started](../tutorials/GETTING_STARTED.md) covers opening this project
  and working with its main document.
- [Explorer and projects](../tutorials/EXPLORER_AND_PROJECTS.md) explains its
  included chapters and project files.
- [Image Tools](../tutorials/IMAGE_TOOLS.md) walks through the bundled images.
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
