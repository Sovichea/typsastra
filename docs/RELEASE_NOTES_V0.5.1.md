# Typsastra v0.5.1 release notes

Typsastra v0.5.1 is a maintenance and learning-experience update for the
multilingual foundations introduced in v0.5.0. It makes those workflows easier
to discover while correcting provider routing and completion regressions found
after release.

## Guided examples and tutorials

- Reorganized the writable example workspace into a guided path covering
  basics, multilingual writing, language providers, research projects, and
  project portability.
- Installed writable examples into a versioned Documents folder such as
  `Typsastra Examples v0.5.1`, preventing a new release from overwriting or
  silently reusing an older example workspace.
- Added focused examples for script-specific font assignments,
  document-script spellcheck, provider-selected completion, optional-provider
  recovery, main-file ownership, portable workspace state, and font-free export.
- Promoted the multilingual article into the research-project sequence as the
  complete v0.5.x language-tools demonstration.
- Added prerequisites, expected behavior, limitations, and tutorial links to
  non-trivial examples.
- Clarified that current Arabic and Hebrew samples demonstrate Typst rendering;
  first-class RTL editor behavior remains planned for v0.9.0.
- Added a user documentation index and task-oriented tutorials for projects,
  language tools, typography, long documents, preview synchronization, and
  project interchange.
- Added a once-per-version startup summary with a direct link to the complete
  release notes.

## Document typography

- Replaced primary and embedded typography roles with equal document-script
  assignments. Every configured script can choose its own font and uniform
  scale relative to the shared document size.
- Added native Typst `covers` descriptors using Unicode Script Extensions
  (`scx`). A Khmer font that contains Latin glyphs can now appear before the
  Latin font without consuming Latin text.
- Preserved existing primary/embedded configurations through automatic metadata
  migration while writing the unified `typsastra:document-scripts` format for new
  changes.
- Rejected conflicting scales when multiple scripts select the same internal
  font family, avoiding ambiguous generated-font resolution.
- Synchronized main-file typography directives with the typography toolbar and
  generated-font cache. Setting a main file now requests confirmation before
  preparing missing or stale scaled fonts and aborts the main-file change when
  preparation is declined or fails.
- Moved scaled-font variants from project-local `.typsastra` storage to a
  private global application-data cache. Matching font-and-scale variants are
  reused across projects, while font bytes and cache paths never enter project
  settings, workspace copies, source ZIPs, or project archives.

- Added a soft limit of 10 cached scale variants per font face. Creating another
  variant requires confirmation; Typsastra preserves existing variants until
  the planned v0.5.2 cache manager lets users inspect, delete, or renew them.
- Limited generated-font ownership to the configured main file. Editing a
  typography directive or toolbar configuration in any other file no longer
  prompts, generates fonts, or restarts Tinymist.
- Prevented unrelated non-main files from scheduling a PDF recompilation when
  edited, saved, or reloaded externally. Included and imported sources continue
  to update their configured main-document preview.
- Documented that non-unit scaling is experimental for PDF output. Typst may
  normalize a generated font during PDF subsetting while retaining its scaled
  advances, and Typsastra intentionally does not hide that upstream result with
  a preview-only or PDF-rewriting workaround.

## Document-script language tools

- Unified font, scale, and optional language-provider selection under the
  `typsastra:document-scripts` directive.
- Made the configured main file authoritative for included files. Standalone
  documents use their own directive.
- Removed keyboard-layout and Typst-language-scope routing. Spellcheck and word
  completion now use the same deterministic per-script assignment.
- Left scripts without a language selection untouched, with no implicit
  spellcheck, completion, or same-script fallback.

## Language-tool fixes

- Fixed completion for typed-script languages on Linux and other supported
  platforms.
- Restored Khmer word completion when its provider is selected from the active
  typing context.
- Made the main document's script assignments authoritative while editing
  included files, preventing unrelated same-script dictionaries from leaking.
- Exposed unavailable provider state in the Typography toolbar without adding
  warnings to intentionally unconfigured source text.
- Rejected stale or mismatched provider results before they reach the editor.
- Added an optional developer log category for spellcheck and document-script
  routing, and aligned wrapped-line warnings with the first visual line.

## Validation

- Added cross-platform CI for documentation links, bundled example compilation,
  writable-example migration, package hygiene, and language-scope fixtures.
- Added guards preventing generated PDFs, preview caches, and font binaries from
  entering the bundled example workspace.
- Verified that all 20 bundled `main.typ` entry points compile with Typst 0.15.1.

## Upgrade behavior

Typsastra installs the reorganized learning path in
`Typsastra Examples v0.5.1`. Earlier versioned example folders remain untouched
as user-owned workspaces and are never silently overwritten or selected for the
new release.

## Known boundaries

- Optional language providers must still be installed before their explicit
  scopes receive spellcheck or completion.
- Keyboard-language completion reliability depends on the operating system's
  keyboard-layout reporting; Settings shows the active fallback policy.
- First-class RTL editing remains scheduled for v0.9.0.
- Fonts remain external dependencies and are never included in project exports.
