# Roadmap

## v0.4.x — completed stabilization line

The v0.4.x line built on the existing feature set. Its priorities were:

- Bug fixes and regression prevention, especially for Unicode, Khmer, project workflows, preview, and data safety.
- Performance, responsiveness, memory use, and startup/build optimization.
- A limited number of minor features that extend existing workflows without introducing a new architectural track.
- No major editor subsystem or broad language-support expansion; larger features move to v0.5.0 or later.

The last public release in this line is v0.4.1. Development after that tag is
assigned to v0.5.0 because it introduces new subsystems and intentional pre-1.0
format changes rather than another stabilization patch.

## v0.5.0 — multilingual foundations (released)

Released on July 18, 2026, this milestone completed the foundations needed for
broader multilingual work:

- Document-script language routing for deterministic spellcheck and word completion.
- Keyboard-language-aware word completion and scoped terminology.
- Hardware-accelerated, motion-aware PDF rendering with immediate page jumps.
- Portable workspace state, lazy restored tabs, and guarded large-file loading.
- Font-free schema-v2 project archives and explicit Tinymist process lifecycle.
- Signed update detection, recent-project search, pane keyboard navigation, and cross-platform application refinements.
- Script-specific document typography with Unicode `scx` coverage and independent scaling.
- Warmed source-map sessions for reliable first-use synchronization in very long documents.

## v0.5.1 — examples, tutorials, and maintenance (released)

Released on July 21, 2026, this milestone made the v0.5.0 multilingual
foundations easier to learn and verify while continuing the v0.5.x maintenance
line:

- Restructure the bundled examples into a guided path from Typst basics through
  multilingual document scripts, language providers, research projects, and
  project portability.
- Add focused examples for script-specific font assignments, document-script
  spellcheck, provider-selected completion, optional providers, and
  document typography.
- Add a user-facing documentation landing page and task-oriented tutorials for
  projects, multilingual tools, long documents, preview synchronization, and
  import/export.
- Add example compilation, language-routing, migration, packaging, and
  documentation-link validation.
- Include post-v0.5.0 bug fixes, performance improvements, and platform
  refinements without introducing a new major subsystem.

The detailed tasks and acceptance criteria are in the
[v0.5.1 examples and documentation implementation plan](./V0_5_1_EXAMPLES_DOCUMENTATION_IMPLEMENTATION_PLAN.md).

## v0.5.2 — maintenance, responsiveness, and safer workflows (released)

Released July 23, 2026.

- Restored debounced PDF render-on-type for responsive short documents while
  retaining render-on-save for long or resource-intensive projects.
- Added PDF Ctrl/Cmd-click link navigation, dependency-aware large-preview
  guards, quieter LSP status reporting, and more reliable preview preservation.
- Added contextual quotation editing, paired-quote deletion, clearer wrapped
  indentation, and fixes for Khmer line-leading caret placement and font
  fallback flicker.
- Added Save As, file duplication, safer inline file creation, duplicate-tab
  prevention, and lifecycle-safe diagnostic restoration.
- Added optional shared-character typography ownership so one configured script
  font can own numbers, punctuation, spaces, and other Common characters.
- Improved language-provider discovery with installed-first ordering and search.
- Changed application updates to stage until an explicit restart or normal
  shutdown instead of installing immediately after download.
- Added read-only Windows WebView2 and Linux WebKitGTK storage monitoring with
  classified usage, bounded history, and non-disruptive growth warnings.
- Documented and tested unsigned macOS distribution without weakening
  Gatekeeper globally.

## v0.5.3 — preview reliability and safeguards (released)

Released July 26, 2026.

- Recover the preview source-map connection and any interrupted pane-resize
  presentation after Windows hibernate or sleep. Continue monitoring this as an
  intermittent issue because WebView2, GPU-driver, and display-scaling resume
  timing can still vary between machines and wake cycles.
- Keep project-opening compilation from competing with UI interaction: reserve
  processor capacity for the WebView, lower compiler priority, batch diagnostic
  rendering, and replace Base64 LSP preview payloads with file-backed raw binary
  IPC.
- Confine every live-preview source mirror, generated PDF, source map, and
  temporary compiler artifact to `.typsastra/cache`; require explicit user
  confirmation before creating or replacing an exported PDF in the workspace.
- Materialize non-Typst render assets as regular hard links where supported,
  with a portable copy fallback, so large asset collections are not duplicated
  merely to preserve complete Typst path resolution.
- Rebuild externally changed previews through one revision-safe pipeline so
  forward and inverse synchronization cannot retain a stale render-cache task.
- Filter oversized Tinymist vector frames from the PDF source-map bridge while
  preserving the small position messages required by forward and inverse sync.
- Decouple source-map warm-up from the active cursor so blank lines, comments,
  directives, and other non-rendered source positions cannot cause a timeout.
- Detect statically discoverable oversized raster images without decoding them.
  When the document uses render-on-type, recommend switching to render-on-save
  while allowing the author to keep the current mode for that asset revision.
  Base the recommendation on individual and aggregate decoded pixel area,
  aggregate source size, and unique image count rather than compressed size
  alone. Mark individually oversized static `#image` calls in the line-number
  gutter and publish the same navigable warnings under a dedicated **Images**
  category in Problems. Guidance must distinguish downscaling for
  decoded-memory and compile pressure from compression for source and
  exported-PDF size. Continue expanding malformed and uncommon-format
  qualification.
- In normal live preview and PDF export, never hide, downsample, convert,
  replace, or otherwise rewrite a source image. Dynamic paths, package
  resources, plugins, unsupported containers, and uncertain metadata must fail
  open with a documented detection limitation.
- Require confirmation before decoding large direct PDFs, reject startup and
  refresh paths that bypass that approval, and cancel stale PDF loads.
- Distinguish direct PDF viewing from live Typst preview: disable source
  synchronization for direct PDFs and use a separate gray viewer surface.

## Incremental research-productivity additions

Research-authoring tools are a rolling workstream rather than one release
milestone. Add them individually between the primary roadmap releases when a
tool is small, portable, tested, and does not delay the release's main goal.
No single release is expected to deliver the complete set.

Candidate additions, introduced one at a time, include:

- figure and caption insertion;
- a table builder;
- equation and matrix insertion;
- bibliography entry management with ordinary `.bib` output;
- template discovery with clear bundled, local, and Typst Universe ownership;
- project-outline restructuring;
- focused feature demonstrations and onboarding improvements.

Each addition must produce clean, editable Typst source and remain useful
without Typsastra. Discipline-specific computation and feature-count
competition remain out of scope. Unfinished productivity tools must move to a
later update rather than block Draft Preview, font management, resource
workflows, portable preview scopes, RTL work, or v1.0 stability.

## v0.6.0 — draft preview and font management (released)

Released July 29, 2026.

Make image-heavy authoring more responsive and make private font dependencies
manageable without changing the portable Typst source model.

- Add **Draft Preview**, a preview-only render mode that replaces statically
  resolvable image calls in Typsastra's private render mirror with lightweight
  layout-preserving placeholders. Each placeholder uses a linked Typst block
  with a fixed-size relative-path label. Explicit `width` and `height`
  values transfer to the block; missing dimensions use a normalized
  ratio-derived fallback, while image-only fitting options are omitted.
  Hovering a placeholder may load the real image as a
  temporary UI overlay on demand, without changing source or including it in
  the compiled draft. Dynamic and unresolved image
  expressions must remain explicit limitations. Draft Preview must be clearly
  labeled, explicitly selected, and never used for final PDF export.
  Placeholder geometry and interaction are qualified for standalone image
  calls and images inside clipped blocks; other image compositions remain a
  documented v0.6.0 limitation and must be validated in Normal Preview.
  See the [Draft Preview implementation plan](V0_6_0_DRAFT_PREVIEW_IMPLEMENTATION_PLAN.md).
- Preserve and clearly communicate the last successful preview across normal
  and draft-preview compilation failures.
- Add private local font folders to Document Typography for fonts that users
  do not want to install system-wide. Store absolute paths only in global,
  machine-local application settings, show each font's origin, reject
  ambiguous family collisions, restart Tinymist when paths change, and apply
  the same paths to diagnostics, preview, source mapping, and PDF export.
  Never copy, archive, redistribute, or write these font binaries into the
  project.
- Publish Draft Preview qualification results covering compilation latency,
  hover overlays, cache behavior, and known layout and retained-memory
  limitations.

## Deferred autocomplete snippets

v0.6.3 added contextual starter values and type-aware Tab stops. The remaining
broader snippet library is deferred until it can fit a focused future milestone
without delaying release stabilization:

- Add commonly used set rules, functions, paragraph formatting, figures,
  images, tables, grids, references, and mathematics constructs incrementally.
- Insert ordinary Typst source with editable tab stops and practical starter
  values that are clearly distinguished from documented defaults.
- Keep Tinymist authoritative for available functions and named arguments, then
  enrich accepted fields with editable, type-aware starter values and Tab stops.
- Preserve non-empty defaults supplied directly by Tinymist and use curated
  overrides only where a practical Typst value is known.
- Keep snippet labels separate from callable forms such as `#par` and `#par[]`
  so templates never replace or reorder the normal syntax choices.
- Preserve portability: inserted snippets must not require a Typsastra runtime.

## v0.7.0 — resource-aware authoring and secondary previews (released)

v0.7.0 was released on August 13, 2026. The delivered scope was verified
against the repository changes since v0.6.3 rather than the earlier plan.

- Added a separate, sanitized Markdown live-preview renderer for `.md` files,
  with debounced updates, theme-aware typography, local images, common
  GitHub-Flavored Markdown constructs, link navigation, and preserved scroll
  position. Markdown preview must not start Tinymist, compile Typst, or discard
  the existing PDF session when switching tabs.
- Added **Image Tools** for local raster inventory, source and decoded-size
  inspection, bounded comparisons, resize/re-encoding previews, Save Optimized
  Copy, and optional updates to all indexed exact static references.
- Added generated scaled-font cache inspection, renewal, deletion, and unused
  variant cleanup while protecting variants used by saved typography settings.
- Added selectable bracket-pair editing, redesigned search, editor scrollbar
  markers, member completion, closure indentation, and preservation of tab
  syntax, history, folds, selections, diagnostics, and scroll state.
- Added structured compiler diagnostics with navigable related call sites.
- Added system-`PATH` Tinymist discovery and hardened managed downloads with
  byte progress, retries, stall detection, and validation timeouts.
- Added a cancellable, renameable import destination step with conflict checks
  and transactional extraction; the project archive schema remains version 2.
- Added native macOS menus and packaging checks plus Linux WebKit/Xlib startup
  and live-preview modifier-state fixes.

The Markdown scope, security boundaries, lifecycle, and release gates are in
the [v0.7.0 Markdown live preview implementation plan](./V0_7_0_MARKDOWN_LIVE_PREVIEW_IMPLEMENTATION_PLAN.md).

## v0.8.0 — Unicode PDF reliability and interoperability

Stabilize the end-to-end multilingual PDF workflow introduced after v0.7.0
without adding another large editor or preview-root architecture.

- Productize the optional, managed Enhanced Unicode Engine v0.4.0 for explicit
  PDF export while keeping Tinymist authoritative for live services.
- Lock the multilingual extraction, PDF-standard, and wide repeated-fill
  regressions into engine release validation on every supported platform.
- Harden standalone PDFium rendering, cancellation, document replacement,
  search, semantic selection, links, outline navigation, zoom, and docking.
- Qualify plain and formatted clipboard reconstruction across complex scripts,
  paragraphs, boxes, and tables.
- Record independent-viewer interoperability instead of inferring it from one
  extraction library.
- Make engine installation, validation, repair, export provenance, and failure
  recovery explicit and actionable.
- Measure first-page latency, zoom recovery, rendered-page residency, repeated
  open/close behavior, and native memory in release builds.
- Preserve ordinary Tinymist export, PDF.js live preview, Markdown, project
  interchange, Khmer, Lao, and global grapheme behavior through regression
  gates.

The work and acceptance criteria are in the
[v0.8.0 Unicode PDF Reliability implementation plan](./V0_8_0_UNICODE_PDF_RELIABILITY_IMPLEMENTATION_PLAN.md).
Release evidence is tracked separately in the
[v0.8.0 qualification checklist](./V0_8_0_RELEASE_QUALIFICATION.md).

Portable Full Document/Active File preview, a broader font manager, resource
workflow expansion, language-provider inheritance redesign, and broad snippet
expansion are not part of v0.8.0. The portable-preview architecture remains in
its [deferred implementation plan](./V0_8_0_ACTIVE_FILE_PREVIEW_IMPLEMENTATION_PLAN.md)
and will receive a release number only when it is scheduled.

## Future pre-1.0 milestone — right-to-left writing

Introduce first-class right-to-left (RTL) editing in a dedicated pre-1.0
milestone covering Arabic-family scripts, Hebrew, and mixed-direction research
documents. Its version number remains unassigned until preceding stabilization
work is complete.

- Establish an RTL conformance suite before adding custom behavior, including Arabic and Hebrew prose, combining marks, selections, cursor movement, deletion, search, copy/paste, and multi-cursor edits.
- Support automatic, LTR, and RTL paragraph direction without reimplementing the Unicode Bidirectional Algorithm.
- Make mixed-direction content reliable when RTL prose contains Latin citations, URLs, numbers, equations, and Typst syntax.
- Add direction-aware alignment and editor controls, plus explicit Unicode direction-isolate commands for ambiguous mixed-direction text.
- Verify diagnostics, completion, spellcheck ranges, source navigation, and editor-to-preview synchronization under bidi layout.
- Keep text direction, script-specific editing policies, language tools, and Typst rendering as separate architectural concerns.
- Add RTL-aware font coverage and recommendations without changing the user's chosen typography automatically.
- Preserve Khmer, Lao, other complex-script, and ordinary LTR editing behavior through regression tests.
- Rebuild and re-enable automatic forward sync only after rapid-click, long-paragraph, included-file, persistent data-plane, timeout, and source-offset reliability tests pass. Explicit toolbar/keyboard forward sync remains available before this milestone.
- Improve manual forward sync beyond Tinymist's current page-and-line result when the compiler can provide a reliable exact cursor x/y coordinate; do not use PDF text matching as a fallback.

## Completed

- Basic UI layout with sidebar, CodeMirror editor, and live preview pane.
- Tinymist LSP integration for preview, diagnostics, forward sync, and cross-zoom scroll synchronization.
- Custom frameless titlebar and native-feel window controls.
- Welcome screen and recent project cache.
- Dynamic file explorer with Material icons and native file operations.
- Persistent workspace state for tabs, cursor positions, split ratios, and save status.
- Visual toolbar for Typst math symbols, snippets, and typography controls.
- Context-aware syntax highlighting, bracket colorizer exclusions, and escaped character handling.
- Native settings panel and versioned `settings.json`.
- Modular local language tools with Khmer and English providers.
- Dynamic language catalog onboarding with download integrity validation, capabilities metadata, and clean uninstallation.
- Experimental Khmer render preparation for preview/export input (subsequently retired).
- Interactive document outline.
- Writable Unicode-focused example workspace.
- GitHub Actions workflow for automated builds.
- Linux build verification.
- Deterministic document-script spellcheck and word completion.
- Searchable recent-project history with bounded workspace restoration.
- Direct PDF viewing and hardware-accelerated, motion-aware PDF preview.
- Signed update detection, About information, and macOS traffic-light controls.
- Portable `.typsastra` state and font-free schema-v2 project archives.
- Explicit Tinymist termination and restart across project ownership changes.

## Pre-1.0 versioning and maturity policy

Typsastra will not declare v1.0 because a particular v0.x number has been
reached. Additional focused releases may continue through v0.10.0, v0.20.0,
v0.99.0, or any other valid pre-1.0 version needed to reach the release gates.

- Assign each v0.x release one coherent product or stabilization theme.
- Prefer bug-fix and qualification releases over combining unrelated unfinished
  subsystems.
- Do not reduce acceptance criteria to fit an announced version number.
- Move unfinished features forward rather than weakening their safety,
  portability, performance, or interoperability contracts.
- Promote to v1.0 only when the v1.0 implementation plan's data-safety,
  migration, accessibility, platform, packaging, project, and long-document
  gates pass in release candidates.
- Treat semantic-version progression as communication, not a deadline or a
  maturity score.

## v1.0 priorities

- Version-bound, font-free `.typsastra` project export with secure import,
  explicit external-font requirements, and installer-registered double-click
  import using the Typsastra icon.
- Per-workspace managed toolchain selection with an explicit compatibility warning when overridden.
- A New Project wizard for blank, technical report, IEEE-style research paper, thesis, and book projects.
- Crash-safe saving, persisted-state migrations, recovery, accessibility, installer verification, and cross-platform release gates.
- Stability, bug fixes, data safety, and Khmer/complex-script regressions take priority over additional features.
- Gesture scrolling and scrollbar-drag release meet the visible-page latency, bounded-concurrency, and canvas-residency gates in the [PDF preview interaction implementation plan](./PDF_PREVIEW_INTERACTION_IMPLEMENTATION_PLAN.md).

The detailed tasks and acceptance criteria are in the [v1.0 release implementation plan](./V1_RELEASE_IMPLEMENTATION_PLAN.md).

## v1.x milestones

The trackable post-release work is in the [v1.x implementation plan](./V1X_IMPLEMENTATION_PLAN.md).

- **v1.1 — stabilization and AI writing foundation:** crash and recovery fixes remain the priority, followed by an opt-in, user-invoked assistant for drafting, rewriting, translation, summarization, and manually requested review through explicit proposed edits.
- **v1.2 — reproducible computation:** explicitly run Python and GNU Octave workflows, with optional user-installed MATLAB integration, and consume generated plots/data in Typst. Project scripts never run automatically. Continue improving bounded AI writing workflows.
- **v1.3 — Git workflows:** repository status, Unicode-safe diffs, staging, commits, branches, history, and safe conflict handling before remote hosting integration. AI may explain user-selected diffs but cannot perform Git mutations implicitly.
- **Across v1.x — Khmer workflow:** revisit Khmer project presets, typography, editing, language tools, source navigation, preview/export, and experimental render preparation using representative documents and native-speaker review. Render preparation remains default-off unless it safely outperforms tuned ordinary Typst justification.
- **Across v1.x — indexed forward sync:** eliminate whole-document source-position scans so exact reveals from included files remain responsive in 500- to 1,500-page projects without loading Tinymist's full vector preview.
- **Later v1.x — optional SVG preview research:** reconsider a bounded SVG
  live-preview path only after v1.0, using measured page-count, output-size,
  latency, and memory budgets. PDF preview remains authoritative, and
  Typsastra must never retain both complete representations.
- **Later v1.x:** global project search, package/dependency inventory, support
  bundles, and additional stable complex-script providers.

## Deferred to v2.x

The long-term research tasks and gates are in the [v2 implementation plan](./V2_IMPLEMENTATION_PLAN.md).

- Real-time/on-type AI grammar and spellcheck integration, including AI squiggles, issue counters, and background proofreading, remains future work after community adoption.
- Manually requested AI grammar or spelling review is allowed in v1.x as an assistant response or proposed edit, with no integration into Language Tools.
- Deterministic dictionary spellcheck and script-aware language tools remain supported and are not replaced by AI.
- Any future WYSIWYM direction is separate from the v1.x code-based authoring roadmap.

## Current release status

Typsastra is beta software. The latest release is v0.7.0; see the
[release notes](./RELEASE_NOTES_V0.7.0.md). Current development targets v0.8.0
Unicode PDF reliability and interoperability. Later pre-1.0 milestones remain
unassigned until their scope is ready, and v1.0 is gated by demonstrated
maturity rather than a predetermined version sequence.
