# Typsastra v0.5.2 release notes

Typsastra v0.5.2 is a maintenance, responsiveness, and workflow-safety update.
It restores the improved PDF render-on-type path for short documents, tightens
project and LSP lifecycle boundaries, and adds focused editing and file
management refinements without introducing the larger Active File preview
architecture planned for v0.5.3.

Released July 23, 2026.

## Preview and performance

- Restored debounced **On type** PDF preview for responsive short-document
  editing. **On save** remains the default and the recommended mode for long or
  resource-intensive projects.
- Kept editor-side dirty state, language tools, and LSP synchronization
  responsive independently from the configurable preview debounce.
- Added Ctrl/Cmd-click navigation for links in PDF previews with a restrained
  translucent hover target.
- Prevented Markdown, plain-text, and other non-Typst tabs from starting Typst
  language services or recompiling the configured PDF preview.
- Added dependency-aware large-preview confirmation. A small included chapter
  or template can no longer bypass confirmation when its configured main
  document is large.
- Restored the large-preview confirmation action after unsetting and resetting
  a main file.
- Reduced rapidly changing LSP status text while typing.
- Improved preview diagnostics by retaining the real PDF byte length after the
  transferable buffer is handed to PDF.js.
- Kept the experimental decoded-image preflight disabled. Typsastra does not
  hide, downsample, convert, or block source images; corrected non-destructive
  detection is planned for v0.5.3.

## Editing and navigation

- Added contextual double-quote behavior:
  - wrap a selected range with quotes;
  - avoid inserting a dangling closer beside existing text;
  - move over an existing closer;
  - delete an untouched adjacent quote pair with Backspace.
- Improved wrapped-line indentation so continuation rows follow source
  indentation without extending clipped guide lines through the wrapped text.
- Increased indentation-guide visibility across editor themes.
- Fixed pointer placement at the beginning of a line-leading Khmer COENG
  cluster without replacing normal keyboard navigation.
- Preloaded configured script fonts before first input and removed the visible
  system-font flash when changing tabs.
- Kept tab activation responsive while applying the correct script-font policy.
- Opened unsupported text formats in plain-text mode instead of applying Typst
  syntax highlighting.
- Extended pane-focus borders across the complete pane.

## Files, tabs, and workspace lifecycle

- Added **Save As** (`Ctrl+Shift+S` / `Cmd+Shift+S`) to the File menu.
- Added **Duplicate File** to file context menus.
- Promoted a Save As copy to the configured main file when the original main
  file is active.
- Fixed inline creation beside a file so the temporary item no longer appears
  as that file's child.
- Prevented duplicate tab-strip entries during workspace restoration.
- Cleared diagnostic and developer logs when the user restarts Tinymist,
  restarts the workspace, or closes the project.
- Restored active diagnostics after changing, unsetting, or restarting the main
  document lifecycle.
- Synchronized template-owned typography and project language routing after
  workspace or LSP restart.

## Typography and language providers

- Added an optional, mutually exclusive shared-character override. One script
  font can explicitly own spaces, numbers, punctuation, and other Unicode
  `Common` characters while configured script fonts retain strict `scx`
  coverage.
- Kept ordinary ordered Typst fallback behavior when no override is selected.
- Clarified why ordinary fallback order cannot reliably assign mixed Latin and
  complex-script text when a complex-script font also contains Latin glyphs.
- Improved script-priority drag reordering and retained keyboard-accessible
  ordering controls.
- Listed installed language providers first and added search by language name,
  tag, locale, and script.

## Updates, storage, and platforms

- Changed automatic updates to download and stage the new release without
  immediately closing or replacing the running application.
- Added an explicit **Restart to Update** action. A staged update is also
  installed during a normal application shutdown and takes effect at the next
  launch.
- Added read-only monitoring for the Windows WebView2 profile, including
  classified disk use, bounded local history, and non-disruptive growth
  warnings. Typsastra does not automatically delete WebView data.
- Documented the intentionally unsigned and unnotarized macOS build, the
  targeted Gatekeeper quarantine workaround, and its implications for updates.

## Upgrade behavior

Typsastra installs the bundled examples into `Typsastra Examples v0.5.2`.
Earlier versioned example folders remain untouched as user-owned workspaces.

Existing application settings are migrated without removing either preview
mode. Users who select **On type** retain that choice; new installations
continue to default to **On save**.

## Known boundaries

- PDF render-on-type is intended for short documents. Use **On save** when
  repeated compilation or PDF replacement becomes expensive.
- Oversized decoded-image detection remains disabled until the v0.5.3
  implementation passes malformed-file, dependency-discovery, and
  cross-platform qualification.
- Advanced inspection, deletion, and renewal of globally cached scaled-font
  variants has moved to v0.6.0. The existing 10-variant recommendation and
  explicit confirmation remain in effect.
- Portable **Full Document** and **Active File** preview modes remain planned
  for v0.5.3.
- First-class RTL editing remains planned for the v0.9.0 prerelease.
- The experimental macOS build remains unsigned and unnotarized.
- Fonts remain external dependencies and are never included in project exports.
