# Typsastra v0.10.1 release notes

Typsastra v0.10.1 is a preview and editor reliability update. It extends image
helper handling in both preview directions, removes the first-click delay after
a cached preview restore, and refreshes the writable examples and documentation.

## Image helper chains

- Inverse sync follows nested image helper functions and forwarded parameters to
  the outermost call that supplied the image path.
- Draft Preview resolves same-file helper chains, including positional and
  named parameters, parameter defaults, and width or height values.
- Helper placeholders preserve the resolved layout dimensions instead of falling
  back to the image's intrinsic width.
- Dynamic or ambiguous helper calls remain unchanged rather than guessing.
- Old Draft Preview caches are invalidated so changed parameter handling is
  reflected immediately.

## Preview reliability

- Cached preview restores warm the source map before the first inverse-sync
  click, removing the initial delay on large documents.
- Editor scrollbar markers identify search, image, unused-symbol, and diagnostic
  sources consistently.
- Image and table gutter markers refresh after a cached preview restore and when
  switching tabs.

## Editing and toolchain

- Built-in Typst functions that take paths warn about parent-relative forms and
  offer a root-relative **Use root path** quick fix.
- Toolchain setup no longer blocks startup with a modal. A red title-bar badge
  reports a missing Tinymist installation and opens the setup controls.
- Path warnings and marker updates keep editor state aligned with the active
  project instead of a previously opened workspace.

## Examples and documentation

- The writable examples are organized by capability: preview and media, editor
  workflows, and tools and templates.
- New exercises cover nested image helper chains, project search and recovery,
  document-language defaults, linked Table Tools blocks, and project templates.
- Tutorials and screenshots now use the bundled examples, including project
  search, reviewed replacement, recovery, outline, language settings, Image
  Tools, Table Tools, and Markdown preview.

## Distribution

Scoop is the currently published Windows package-manager channel through the
project bucket. The checked-in Chocolatey, Scoop, and AUR metadata is
regenerated from published release assets, so it may still describe the previous
version until the 0.10.1 assets exist. The winget manifest remains pending
upstream review and is not available yet.

## Compatibility

v0.10.1 does not change the `.typsastra` project archive schema. Existing
projects remain compatible. Recovery data and generated preview caches stay in
machine-local application storage.

Windows installers remain unsigned, so SmartScreen may warn on first launch. The
macOS build remains unsigned and unnotarized; use the targeted Gatekeeper
workaround in the [installation guide](INSTALL.md#open-an-unsigned-macos-release).
