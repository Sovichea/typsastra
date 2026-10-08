# Typsastra examples

This workspace is a writable learning copy installed in a versioned folder in
your Documents directory, such as `Typsastra Examples v0.9.3`. Open
`START-HERE.typ` for the recommended order.

Each application release creates and opens its own examples folder. A newer
release never overwrites, migrates, or reuses an older version's writable copy.
Within one version, Typsastra may restore a missing bundled file, but it
preserves files you have edited.

Each non-trivial example documents its prerequisites and expected result. Some
font families and language dictionaries are optional and are never bundled into
an exported project. Missing optional dictionaries are intentionally visible in
the language-provider examples so you can test installation and unavailable
provider behavior.

The source remains ordinary Typst. Generated PDFs, preview caches, downloaded
providers, and font binaries do not belong in this workspace's bundled source.

Start with the published [Typsastra documentation](https://docs.typsastra.com/).
Its tutorials explain the workflows demonstrated in these examples. The
[tutorial sources](https://github.com/Sovichea/typsastra/tree/main/docs/tutorials)
remain available in the repository.

The Basics section includes a diacritic-aware search fixture for testing exact
accent matching, accent-insensitive matching, replacement ranges, and the
preservation of complex-script marks.

## v0.6.0 showcase

The `06-v0.6-feature-showcase` section provides short exercises for:

- Draft Preview, cached image hover cards, and image optimization diagnostics;
- manual forward sync, inverse sync, and internal or external preview links;
- private local font directories and ordered Typst font fallback.

These complement the existing multilingual and research projects. The examples
do not bundle pathological images or private fonts; use your own assets when you
want to test those machine-specific workflows.
See the [Draft Preview](https://docs.typsastra.com/tutorials/DRAFT_PREVIEW/),
[preview synchronization](https://docs.typsastra.com/tutorials/PDF_PREVIEW_AND_SYNC/),
and [Document Typography](https://docs.typsastra.com/tutorials/DOCUMENT_TYPOGRAPHY/)
guides for the workflows demonstrated here.

## v0.7.0 showcase

The `07-v0.7-feature-showcase` section provides exercises for:

- sanitized Markdown live preview, GFM content, workspace links, mixed scripts,
  local images, and blocked remote resources;
- Image Tools inspection and Save Optimized Copy using the bundled v0.6 raster
  assets;
- theme-aware search matches and exact scrollbar-marker navigation;
- shared preview position across main and included source tabs;
- machine-local cache accounting and reveal actions in the Storage panel.

See the [Markdown live preview](https://docs.typsastra.com/tutorials/MARKDOWN_PREVIEW/),
[Image Tools](https://docs.typsastra.com/tutorials/IMAGE_TOOLS/), and
[Toolchain and storage](https://docs.typsastra.com/tutorials/TOOLCHAIN_AND_STORAGE/)
guides alongside these exercises.
