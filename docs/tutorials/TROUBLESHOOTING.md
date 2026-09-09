# Tutorial troubleshooting

## Native actions do nothing in development

Run `bun run tauri:dev`. `bun run dev` starts only the browser frontend and
cannot provide native filesystem, process, dialog, or managed-toolchain APIs.

## A script has no spelling marks

Move the caret into the word and inspect the language item in the status bar.
For an ambiguous script, open **Document Languages** and check its project
assignment; then confirm the selected provider is installed. Single-language
scripts such as Khmer resolve automatically. Enable the Spellcheck developer
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

## A Markdown image is unavailable

Confirm that the image exists inside the open workspace and that its path is
relative to the Markdown file. Remote images and resources outside the
workspace are blocked intentionally. See [Markdown preview](MARKDOWN_PREVIEW.md).

## Tinymist download stops progressing

Open **Settings → Toolchain** and check whether a validated system Tinymist is
available. Managed downloads show received-byte progress and retry stalled or
transient transfers within bounded limits. Verify GitHub access before retrying.

## An older project contains `.typsastra/cache`

Typsastra now keeps generated render data in machine-local application storage.
When an older workspace cache is detected, review the reported path, file count,
and size before choosing **Migrate and Open**. Typsastra does not delete that
cache silently; cancelling preserves it and stops the project from opening.

## The bundled Tauri CLI crashes during a Linux build

Use `bun run tauri:dev` or `bun run tauri:build`. The wrapper retries native
CLI launch/runtime failures through Cargo using the project's locked Tauri CLI
version. It deliberately does not retry ordinary Rust, frontend, or packaging
errors. See the [development guide](../DEVELOPMENT.md#tauri-cli-fallback).

## Preview is white on Linux

Use the Linux DMA-BUF compatibility setting described in
[PDF preview and source synchronization](PDF_PREVIEW_AND_SYNC.md).

## macOS says the app is damaged

The experimental macOS build is intentionally distributed without Apple
Developer ID signing or notarization. If it was downloaded from the official
Typsastra release page, follow the targeted quarantine-removal procedure in the
[installation guide](../INSTALL.md#open-an-unsigned-macos-release).
Do not disable Gatekeeper globally.

For build, packaging, platform, and detailed preview diagnostics, see the full
[troubleshooting reference](../TROUBLESHOOTING.md).
