# Draft Preview

Draft Preview reduces the cost of iterating on image-heavy Typst documents. It
replaces supported static raster `image()` calls in Typsastra's private render
mirror with placeholders that preserve the image's layout dimensions. The
project source, original images, and exported PDFs are not rewritten.

## Switch preview modes

Use the **Normal / Draft** control in the live preview toolbar. Normal mode
renders the original images. Draft mode shows lightweight placeholders while
keeping their measured dimensions and positions in the document. Switch back to
Normal before export or final visual review; PDF export uses original assets.

<video controls preload="none" playsinline width="100%">
  <source src="https://github.com/user-attachments/assets/b1c45806-8747-4180-8e52-dbe8222f82db" type="video/mp4">
  Your browser cannot play the embedded video. <a href="https://github.com/user-attachments/assets/b1c45806-8747-4180-8e52-dbe8222f82db">Open the Draft Preview demo.</a>
</video>

Hover over a draft image placeholder to inspect a bounded cached thumbnail and
its original dimensions and encoded size. Missing or unsupported images retain
their layout space and report a diagnostic rather than silently shifting the
document.

## Image analysis and optimization

The preview toolbar and editor gutter can warn about raster assets whose
decoded pixel dimensions or encoded size are unusually large. These are
recommendations only: Typsastra does not silently resize or recompress source
assets. Use [Image Tools](IMAGE_TOOLS.md) to preview and save an optimized copy
explicitly.

## Cache and project behavior

Draft image work is stored in Typsastra's machine-local project render cache,
keyed to the configured main document and content mode. Source files remain the
authority. Generated thumbnails can be discarded and rebuilt without changing
the project.

The mode is shared across included files because they belong to the main
document's preview. Opening an included chapter does not create a separate
Draft Preview session or change the PDF page position.

## Limitations

Draft Preview only replaces supported static raster image references that can
be resolved inside the project. Dynamic paths, plugin-generated content, remote
resources, or unsupported image formats may remain unchanged. Inspect the
preview diagnostics when a specific image was not replaced.
