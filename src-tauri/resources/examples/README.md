# Typsastra examples

This workspace is a writable learning copy installed in a versioned folder in
your Documents directory, such as `Typsastra Examples v0.10.1`. Open
`START-HERE.typ` for the recommended order.

Each application release creates and opens its own examples folder. A newer
release never overwrites, migrates, or reuses an older version's writable copy.
Within one version, Typsastra may restore a missing bundled file, but it
preserves files you have edited.

The examples are organized by capability rather than by release number:

- `01-basics` covers markup, mathematics, and diacritic-aware search.
- `02-multilingual-writing` covers document-script fonts, spellcheck,
  completion, complex-script shaping, and direction samples.
- `03-language-providers` covers bundled, optional, and unavailable language
  providers.
- `04-research-projects` contains complete multi-file articles, theses, and
  books.
- `05-project-portability` explains main documents, workspace state, and
  font-free export.
- `06-preview-and-media` covers Normal/Draft preview, image helper chains,
  preview navigation, private fonts, and Markdown notes.
- `07-editor-workflows` covers project search and replacement, unsaved-work
  recovery, the shared outline, Back/Forward navigation, and document-language
  defaults.
- `08-tools-and-templates` covers project-owned Table Tools blocks and project
  creation from templates.

Each non-trivial example documents its prerequisites and expected result. Some
font families and language dictionaries are optional and are never bundled into
an exported project. Missing optional dictionaries are intentionally visible in
the language-provider examples so you can test installation and unavailable
provider behavior.

The source remains ordinary Typst. Generated PDFs, preview caches, downloaded
providers, recovery snapshots, and font binaries do not belong in this
workspace's bundled source.

Start with the published [Typsastra documentation](https://docs.typsastra.com/).
Its tutorials explain the workflows demonstrated in these examples. The
[tutorial sources](https://github.com/Sovichea/typsastra/tree/main/docs/tutorials)
remain available in the repository.

## Featured exercises

The `07-editor-workflows/01-project-search-and-recovery` notebook is the
current search, replacement, recovery, outline, and navigation tour. It contains
three files so project search can group results by file and reviewed replacement
can show before/after lines across files.

The `06-preview-and-media/02-image-helper-chains` example demonstrates inverse
sync through nested image helper functions. Clicking the rendered image selects
the outermost helper call that supplied the path, and Draft Preview replaces
that same call with a layout-preserving placeholder. Helper width and height
parameters are forwarded into the placeholder layout.

The `07-editor-workflows/02-language-defaults` example separates a project's
script-language assignments from **Settings → Language → Default document
languages**, which seeds new projects.

The `06-preview-and-media/05-markdown-notes` example opens as Markdown rather
than Typst. It exercises the sanitized Markdown renderer, GFM structures,
workspace links and images, mixed scripts, and blocked remote resources.

The Basics section includes a diacritic-aware search fixture for testing exact
accent matching, accent-insensitive matching, replacement ranges, and the
preservation of complex-script marks.

## Preview and media

The `06-preview-and-media` section provides exercises for:

- Draft Preview, cached image hover cards, and image diagnostics;
- nested image helper chains in Normal and Draft preview;
- manual forward sync, inverse sync, and internal or external preview links;
- private local font directories and ordered Typst font fallback;
- Markdown live preview and its sanitized resource boundary.

The examples do not bundle pathological images or private fonts; use your own
assets when you want to test those machine-specific workflows. See the
[Draft Preview](https://docs.typsastra.com/tutorials/DRAFT_PREVIEW/),
[preview synchronization](https://docs.typsastra.com/tutorials/PDF_PREVIEW_AND_SYNC/),
[Image Tools](https://docs.typsastra.com/tutorials/IMAGE_TOOLS/),
[Markdown live preview](https://docs.typsastra.com/tutorials/MARKDOWN_PREVIEW/),
and [Document Typography](https://docs.typsastra.com/tutorials/DOCUMENT_TYPOGRAPHY/)
guides.

## Editor workflows

The `07-editor-workflows` section provides exercises for:

- project-wide literal, regex, and fuzzy search with filters;
- reviewed replacement across files, including per-match exclusions and undo;
- unsaved-work snapshots and unified-diff recovery;
- the shared main-document outline and the tab-list menu;
- Back/Forward source navigation across search, outline, definitions,
  diagnostics, inverse sync, and Explorer opens;
- project language assignments and global defaults for new projects.

See the [project search](https://docs.typsastra.com/tutorials/PROJECT_SEARCH/),
[editor productivity](https://docs.typsastra.com/tutorials/EDITOR_PRODUCTIVITY/),
[Explorer and projects](https://docs.typsastra.com/tutorials/EXPLORER_AND_PROJECTS/),
and [multilingual spellcheck](https://docs.typsastra.com/tutorials/MULTILINGUAL_SPELLCHECK/)
tutorials.

## Tools and templates

The `08-tools-and-templates` section provides exercises for:

- recovering a missing Table Tools model from its generated block;
- creating the Basic table sample and linking it to a `//@table:` anchor;
- editing headers, styles, rules, merged cells, captions, and data imports;
- exporting and importing a table as portable `.typ` source;
- browsing Typst Universe, downloaded, and user templates;
- saving a project as a reusable user template.

The table example intentionally ships generated source without a stored table
model. The editor gutter offers to recreate the model or unlink the anchor,
which is the same recovery path used when project metadata is lost. See the
[Table Tools](https://docs.typsastra.com/tutorials/TABLE_TOOLS/) and
[project templates](https://docs.typsastra.com/tutorials/PROJECT_TEMPLATES/)
guides.

## Inspect machine-local project storage

1. Compile or preview any bundled example.
2. Open **Settings → Storage**.
3. Find the examples workspace and review its generated-file count, total size,
   hard-linked bytes, and genuinely copied bytes.
4. Use the explicit reveal action to inspect the machine-local cache directory.

The generated cache should not appear inside this examples workspace. A hard
link may have multiple filesystem paths while sharing one underlying storage
allocation, so its apparent file size is not additional copied storage.

Legacy-cache migration is not manufactured by these examples. Typsastra asks
for consent when it encounters a real older `.typsastra/cache`; cancelling must
preserve that directory and stop the project from opening.
