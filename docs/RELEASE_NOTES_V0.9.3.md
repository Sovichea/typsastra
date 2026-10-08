# Typsastra v0.9.3 release notes

Typsastra v0.9.3 expands standalone authoring and improves preview recovery when
external tools edit a project. It also makes the editor caret easier to read
over text and fixes release-build warnings.

## Standalone files and project workflows

- Open Typst and Markdown files directly, without first creating a project.
- Open supported off-project files in temporary tabs alongside project files.
- Promote a standalone Typst file and its local dependencies into a project when
  the full project workflow is needed.
- Preserve the previous successful PDF while a replacement preview compiles.

## Preview and external-edit recovery

- Corrected external edits now refresh the preview even when rapid intermediate
  invalid revisions caused LSP errors and the final file matches the editor's
  previous saved contents.
- Improved recovery after compiler failures and Tinymist restarts.
- Restored minimized windows when opening files through operating-system file
  associations.

## Editor and documentation

- Render the editor caret behind text glyphs for clearer cursor visibility.
- Open Typsastra Documentation from the application Help menu.
- Added a branded, feature-focused documentation site with screenshots and video
  demonstrations.

## Compatibility

v0.9.3 does not change the `.typsastra` project archive schema. Existing v0.9.2,
v0.9.1, v0.9.0, and v0.8.x projects remain compatible.

Automatic preview scrolling on cursor movement (Cursor sync) remains disabled
pending the v0.9.x reliability work. macOS remains experimental, unsigned, and
unnotarized.
