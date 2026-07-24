# Projects and main files

## One project, one configured main file

The workspace directory identifies the project. The configured main `.typ` file
identifies its document. An included chapter is source within that document, so
opening it changes the editor tab but not preview ownership.

Set the main file from the Explorer or tab context menu. Renaming the main file
updates the project relationship and restarts the owned Tinymist sessions rather
than leaving a stale compiler target.

## Workspace restoration

Typsastra stores portable state under `.typsastra`:

- `config.json`: project ID, relative main file, recommended toolchain, and
  accepted project terminology;
- `workspace.json`: open tabs, active file, cursor/scroll/fold state, expanded
  directories, pane layout, and selected toolchain.

Paths are project-relative and normalized with `/`, so moving or copying the
whole directory retains the main-file setting. Workspace state is loaded before
the workspace UI appears. PDF compilation may continue asynchronously.

## Generated data

All live-preview mirrors, generated PDFs, source maps, and other temporary
artifacts stay under `.typsastra/cache`. Typsastra does not create generated
files beside project sources unless the user explicitly confirms an export or
file operation. Cache content is disposable: do not copy, commit, or share it.
It can be rebuilt from source, and project export filters it automatically.

The **Export PDF** command is separate from live preview. It asks for
confirmation before creating or replacing the user-facing PDF in the project.
Globally cached scaled-font variants remain in Typsastra's application-data
directory and are never copied into the workspace.

## Large restored tabs

Restored inactive tabs are lazy: Typsastra does not read a large text file or
PDF merely because it appears in the tab bar. Activating a large file shows an
editor-pane confirmation before expensive loading begins.

Try the bundled `05-project-portability/01-main-and-included-files` example.
