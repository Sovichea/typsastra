# Typsastra v0.9.2 release notes

Typsastra v0.9.2 is a maintenance release. It adds programmable keyboard
shortcuts, a native Windows ARM64 installer, and a dedicated Spellcheck pane
beside the document Outline. Khmer double-click selection now uses the language
provider's word boundaries rather than selecting a single grapheme.

## Programmable keyboard shortcuts

- Added a **Shortcuts** panel in Settings for remapping application and editor
  commands. Assignments are saved with user settings and editor keymaps can be
  reconfigured without rebuilding the editor.
- Added a keyboard recorder, platform-aware collision checks, and support for
  two-key chords such as `Ctrl+K`, then `O`.
- Customized shortcuts are highlighted and labelled in the list. Reset one
  command or reset all custom shortcuts to their defaults.
- The editor keymap remains a separate layer so a future Vim mode can replace it
  cleanly.

## Windows ARM64

- Added a native ARM64 Windows MSI alongside the x64 MSI. Windows on Arm devices
  receive the matching installer in release assets.
- Added a release verification step that checks for the MSI matching each
  architecture.

## Spellcheck and Khmer selection

- Moved spellcheck findings from the Problems console into a collapsible
  **Spellcheck** pane beside **Outline**. Findings are grouped by word, list their
  locations, and navigate directly to each occurrence.
- Outline and Spellcheck are mutually exclusive panes. Their active state is
  persisted per project; older projects continue to open with Outline active.
- Double-clicking Khmer text selects its spellcheck diagnostic span for an
  unknown word, or the Khmer provider's segmentation span for a known word.
  Editor, native text fields, and WYSIWYM editing use the same provider-backed
  boundaries, with grapheme-safe behavior while analysis is pending.

## Windows Package Manager

- Added a Windows generator for winget manifests. It downloads published
  installers, reads their MSI identity, computes hashes, and validates the
  generated x64 and ARM64 manifest. Each package version is submitted to
  winget-pkgs separately after its release is published.
- Windows MSI installers remain unsigned, so SmartScreen may show a warning on
  first launch. winget does not bypass this check.

## Compatibility and known limitations

v0.9.2 does not change the `.typsastra` project archive schema. Existing v0.9.1,
v0.9.0, and v0.8.x projects remain compatible.

Automatic preview scrolling on cursor movement (Cursor sync) remains disabled
pending the v0.9.x reliability work. macOS remains experimental, unsigned, and
unnotarized.
