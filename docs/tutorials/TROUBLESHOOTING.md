# Tutorial troubleshooting

## Native actions do nothing in development

Run `bun run tauri dev`. `bun run dev` starts only the browser frontend and
cannot provide native filesystem, process, dialog, or managed-toolchain APIs.

## A script has no spelling marks

Open the `Aa` Typography toolbar and check that the script has a language
selected and its provider is installed. A script with Language tools off is
intentionally ignored. Enable the Spellcheck and document scripts developer
log, then inspect routing and analysis events.

## Completion does not appear

Check the suggestion toggle, the language assigned to the typed script, the
provider's completion capability, and whether an IME composition is active.
Typsastra does not use the keyboard layout or Typst `lang` to choose completion.

## An included file previews by itself

Confirm that the intended `.typ` root is set as the project main file. Open the
included source normally; changing active tabs should not change preview owner.

## A large restored file was not loaded

This is intentional. Activate the tab and confirm the large-file notice in the
editor pane. Inactive large tabs stay lazy to keep workspace startup responsive.

## Preview is white on Linux

Use the Linux DMA-BUF compatibility setting described in
[PDF preview and source synchronization](PDF_PREVIEW_AND_SYNC.md).

## macOS says the app is damaged

The current experimental macOS build is unsigned and unnotarized. If it was
downloaded from the official Typsastra release page, follow the targeted
quarantine-removal procedure in the
[installation guide](../INSTALL.md#open-the-current-unsigned-macos-release).
Do not disable Gatekeeper globally.

For build, packaging, platform, and detailed preview diagnostics, see the full
[troubleshooting reference](../TROUBLESHOOTING.md).
