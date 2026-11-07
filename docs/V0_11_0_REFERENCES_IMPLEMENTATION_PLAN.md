# Typsastra v0.11 references implementation plan

## Objective

Ship v0.11 as a references-focused release: project-aware bibliography
browsing, citation insertion, cross-reference completion and validation, and a
small figure insertion workflow. The release must make research-writing
references faster without introducing a reference manager or hidden project
state.

The source remains ordinary Typst. Generated content uses standard
`@key`, `#bibliography(...)`, `#figure(...)`, `<label>`, and `@label` syntax.

## Release principles

1. Source-first: no generated reference database is required to compile the
   project.
2. Local-only: no DOI lookup, Zotero sync, CSL downloads, or network requests.
3. Read-only bibliography: v0.11 browses `.bib` entries and inserts citations;
   entry creation and editing remain direct `.bib` editing.
4. Reuse existing infrastructure: `ProjectTextService`, the native project text
   inventory, CodeMirror diagnostics, the sidebar tool model, and the log
   console/Problems surfaces.
5. Fail open: a malformed `.bib` entry or unsupported reference must produce a
   diagnostic and leave the project editable.
6. No feature work on Table Tools, Image Tools, templates, import/export,
   toolchain management, or recovery unless a defect blocks this release.

## Scope

### In scope

- Discover `.bib` files used by the project.
- Parse bibliography entries and show them in a searchable References sidebar.
- Insert `@key` citations and a `#bibliography(...)` block.
- Diagnose missing citation keys, duplicate keys, and malformed entries.
- Index labels and references across project `.typ` files.
- Complete `@` references from labels and citation keys.
- Diagnose unresolved labels and duplicate labels.
- Navigate between a citation/reference and its definition.
- Insert a figure with image, caption, and label as ordinary Typst source.
- Documentation, tests, and release notes for the above.

### Out of scope

- Full bibliography editing, DOI/online lookup, Zotero or other sync.
- Citation style editing, custom CSL files, or a CSL style browser beyond the
  styles built into the active Typst version.
- Renaming citation keys or labels across the project.
- Automatic formatting of existing citations.
- RTL, AI, computation, Git, new package-manager channels, or broad language
  expansion.

## Architecture

### Index inputs

Use the existing project text inventory instead of a new filesystem scanner.

- `src-tauri/src/project_text.rs` supplies the bounded, `.gitignore`-aware
  inventory and reads.
- `src/workspace/projectTextService.ts` supplies current editor buffers so
  dirty files are indexed from memory rather than disk.
- Index `.typ` and `.bib` files inside the workspace. Skip binary files, files
  over the existing 10 MiB limit, and ignored directories. Treat skipped files
  as index diagnostics, not silent omissions.
- Indexing is project-wide: all reachable `.typ` files and all project `.bib`
  files. It is not limited to the active tab.

### Index command

Add one bounded backend command, for example `update_reference_index`:

```text
requestId
workspaceRootPath
mainFilePath
overlays: [{ path, text, revision }]
```

The backend reads non-overlay files from disk, uses overlay text for open
buffers, parses changed files, and returns a compact index. A backend cache
keyed by canonical path plus revision/identity avoids reparsing unchanged
files. The cache is disposable and never written to the project.

Returned data:

- bibliography files and entries;
- citation sites;
- label definitions and reference sites;
- diagnostics with path and UTF-16 ranges;
- skipped-file reasons;
- index revision.

The frontend invalidates the index on project open, main-file change, tab
buffer change, external file change, and relevant file creation/deletion.
Debounce updates; do not scan on every keystroke.

### Parsing

Use `typst-syntax` in Rust for `.typ` files, matching the existing draft
preparation approach. Extract:

- `Label` nodes for `<label>` definitions;
- `Ref` nodes for `@label` references and `@key` citations;
- `bibliography(...)` function calls and their path/style arguments;
- `cite(...)` calls for citations written in code;
- nearby heading/caption text for display snippets.

For `.bib`, evaluate a maintained BibTeX parser crate during Phase 0. If no
crate meets the portability and size constraints, implement a bounded parser
covering `@string`, `@preamble`, `@comment`, nested braces, quoted values, and
LaTeX escapes. Malformed entries become diagnostics; they must not abort the
whole index.

Do not execute BibTeX macros or resolve external resources.

### Index model

Suggested frontend/backend contracts:

```ts
type BibliographyEntry = {
  key: string;
  entryType: string;
  fields: Record<string, string>;
  title: string;
  authors: string[];
  year: string | null;
  path: string;
  range: TextRange;
  raw: string;
};

type ReferenceLabel = {
  label: string;
  kind: "figure" | "table" | "equation" | "section" | "unknown";
  path: string;
  range: TextRange;
  text: string;
};

type ReferenceSite = {
  target: string;
  kind: "citation" | "reference";
  path: string;
  range: TextRange;
};

type ReferenceDiagnostic = {
  severity: "error" | "warning" | "info";
  code:
    | "missing-citation-key"
    | "duplicate-citation-key"
    | "malformed-bib-entry"
    | "unresolved-label"
    | "duplicate-label";
  path: string;
  range: TextRange;
  message: string;
};
```

Label kind is inferred from a prefix (`fig:`, `tab:`, `eq:`, `sec:`) when
available and from the surrounding figure/table/equation context otherwise.
Unknown labels remain valid references with an `unknown` kind.

## Workstreams

### V11-R1 - Bibliography discovery and parsing

- Add `.bib` file discovery through the project text inventory.
- Parse entries, fields, keys, and source ranges.
- Handle duplicate keys within one file and across files.
- Cache parsed entries by file revision.
- Add fixtures for braces, quotes, `@string`, comments, UTF-8, LaTeX escapes,
  missing commas, duplicate keys, and malformed entries.
- Expose bibliography files and parse diagnostics to the frontend.

Acceptance: a project with one or more `.bib` files returns all valid entries,
duplicate keys are reported, and one malformed entry does not hide the rest.

### V11-R2 - References sidebar

- Add a **References** sidebar tool using the existing activity-button and
  `SidebarController` pattern.
- Include a search field, filters (**All**, **Cited**, **Uncited**,
  **Problems**), and a scrollable entry list.
- Show entry type, title, authors, year, key, and source file.
- Selecting an entry shows details and an **Insert Citation** action.
- Double-click inserts the citation at the editor cursor.
- Keep keyboard navigation, focus handling, empty states, and accessible
  labels consistent with the Images and Tables sidebars.

Acceptance: a user can search the bibliography, inspect an entry, and insert a
citation without opening the `.bib` file.

### V11-R3 - Citation insertion and bibliography block

- Insert `@key` in markup.
- Insert `#cite(<key>)` when the cursor is inside code context.
- Detect an existing bibliography block in the main document. If present,
  reveal it instead of inserting a duplicate.
- Otherwise insert `#bibliography("path/to/refs.bib", style: "...")` at the end
  of the main document.
- Offer the bibliography styles bundled with the active Typst version. Do not
  fetch styles.
- Preserve the user's selected style on repeat insertions.

Acceptance: citations and the bibliography block compile with Tinymist and
produce no duplicate bibliography blocks.

### V11-R4 - Citation diagnostics and navigation

- Report missing citation keys with the citation range.
- Report duplicate bibliography keys with both entry locations when possible.
- Report malformed entries with the `.bib` range.
- Optionally report uncited entries as warnings, disabled by default if noisy.
- Show diagnostics in the existing Problems/log console surfaces and as editor
  markers where the current diagnostics infrastructure supports it.
- Clicking a citation usage opens the `.bib` entry; clicking an entry can list
  its citation sites and open each source location.

Acceptance: removing a bibliography entry produces a navigable missing-key
diagnostic; restoring it clears the diagnostic without reopening the project.

### V11-R5 - Label and reference index

- Parse `<label>` definitions and `@label` references across project `.typ`
  files.
- Infer figure/table/equation/section kinds from prefixes and context.
- Report duplicate labels and unresolved references.
- Provide a label list in the References sidebar or a dedicated **Labels**
  tab.
- Click a label to open its definition; click a reference to open the label.
- Support labels in included files, not only the active document.

Acceptance: a reference in a chapter resolves to a label defined in another
included file, and a missing label produces a navigable diagnostic.

### V11-R6 - `@` completion

- Add a CodeMirror completion source for `@` in markup.
- Merge citation keys and labels, grouped by kind and ranked by prefix match.
- Show the target kind and, for bibliography entries, the title/author.
- Insert `@name` with correct escaping.
- Avoid triggering inside comments, strings, and non-markup contexts.
- Add `#cite(<...>)` and `#ref(<...>)` completion for code contexts when the
  current completion architecture supports it; otherwise defer to a follow-up.

Acceptance: typing `@` shows project citations and labels, and selecting one
inserts a valid reference.

### V11-R7 - Figure insertion (stretch)

- Add an **Insert Figure** action using the selected Image Tools asset or the
  current image insertion flow.
- Ask for a caption; generate a unique `fig:` label from the image name or
  caption.
- Insert ordinary Typst:

```typst
#figure(
  image("images/example.png"),
  caption: [Example caption],
)<fig:example>
```

- Reuse the existing image insertion dialog and Image Tools rather than adding
  a second asset picker.
- If this workstream risks the references release, move it to v0.12.

Acceptance: an inserted figure compiles, appears in the label index, and can be
referenced with `@fig:...`.

## UI placement

- Add a `sidebar-references-button` activity button and
  `references-sidebar-content` container following the Images/Tables pattern.
- Use an existing icon where possible; do not add a new icon family.
- Keep the document outline and spellcheck panes unchanged.
- The sidebar should remain usable with no `.bib` files and with parse errors;
  show a clear empty/error state and a link to the project's `.bib` files.

## Diagnostics policy

- Missing citation keys and unresolved labels are errors.
- Duplicate keys/labels and malformed entries are warnings or errors according
  to severity; they must never block editing or preview.
- Do not add a new persisted settings category for reference diagnostics in
  v0.11. Reuse the log console/Problems surfaces and editor markers.
- Diagnostics are derived state; they disappear when files are fixed or the
  index is rebuilt.

## Performance targets

Measure on a representative project with at least:

- 500 `.bib` entries across 2 files;
- 1,000 labels and references across 50 `.typ` files;
- one open dirty chapter.

Targets:

- initial index under 1 second on the development machine;
- debounced incremental rebuild under 200 ms after a single file edit;
- no whole-project filesystem scan on every keystroke;
- sidebar filtering under 50 ms for 500 entries.

If a target is missed, keep the feature but document the limit and add a
follow-up issue. Do not remove correctness checks to meet the target.

## Security and data safety

- Read only files inside the workspace; reject paths that escape it.
- Do not execute BibTeX or Typst code; parse only.
- Respect the existing project text size limit and binary detection.
- Do not persist the index or copy `.bib` contents into workspace metadata.
- Do not modify source files without an explicit insertion/navigation action.
- Keep the feature offline and free of telemetry.

## Testing

### Rust

- BibTeX parser fixtures for valid, malformed, duplicate, and encoded entries.
- `typst-syntax` label/reference/citation extraction.
- Index merge and duplicate detection across files.
- Overlay precedence for dirty editor buffers.
- Path containment and skipped-file behavior.
- Cache invalidation on content change.

### TypeScript

- References sidebar rendering, filtering, selection, and keyboard navigation.
- Citation insertion in markup and code contexts.
- Bibliography block insertion and duplicate detection.
- Completion source and ranking.
- Diagnostic rendering and navigation.
- Label index and unresolved-reference behavior.

### Integration

- Multi-file project with `#include`, `.bib`, labels, and citations.
- Dirty open buffer against an unchanged disk file.
- External `.bib` edit and file deletion.
- Malformed bibliography entry.
- Missing and duplicate keys.
- Fig insertion and `@fig:` reference.
- Tinymist compile of the generated source.

### Release gates

- `bun test`
- `bun run build`
- `cargo fmt --check`
- `cargo test --lib`
- `bun run test:docs` and `mkdocs build --strict` if documentation navigation
  changes
- Manual validation on a real thesis or research-paper project

## Documentation

- Add `docs/tutorials/REFERENCES_AND_CROSS_REFERENCES.md`.
- Add a short section to `docs/FEATURES.md`.
- Add a v0.11 key-feature entry to `README.md` and `docs/index.md` when the
  feature ships, without version-by-version feature sections.
- Add `docs/RELEASE_NOTES_V0.11.0.md` at release time.
- Link the tutorial from `docs/README.md` and `mkdocs.yml`.
- Document the local-only, read-only bibliography limitation and supported
  citation styles.

## Delivery order

1. **Phase 0 - contracts and parser spike:** choose the BibTeX parser, define
   the index model, add fixtures, and measure baseline indexing.
2. **Phase 1 - bibliography index and sidebar:** parse `.bib`, list/search
   entries, insert citations and the bibliography block.
3. **Phase 2 - citation diagnostics and navigation:** missing/duplicate/
   malformed diagnostics and entry/usage navigation.
4. **Phase 3 - labels and cross-references:** label index, `@` completion,
   unresolved/duplicate diagnostics, label navigation.
5. **Phase 4 - figure insertion and release:** stretch figure workflow, docs,
   release notes, real-project QA.
6. **Release candidate:** freeze features, run gates, fix blockers only.

## Open questions

- Which BibTeX parser crate is maintained, small enough, and safe for malformed
  input? Resolve in Phase 0.
- Should the References UI be a new activity-rail tool or a document sidebar
  section? The activity-rail tool is the current assumption.
- Should `@` completion rank citations before labels, or preserve the user's
  recent choices? Start with prefix match and kind grouping.
- Should code-context completion (`#cite`/`#ref`) ship in v0.11 or follow up?
- Does figure insertion fit in v0.11 without delaying references? Move it to
  v0.12 if not.
- Should uncited bibliography entries be warnings by default? Start disabled.

## Release checklist

- [ ] Bibliography parser and index tests pass.
- [ ] Sidebar, insertion, diagnostics, and navigation work with dirty buffers.
- [ ] Cross-file labels and references resolve.
- [ ] Missing/duplicate diagnostics are navigable.
- [ ] No network access is required.
- [ ] Generated Typst source compiles with Tinymist.
- [ ] No regressions in Draft Preview, Table Tools, Image Tools, templates,
      import/export, or toolchain flows.
- [ ] Documentation, tutorial links, and MkDocs navigation are updated.
- [ ] Release notes and version metadata are prepared.
