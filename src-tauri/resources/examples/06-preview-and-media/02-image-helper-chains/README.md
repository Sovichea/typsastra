# Image helper chains

This example demonstrates two current preview behaviors that matter in real
projects:

- inverse sync follows an image path forwarded through nested helper functions
  and selects the outermost call that supplied the path;
- Draft Preview substitutes the same outer call with a layout-preserving
  placeholder.

## Try it

1. Set `main.typ` as the main file and compile in **Normal** preview.
2. Double-click the large icon, or use the inverse-sync modifier. The editor
   should select `#cover("assets/typsastra-icon.png")` rather than the reusable
   `image(src, width: width)` inside `framed`.
3. Repeat with the wordmark. Its width is supplied by `wordmark()` and forwarded
   through `plate()`.
4. Change the `width` default on `cover()` to another value and confirm that
   Draft Preview uses the resolved width for the placeholder.
5. Switch the preview toolbar to **Draft**. Both figures should show
   placeholders while preserving their helper-defined widths.
6. Hover a placeholder to inspect its cached thumbnail and original dimensions.
7. Put the cursor on a helper call and press `Alt+Enter` (`Option+Enter` on
   macOS) to forward-sync to the preview.
8. Temporarily change one path to `./assets/typsastra-icon.png`. Typsastra
   underlines the path and offers **Use root path**. Revert the change when you
   are done so the example stays portable.

Inverse sync follows forwarded parameters, renamed parameters, defaults, named
arguments, closures, and calls in reachable Typst files. It deliberately leaves
a call unchanged when more than one call site could have supplied the image.

Draft Preview resolves same-file helper chains and forwards helper `width` and
`height` parameters into the placeholder. A helper that wraps `image()` in a
`figure()` or derives the path dynamically may remain unchanged in Draft mode
even though inverse sync can still follow its path. Use Normal preview when
reviewing those layouts.

Draft Preview and inverse sync do not rewrite the source, the original raster
assets, or exported PDFs.
