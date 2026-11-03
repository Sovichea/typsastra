# Draft Preview and image guidance

This example exercises the image-heavy authoring workflow without bundling a
pathological image.

## Try it

1. Set `main.typ` as the main file.
2. Compile in **Normal** preview and note the original images.
3. Switch the preview toolbar toggle to **Draft**.
4. Hover over each placeholder to inspect its cached thumbnail, original
   dimensions, and source size.
5. Click a placeholder to inverse-sync to its direct `image(...)` call.
6. Put the editor cursor in an image call and press `Alt+Enter` on Windows or
   Linux, or `Option+Enter` on macOS, to forward-sync.
7. Replace an image path with a high-resolution raster of your own to exercise
   the gutter, Problems, and preview-toolbar warnings.
8. Export a PDF and confirm that export uses the original images.
9. Open **Image Tools** in the sidebar, select a bundled raster asset, adjust
   resize or output-format settings, and preview the comparison.
10. Choose **Save Optimized Copy** under a new name. If you enable reference
    updates, Typsastra updates all indexed exact static references; it does not
    overwrite the original or update only one selected occurrence.

The bundled assets are intentionally modest. A high-resolution or pathological
image has a decoded pixel workload disproportionate to its displayed size.
Such an image may be only a few megabytes on disk yet consume much more memory
when decoded, slowing Typst compilation, Tinymist, PDF loading, and page
rendering.

Draft substitution covers standalone image calls, common images inside clipped
blocks, and same-file helper chains that forward the path and width or height.
A helper that wraps `image()` in a `figure()` or derives the path dynamically
may remain unchanged. Other compositions can produce different placeholder
geometry or interaction.
