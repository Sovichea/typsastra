# Typsastra v0.10.0 Implementation Plan

## Objective

Improve multi-file navigation, editing, and recovery through four connected
features: project search and reviewed replacement, a shared main-document
outline, Back/Forward source navigation, and unsaved-text crash recovery.

This plan records approved scope and implementation status. Tasks use stable IDs.
Application code, tests, and user documentation should land together. All four
features are required for the planned release.

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

Implemented:

- `ProjectTextService` provides canonical file identity, workspace-relative
  paths, buffer-over-disk snapshots, revision tokens, and path/all invalidation.
- Search covers UTF-8 text inside the workspace. Unsaved open buffers take
  precedence over disk, and searchable text files can be opened in the generic
  text editor.
- `.gitignore` is respected by default with an option to include ignored files.
  Binary files, `.git`, `.typsastra`, generated application caches, and paths
  outside the workspace are excluded. Directory symlinks are not traversed.
- Files are enumerated through a cancellable native service. At most four files
  are read concurrently, and files larger than 10 MiB are skipped with a visible
  explanation.
- Snapshots preserve original source text, BOM, and line endings. Frontend
  boundaries use UTF-16 offsets and convert explicitly at native boundaries.

### V010-A.2 — Search sidebar and matching

Implemented:

- Search is available from the activity bar. It replaces sidebar content while
  leaving the editor and preview visible; it does not own the preview like
  Image/Table Tools.
- Editor Find remains. Configurable Search Project and Replace in Project
  commands default to `Ctrl/Cmd+Shift+F` and `Ctrl/Cmd+Shift+H`.
- Mutually exclusive Literal, Regex, and Fuzzy modes share include/exclude glob
  filters.
- Literal mode reuses editor behavior for case sensitivity, whole words,
  diacritics, and Unicode. Regex mode shares editor regex syntax and capture
  replacement semantics through the extracted `searchMatcher` module.
- Fuzzy mode ranks subsequence matches in relative file paths and individual
  source lines. Path matches are shown separately from content matches with
  highlighted characters. Replacement, whole-word, regex, and diacritic controls
  are disabled in this mode.
- Content matches are grouped by relative file path with line numbers,
  highlighted excerpts, and counts. Clicking opens and selects source without
  moving the PDF.
- Query changes are debounced by 200 ms. Matching runs in a Web Worker, results
  are capped at 20,000, and truncated, skipped, or incomplete results are
  explicitly labelled.
- Regex work exceeding one second per file is terminated by a worker watchdog;
  incomplete results are reported without blocking editor input.
- Requests and results are tagged with workspace, query, and source revisions.
  Old work is cancelled and late responses are rejected after query changes or
  workspace closure.
- Changed files are revalidated before navigating to a result; stale results
  refresh instead of trusting old offsets.

### V010-A.3 — Reviewed multi-file replacement

Implemented:

- Literal and regex modes provide a one-click Replace All for every safe match,
  plus per-match/per-file selection and before/after review for narrower changes.
  Replacement is disabled while results are searching, incomplete, truncated, or
  errored, and requires a completed search.
- Ranges that split grapheme clusters are rejected. Unsafe matches are shown as
  non-selectable and cannot be applied.
- Every selected file is preflighted against its reviewed revision and open
  buffer content. If any file changed, nothing is applied and the results
  refresh.
- Replacement applies one undoable CodeMirror transaction per affected file.
  Previously closed files open as permanent unsaved tabs; selection and scroll
  state are restored where possible. Source files are not written.
- Intermediate preview scheduling is suppressed. On type schedules one update
  after the complete batch; On save waits for saving. Auto-save cannot observe a
  partially applied batch.
- The latest batch's before/after text is retained. Undo Replace is available
  only while every affected buffer still matches its output, checks the entire
  batch before changing anything, and otherwise explains why it is unavailable
  so normal per-file Undo remains usable.

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
  records. Failures produce a persistent Log warning; the previous valid
  snapshot remains available when its project is opened.
- Snapshotting does not start Tinymist or request a compile.

Deferred:

- Pathless untitled buffers. The editor currently creates files with a path;
  missing-file recovery uses a dirty buffer with Save As.
- Image/Table Tool model recovery and historical snapshot timelines.

### V010-D.2 — Review and restore

Implemented:

- Opening a project with matching snapshots offers the recoverable files with
  Review, Restore, and Discard controls, storage usage, and corrupt-record
  reporting. Recovery is not shown automatically at application startup, and
  snapshots from other projects are excluded from the project-open prompt.
  There is no separate manual recovery command.
- If disk already matches the recovered text, the record is resolved
  automatically. If disk differs from the saved baseline, Restore opens a
  git-style unified diff first, rendering only changed hunks with context
  rather than the complete files.
- Restore opens an unsaved buffer without writing disk. Missing files restore as
  dirty buffers and can be kept with Save As.
- Saving deletes the matching snapshot revision only when no newer revision
  exists. Explicit tab/project/window discard flows also remove their records.
- Unresolved snapshots remain after normal shutdown; corrupt records are listed
  independently and cannot block valid recovery records.

## E. Interfaces and compatibility

Implemented:

- Search requests/results and replacement plans stay typed and separate from
  editor mutation. Each result identifies its query, file revision, match range,
  and replacement eligibility.
- The shared text service supplies buffer-over-disk snapshots and revision
  checks for search and replacement. Outline reads prefer open buffers through
  the workspace text controller. Edits use existing editor sessions and save
  policies.
- The active sidebar tool is remembered in workspace layout state. Search
  queries, replacement text, results, and navigation history are session-only.
- Recovery records are versioned independently of project archives, validated
  before restoration, and unsupported versions remain available for explicit
  review rather than being silently deleted.
- Shortcut customization, icons, themes, context menus, and accessibility follow
  existing conventions. No platform-specific storage paths are hardcoded.

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
- Deferred outline gates: File/Project scope and a separate Reveal in Preview
  command.
- Verify history branching, replay suppression, changed source contexts,
  missing/renamed destinations, and workspace-close cancellation.
- Confirm all navigation paths preserve preview freshness, viewport, and the
  existing no-recompile-on-navigation behavior.

### Recovery

- Exercise forced termination, interrupted atomic writes, continuous editing,
  inactive buffers, standalone/off-project files, missing files, disk conflicts,
  corrupt records, storage limits, and permission/disk-write failures.
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
