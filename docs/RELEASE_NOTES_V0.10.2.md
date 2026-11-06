# Typsastra v0.10.2 release notes

Typsastra v0.10.2 extends Draft Preview to Fletcher diagrams and CeTZ canvases,
improves manual recompilation and source navigation, and adds workflow polish
for new projects and the welcome screen.

## Draft diagrams and canvases

- Draft Preview replaces supported Fletcher diagrams and CeTZ canvases with
  layout-preserving placeholders using their measured dimensions.
- Diagram placeholders show their kind and source line. Hovering a placeholder
  reveals a cached thumbnail without adding the diagram to the draft document.
- Thumbnails compile on a blank page, so project headers, page numbers, and
  background rules do not leak into hover previews.
- Diagram placeholders reuse the last measured size after an edit, and Draft
  Preview recompiles automatically only when a new measurement differs from the
  size already shown. Unchanged diagrams no longer need a second compile, and no
  manual recompile is required.
- The documentation demo project now includes the Fletcher flowchart and
  commutative-diagram examples plus a CeTZ unit-circle canvas.
- The status bar reports image and diagram thumbnail progress separately, such
  as `Images 5/10` and `Diagrams 10/100`.
- Thumbnail preparation prioritizes visible pages and reprioritizes pending work
  when the preview scrolls.
- Diagram thumbnails scale between one and four Tinymist workers according to
  the available logical processors. One worker uses roughly 45 MiB in the
  recorded Windows development environment.

## Preview behavior

- Manual Recompile now forces a fresh compilation instead of restoring a cached
  PDF for an unchanged workspace.
- Switching between Normal and Draft compiles the selected mode while keeping
  the last successful preview visible until the new PDF is ready.
- Draft inverse sync places the caret at the beginning of the definition or
  inline diagram/image call without selecting the expression.
- Static images inside template functions, such as page-header logos, become
  Draft placeholders.
- Draft image placeholders without explicit dimensions use the image's intrinsic
  physical size from PNG or JPEG DPI metadata, keeping page counts aligned with
  Normal Preview.
- Image aliases and same-file helper chains continue to resolve to their
  outermost source call.
- Placeholder labels remain unjustified and keep their original padding and
  hover behavior.

## Navigation and synchronization

- Local Typst functions and paths can be opened without a language server.
- Source synchronization now covers headings, figures, tables, images, table
  cells, and captions more consistently.
- Math headings map to PDF bookmarks, low-memory mirrors preserve labels, and
  outline clicks forward-sync to the rendered heading.
- Long paths stay on one line in developer logs.

## Projects and language defaults

- New projects and projects created outside Typsastra receive the global
  document-language defaults when Typsastra creates their metadata on first
  open. Existing assignments remain unchanged, including an explicitly empty
  list.
- **Create New Project** is available with `Ctrl+Shift+N` on Windows and Linux
  and `Cmd+Shift+N` on macOS.
- Fresh installs start without the release summary. Updates still show the
  summary once per version.

## Performance

On a 98-page document containing 40 Fletcher diagrams and 6 CeTZ canvases,
Draft compilation measured 4.48× faster than Normal compilation in the CLI
benchmark. Actual PDF loading and WebView canvas timing were effectively equal
between the two modes. See the [draft diagram
benchmark](BENCHMARKS.md#draft-diagram-benchmark) for the recorded values.

## Examples and documentation

- The documentation demo project includes two Fletcher diagrams and one CeTZ
  canvas with Normal and Draft screenshots.
- Draft Preview documentation now covers diagram placeholders, hover
  thumbnails, cache behavior, and current limitations.
- Keyboard-shortcut documentation lists the new project shortcut.

## Distribution

Scoop is the currently published Windows package-manager channel through the
project bucket. The checked-in Chocolatey, Scoop, and AUR metadata is regenerated
from published release assets, so it may still describe the previous version
until the 0.10.2 assets exist. The winget manifest remains pending upstream
review and is not available yet.

## Compatibility

v0.10.2 does not change the `.typsastra` project archive schema. Existing
projects remain compatible. Recovery data and generated preview caches stay in
machine-local application storage.

Windows installers remain unsigned, so SmartScreen may warn on first launch. The
macOS build remains unsigned and unnotarized; use the targeted Gatekeeper
workaround in the [installation guide](INSTALL.md#open-an-unsigned-macos-release).
