# Typsastra v0.10.0 Implementation Plan

## Objective

Improve multi-file navigation, editing, and recovery through four connected
features: project search and reviewed replacement, a shared main-document
outline, Back/Forward source navigation, and unsaved-text crash recovery.

This is an approved implementation plan, not a record of completed features.
Tasks use stable IDs. Application code, tests, and user documentation should
land together. All four features are required for the planned release.

## Release rules

- Navigation must preserve preview state and must not trigger compilation.
- Replacement produces unsaved editor changes; normal Save/Auto-save owns
  persistence and the existing On save/On type compilation policy.
- Recovery must never overwrite source files automatically.
- Source files remain ordinary, portable files. Generated indexes and recovery
  data stay outside project sources and exported project archives.
- Existing workspace files remain readable. New persisted fields are optional.
- AI integration, Git UI, outline restructuring, automatic document execution,
  Image/Table Tool model recovery, and local-history timelines are out of scope.

## A. Project search and replacement

### V010-A.1 — Shared project-text service

- Introduce a service providing canonical file identity, workspace-relative
  paths, buffer-over-disk snapshots, revision tokens, and invalidation.
- Search UTF-8 text inside the workspace. Unsaved open buffers take precedence
  over disk. Make searchable text files openable in the generic text editor.
- Respect `.gitignore` by default; expose an option to include ignored files.
  Always exclude binary files, `.git`, `.typsastra`, generated application caches,
  and paths outside the workspace. Do not traverse directory symlinks.
- Enumerate files through a cancellable native service. Read at most four files
  concurrently and skip files larger than 10 MiB with a visible explanation.
- Preserve original source text, BOM, and line endings. Use UTF-16 offsets at
  frontend boundaries and explicit conversion at native boundaries.

### V010-A.2 — Search sidebar and matching

- Add Search to the activity bar. It replaces sidebar content while leaving the
  editor and preview visible; it does not own the preview like Image/Table Tools.
- Keep editor Find. Register configurable Search Project and Replace in Project
  commands, defaulting to `Ctrl/Cmd+Shift+F` and `Ctrl/Cmd+Shift+H`.
- Provide mutually exclusive Literal, Regex, and Fuzzy modes with include/exclude
  glob filters.
- Literal mode reuses editor behavior for case sensitivity, whole words,
  diacritics, and Unicode. Regex mode shares editor regex syntax and capture
  replacement semantics. Extract reusable matching logic from
  `src/editor/search.ts` rather than implementing a second interpretation.
- Fuzzy mode ranks subsequence matches in relative file paths and individual
  source lines. Show path matches separately from content matches and highlight
  matched characters. Disable replacement, whole-word, regex, and diacritic
  controls in this mode.
- Group content matches by relative file path, showing line numbers, highlighted
  excerpts, and counts. Clicking opens and selects source without moving the PDF.
- Debounce query changes by 200 ms. Run matching in a Web Worker and cap displayed
  results at 20,000. Explicitly label truncated, skipped, or incomplete results.
- Terminate regex work exceeding one second per file using a worker watchdog;
  report incomplete results without blocking editor input.
- Tag requests/results with workspace, query, and source revisions. Cancel old
  work and reject late responses after query changes or workspace closure.
- Revalidate changed files before navigating to a result; refresh stale results
  instead of trusting old offsets.

### V010-A.3 — Reviewed multi-file replacement

- Literal and regex modes provide per-match/per-file selection and before/after
  review. Disable application while results are incomplete or truncated; require
  narrowing the query and completing the search first.
- Reject replacement ranges that split grapheme clusters. Show unsafe matches as
  non-replaceable instead of silently expanding their ranges.
- Preflight every selected file against its reviewed revision. If any changed,
  apply nothing and refresh affected results.
- Apply one undoable CodeMirror transaction per affected file. Open previously
  closed files as permanent unsaved tabs; preserve existing selection and scroll
  state where possible. Do not write source files during application.
- Suppress intermediate preview scheduling. On type schedules one update after
  the complete batch; On save waits for saving. Auto-save must not observe a
  partially applied batch.
- Retain the latest batch's before/after revisions. Offer Undo Replace Batch only
  while every affected buffer still matches its output. Preflight the entire
  undo before making changes; otherwise explain why it is unavailable and retain
  normal per-file Undo.

## B. Shared main-document outline

### V010-B.1 — Main-rooted project outline

Implemented:

- Project Typst outlines are rooted at the configured main document instead of
  the active tab. Switching between the main file and included-file tabs keeps
  the same heading tree, expansion state, and selection.
- Active heading detection is tied to the active file and source offset for both
  main and included files. Path matching normalizes slash direction and case.
- Unsaved open buffers take precedence for the main document and includes.
  Source edits, external changes, and main-file changes schedule a rebuild.
- Late parse results are discarded when a newer outline update supersedes them.
- Included files keep the main-document outline. While a file in the main
  document is active, headings from other files are muted so that file's own
  headings stand out. This applies to the main file as well as includes. Other
  project Typst documents use a file-only outline for editor navigation; their
  own includes are not expanded until the file is pinned as the main document.
- Standalone documents keep the active-file outline workflow. Standalone PDF
  bookmark navigation is unchanged.

Deferred:

- The File/Project scope selector and per-workspace remembered scope.

### V010-B.2 — Include handling and navigation

Implemented:

- Literal `#include` directives are followed recursively in document order.
  Recursion cycles are detected along the active include chain rather than by a
  global visited set, so a file included more than once keeps every outline
  occurrence.
- Heading identities include the normalized source file and the per-file
  heading occurrence. Identical titles in different files, and repeated
  inclusions of the same file, stay independently addressable when unrelated
  includes are reordered or edited.
- The outline reports includes that cannot be indexed: missing files, dynamic
  includes, include cycles, and local `.typ` files referenced with `#import`.
  These diagnostics appear in the Log console with source navigation, not in
  the outline pane. Missing includes and cycles are warnings; unsupported
  `#import` references are informational. `#import` files are not expanded into
  the outline.
- Clicking a heading opens its precise source location and scrolls the PDF to
  that heading's matched bookmark destination. The scroll falls back to the
  heading's page and retries briefly while the preview surface settles.
- If PDF outline positions arrive after a heading click, the pending heading is
  scrolled once the positions become available.
- Matched PDF positions are retained and re-applied when the outline is rebuilt,
  so repeated heading clicks continue to move the PDF.

Deferred:

- A separate Reveal in Preview command.

## C. Back/Forward source navigation

### V010-C.1 — History controller

Implemented:

- Session-only history stores at most 100 source locations and is cleared when
  the workspace closes. It is not persisted across restarts.
- Explicit jumps from project search, outline, LSP definitions, diagnostics/log
  locations, and inverse sync record a departure before navigation and a
  destination after successful completion. Manual Explorer file opens and tab
  selections are navigation too. Typing, ordinary scrolling, automated tab
  activation, tab restoration, and tab closing do not add entries. Navigating
  after Back removes the forward branch.
- Entries store the source path, selection, editor viewport, and a short
  source-context anchor. Replayed locations resolve that context against current
  text, so edits before or inside the recorded location keep the selection on
  the same source text. A clamped offset is only the final fallback.
- Known workspace renames remap matching history entries. Missing destinations
  are skipped with a Log console warning and the next available entry is used.

### V010-C.2 — Controls and integration

Implemented:

- Accessible Back/Forward controls at the left edge of the tab bar and matching
  Edit menu commands default to `Alt+Left` and `Alt+Right` and are configurable
  like other application shortcuts. The reserved keys regain their CodeMirror
  meaning when the application command is remapped.
- The tab bar scrolls with the wheel or trackpad. A chevron menu at its right
  edge lists every open tab for direct selection when the strip overflows.
- History is recorded at existing navigation boundaries: search navigation,
  outline navigation, LSP source navigation, diagnostics navigation, inverse
  sync, and manual file/tab selection.
- Replaying history activates the target tab without compiling a preview or
  queuing a PDF scroll. Navigation requests are serialized and obsolete requests
  are rejected so rapid Back/Forward or workspace closure cannot update the
  stack or select a stale document.

## D. Unsaved-text crash recovery

### V010-D.1 — Persistent snapshots

Implemented:

- Text buffers are snapshotted for project, standalone, off-project, and
  missing-file restoration cases, including dirty inactive tabs. Image/Table
  Tool models and historical versions remain deferred.
- Snapshots live in a dedicated application-local `recovery/` store, separate
  from render caches and project sources.
- Versioned native list/read/write/delete commands record document identity,
  workspace/path, unsaved text, saved-content hash, revision, timestamp,
  selection, and editor scroll state.
- Snapshots write after one second of idle editing and at least every five
  seconds during continuous editing. Writes are serialized per document and
  older revisions are rejected.
- Writes use an atomic temporary file and keep the previous valid snapshot if
  publishing fails. Storage is capped at 100 MiB without silently deleting
  records. Failures produce a persistent Log warning that points to
  **File → Recover Unsaved Work…**.
- Snapshotting does not start Tinymist or request a compile.

Deferred:

- Pathless untitled buffers. The editor currently creates files with a path;
  missing-file recovery uses a dirty buffer with Save As.
- Image/Table Tool model recovery and historical snapshot timelines.

### V010-D.2 — Review and restore

Implemented:

- A startup review dialog lists recoverable files with Review, Restore, and
  Discard controls, storage usage, and corrupt-record reporting. It can be
  reopened from **File → Recover Unsaved Work…**.
- If disk already matches the recovered text, the record is resolved
  automatically. If disk differs from the saved baseline, Restore opens a
  side-by-side comparison first.
- Restore opens an unsaved buffer without writing disk. Missing files restore as
  dirty buffers and can be kept with Save As.
- Saving deletes the matching snapshot revision only when no newer revision
  exists. Explicit tab/project/window discard flows also remove their records.
- Unresolved snapshots remain after normal shutdown; corrupt records are listed
  independently and cannot block valid recovery records.

## E. Interfaces and compatibility

- Keep search requests/results and replacement plans typed and separate from
  editor mutation. Each result identifies its query, file revision, match range,
  and replacement eligibility.
- Make the shared text service the source of buffer/disk revision checks for
  search and outline. Use existing editor sessions and save policies for edits.
- Add optional workspace preferences for Search-sidebar state. Outline scope
  preferences are deferred until a File/Project selector is implemented. Do not
  persist query results or navigation history.
- Version recovery records independently of project archives. Validate records
  before restoration and keep unsupported versions available for explicit review
  rather than silently deleting them.
- Use existing shortcut customization, icon, theme, context-menu, and accessibility
  conventions. No hardcoded platform-specific storage paths.

## F. Delivery sequence

1. Shared text snapshots, native inventory/read service, worker matching, and
   Search sidebar.
2. Replacement review, batch editor application, per-file undo, and batch undo.
3. Shared main-rooted outline, then Back/Forward navigation.
4. Native recovery storage and review/restore UI.
5. Integration, performance qualification, documentation, and release review.

## G. Acceptance and release gates

### Search and Unicode

- Test dirty-buffer precedence, external changes, ignored files, invalid UTF-8,
  CRLF/BOM, cancellation, obsolete results, file/result limits, regex failures and
  watchdog timeouts, and deterministic fuzzy ranking.
- Test Khmer, Lao, combining marks, emoji, supplementary characters, diacritic
  matching, regex captures, and grapheme-safe replacement boundaries.
- Use a deterministic fixture of 1,000 text files totaling 20 MiB. Matching stays
  off the UI thread, obsolete-query UI clears within 100 ms, and repeated query
  cancellation does not accumulate buffers or workers.

### Replacement, outline, and history

- Verify all-file revision preflight prevents partial application; test mixed
  open/closed files, conflicts, per-file undo, guarded batch undo, auto-save
  coordination, and one scheduled compilation per batch.
- Verify main-rooted outline consistency across main/include tabs, file-only
  outlines for non-main documents, active-heading sync, exact PDF heading scroll,
  repeated heading clicks, unsaved buffers, main changes, and rapid tab
  switching.
- Deferred outline gates: File/Project scope, repeated include occurrences,
  dynamic-include notices, file-based heading identities, and a separate Reveal
  in Preview command.
- Verify history branching, replay suppression, changed source contexts,
  missing/renamed destinations, and workspace-close cancellation.
- Confirm all navigation paths preserve preview freshness, viewport, and the
  existing no-recompile-on-navigation behavior.

### Recovery

- Exercise forced termination, interrupted atomic writes, continuous editing,
  inactive buffers, standalone/off-project/untitled files, deleted files, disk
  conflicts, corrupt records, storage limits, and permission/disk-write failures.
- Verify newer snapshots survive older saves and that recovery data survives
  disposable-cache maintenance.
- Confirm review and restoration never overwrite source files automatically.

### Required checks and documentation

- Run the full Bun suite, production build, affected Rust tests, documentation
  link checks, strict MkDocs build, and
  `cargo fmt --manifest-path src-tauri/Cargo.toml --check`.
- Update the roadmap, feature guide, settings reference, tutorials, and docs-site
  navigation alongside the implementation.
- Retain the documented Tinymist live-preview Unicode-search limitation. Project
  source search must not imply that live PDFs gain logical-unit Unicode search.
- Release only after all four feature areas and the integration gates pass.
