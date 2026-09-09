# Projects and main files

## One project, one configured main file

The workspace directory identifies the project. The configured main `.typ` file
identifies its document. An included chapter is source within that document, so
opening it changes the editor tab but not preview ownership or the current PDF
page position. Main and included tabs share one document-preview viewport.

Set the main file from the Explorer or tab context menu. Renaming the main file
updates the project relationship and restarts the owned Tinymist sessions rather
than leaving a stale compiler target.

## Workspace restoration

Typsastra stores portable state under `.typsastra`:

- `config.json`: project ID, relative main file, recommended toolchain,
  document script-language assignments, and accepted project terminology;
- `workspace.json`: open tabs, active file, cursor/scroll/fold state, expanded
  directories, pane layout, and selected toolchain.

Paths are project-relative and normalized with `/`, so moving or copying the
whole directory retains the main-file setting. Workspace state is loaded before
the workspace UI appears. PDF compilation may continue asynchronously.

## Generated data

All live-preview mirrors, generated PDFs, source maps, and other temporary
artifacts stay in Typsastra's machine-local application-data cache, outside the
project. Typsastra does not create generated files beside project sources unless
the user explicitly confirms an export or file operation. Cache content is
disposable and can be rebuilt from source.
To avoid duplicating large image collections, non-Typst assets use regular hard
links when the workspace filesystem supports them and fall back to ordinary
copies otherwise. Typsastra never uses symbolic links for render-cache assets.
Removing the cache link does not remove the original project asset.

Open **Settings → Storage** to inspect every machine-local project cache. Each
entry reports cache size, file count, hard-linked bytes, and genuinely copied
bytes, and provides an explicit action to reveal the directory. A hard-linked
asset has multiple paths but shares its underlying storage allocation with the
project source.

Projects created by older Typsastra versions may still contain
`.typsastra/cache`. On open, Typsastra displays its exact path, file count, and
size before doing anything. Choose **Migrate and Open** to remove the disposable
legacy cache and use machine-local storage, or **Cancel** to leave it untouched
and stop opening the project.

The **Export PDF** command is separate from live preview. It asks for
confirmation before creating or replacing the user-facing PDF in the project.
Globally cached scaled-font variants remain in Typsastra's application-data
directory and are never copied into the workspace.

## Large restored tabs

Restored inactive tabs are lazy: Typsastra does not read a large text file or
PDF merely because it appears in the tab bar. Activating a large Typst source
shows an editor-pane confirmation before either editor initialization or
preview compilation begins. A directly opened large PDF asks for confirmation
in the preview pane before decoding.

Large-file approval belongs to the configured document. After approving its
main preview, included Typst files reuse that approval and keep the same preview
page position instead of prompting or restoring independent PDF positions.

Try the bundled `05-project-portability/01-main-and-included-files` example.
