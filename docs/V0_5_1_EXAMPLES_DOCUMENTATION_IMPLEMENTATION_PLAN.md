# Typsastra v0.5.1 Examples and Documentation Implementation Plan

## Objective

Make the multilingual foundations introduced in v0.5.0 easy to learn, verify,
and reuse. v0.5.1 will reorganize the bundled example workspace into a guided
learning path and add task-oriented tutorials that match the released user
interface and current product boundaries.

This is a documentation and maintenance milestone. It does not pull the
research builders planned for v0.6.0 or first-class RTL editing planned for
v0.9.0 into v0.5.1.

## Completion rule

Tasks use stable IDs such as `V051-E.1`. A task is complete only when its
content, links, automated checks, and relevant screenshots have been updated
together. Every documented action must be tested from a clean installation or
a newly prepared examples workspace.

## Guiding principles

1. Examples teach one concept at a time before combining concepts in projects.
2. Example source remains ordinary, portable Typst source.
3. Optional language providers are declared as prerequisites; missing-provider
   warnings are demonstrated intentionally rather than treated as failures.
4. Spellcheck follows the Typst language scope. Completion may follow the
   keyboard language, and the examples must never conflate the two.
5. Bidirectional rendering examples must not claim first-class RTL editing
   support before v0.9.0.
6. Bundled examples contain no generated PDFs, caches, downloaded dictionaries,
   or redistributable font packages.
7. Existing user-modified example copies must not be overwritten or silently
   deleted during the restructuring.

---

## Phase 0: Inventory and migration contract

- [x] **V051-P.1 Record the current example inventory.** Map every current
  example to its new location, replacement, or retirement reason. Keep coverage
  for basics, mixed scripts, complex-script shaping, language tools, Lao,
  project structure, and long-form Khmer documents.
- [x] **V051-P.2 Define the installed-example migration behavior.** Install each
  release into a versioned Documents folder and keep a versioned examples-state
  file. Never overwrite, prune, or reopen an older release's writable examples.
- [x] **V051-P.3 Establish terminology and support labels.** Use the same names
  everywhere for script-font assignments, explicit language scope,
  provider, project main file, included file, standalone preview, and workspace
  state.
- [ ] **V051-P.4 Capture a clean-install baseline.** Record the current Open
  Examples flow, example compilation status, provider prerequisites, broken
  links, and screenshots that need replacement.

### Phase 0 exit gate

- Every existing example has an explicit disposition.
- Updating examples cannot overwrite a modified user copy.
- Documentation terminology agrees with Settings and the application UI.

---

## Phase 1: Restructure the example workspace

Use the following learning-oriented structure:

```text
src-tauri/resources/examples/
├── START-HERE.typ
├── README.md
├── 01-basics/
│   ├── 01-writing-basics/
│   └── 02-unicode-math/
├── 02-multilingual-writing/
│   ├── 01-script-font-assignments/
│   ├── 02-language-scoped-spellcheck/
│   ├── 03-keyboard-language-completion/
│   ├── 04-complex-script-typography/
│   └── 05-script-and-direction-samples/
├── 03-language-providers/
│   ├── 01-khmer-deep-support/
│   ├── 02-khmer-segmentation-comparison/
│   ├── 03-lao-enhanced-support/
│   └── 04-optional-dictionaries/
├── 04-research-projects/
│   ├── 01-multilingual-article/
│   ├── 02-simple-thesis/
│   ├── 03-khmer-folklore-book/
│   └── 04-typsastra-readme/
└── 05-project-portability/
    ├── 01-main-and-included-files/
    ├── 02-portable-workspace-state/
    └── 03-font-free-project-export/
```

- [x] **V051-E.1 Rewrite `START-HERE.typ`.** Present a short recommended path,
  identify which examples require optional providers, and link readers to the
  matching tutorials. Keep it useful as the file opened by the welcome screen.
- [x] **V051-E.2 Add an examples landing README.** Explain how writable example
  copies are installed and updated, how to reset an untouched example, and why
  an edited legacy example may remain after an application update.
- [x] **V051-E.3 Build the primary/embedded-script example.** Demonstrate one
  script-specific font assignments, typography font stacks, and
  the boundary between document typography and language-provider routing.
- [x] **V051-E.4 Build the language-scope example.** Cover `#set text(lang: ...)`,
  `#text(lang: ...)[...]`, `#block[...]`, anonymous `#[...]`, nested scopes,
  included files, and same-script languages such as English, French, and
  Spanish. Show that an unavailable provider disables spellcheck only for that
  explicit scope and marks its `lang` declaration.
- [x] **V051-E.5 Separate keyboard-language completion from spellcheck.** Add a
  focused example and instructions showing that keyboard selection changes
  suggestions but never changes the authoritative document spellcheck scope.
  Include IME and unsupported-keyboard-layout expectations.
- [x] **V051-E.6 Preserve complex-script coverage.** Retain Khmer deep support,
  segmentation comparison, Lao enhanced support, CJK layout, and representative
  shaping samples without promising capabilities that are not implemented.
- [x] **V051-E.7 Reframe the bidirectional sample.** Label Arabic/Hebrew content
  as Typst/browser rendering coverage only. State that first-class direction-
  aware editor behavior is planned for v0.9.0.
- [x] **V051-E.8 Promote the multilingual article into the guided project set.**
  Make it the combined example for scoped language tools, included files,
  terminology, and primary/embedded-script typography. Avoid maintaining a
  second divergent copy under `templates/`.
- [x] **V051-E.9 Add project-portability demonstrations.** Explain configured
  main files, included-file preview ownership, `.typsastra/config.json`, lazy
  workspace restoration, and font-free archive export. Do not commit generated
  preview or exported files.
- [x] **V051-E.10 Give every non-trivial example a README.** Each README must
  contain purpose, prerequisites, steps, expected behavior, limitations, and a
  link to the corresponding full tutorial.

### Phase 1 exit gate

- A new user can follow the examples from basics to a complete multilingual
  multi-file project without guessing the intended order.
- French and Spanish scopes never fall back to English spellcheck merely
  because they share the Latin script.
- Missing optional providers visibly demonstrate the language warning workflow.
- No example implies that RTL editor conformance is already shipped.

---

## Phase 2: Build the documentation learning path

Add a documentation landing page and task-oriented tutorials:

```text
docs/
├── README.md
└── tutorials/
    ├── GETTING_STARTED.md
    ├── PROJECTS_AND_MAIN_FILES.md
    ├── MULTILINGUAL_SPELLCHECK.md
    ├── KEYBOARD_LANGUAGE_COMPLETION.md
    ├── DOCUMENT_TYPOGRAPHY.md
    ├── LANGUAGE_PROVIDER_INSTALLATION.md
    ├── LONG_DOCUMENT_WORKFLOW.md
    ├── PDF_PREVIEW_AND_SYNC.md
    ├── PROJECT_IMPORT_AND_EXPORT.md
    └── TROUBLESHOOTING.md
```

- [x] **V051-D.1 Add `docs/README.md`.** Separate tutorials, user reference,
  contributor architecture, release information, and implementation plans so
  users are not sent first to internal design documents.
- [x] **V051-D.2 Write the getting-started tutorial.** Cover opening a project,
  opening examples, choosing a main file, editing, saving, preview modes,
  exporting PDF, and locating Settings and About.
- [x] **V051-D.3 Document projects and main files.** Explain project identity,
  main versus included files, standalone preview, workspace restoration, large-
  file confirmation, moving a project, and which state belongs in `.typsastra`.
- [x] **V051-D.4 Document multilingual spellcheck.** Explain scope precedence,
  named and anonymous content blocks, nested and included-file scopes,
  unavailable-provider warnings, same-script isolation, mixed-script behavior,
  and global/project/language-family terminology.
- [x] **V051-D.5 Document keyboard-language completion.** Explain supported OS
  behavior, fallback behavior, IME interaction, provider availability, and why
  completion language does not override spellcheck scope.
- [x] **V051-D.6 Update document typography guidance.** Connect primary and
  embedded-script settings to ordered font stacks and distinguish font coverage
  from spelling, segmentation, completion, and text direction.
- [x] **V051-D.7 Write the provider installation tutorial.** Cover bundled and
  optional providers, integrity checks, enable/disable behavior, removal,
  unavailable-scope recovery, and the developer spellcheck log.
- [x] **V051-D.8 Document long-document workflows.** Cover render-on-save,
  guarded large-file opening, page navigation, instant forward sync, warmed
  source-map sessions, memory expectations, and when restarting Tinymist is
  appropriate.
- [x] **V051-D.9 Document preview and synchronization.** Explain live versus
  direct-PDF preview, page input, forward/inverse sync limits, last-good preview,
  Linux DMA-BUF compatibility, and relevant troubleshooting logs.
- [x] **V051-D.10 Document import and export.** Explain font-free project
  archives, excluded caches and generated PDFs, external font requirements,
  portable workspace settings, and ordinary PDF export.
- [x] **V051-D.11 Consolidate troubleshooting.** Link focused tutorial sections
  from `docs/TROUBLESHOOTING.md` and remove duplicated or obsolete instructions.
- [x] **V051-D.12 Update top-level navigation.** Link the documentation landing
  page and most important tutorials from `README.md`, while retaining direct
  links to architecture and contributor references.

### Screenshot policy

Screenshots should be used only where they clarify state that prose cannot show
quickly. Capture them at a consistent scale and theme, crop to the relevant UI,
add useful alt text, and store them under `docs/assets/tutorials/` with stable,
descriptive names.

Required visual candidates:

- missing language-provider warning and tooltip;
- primary and embedded-script typography settings;
- Language Tools provider installation;
- main-file and standalone-preview actions;
- page navigation and source synchronization;
- large-file confirmation state;
- project export exclusions or summary.

### Phase 2 exit gate

- A clean-install user can complete every tutorial without consulting source
  code or an implementation plan.
- Every screenshot and command matches v0.5.1.
- User documentation clearly distinguishes shipped, experimental, and planned
  behavior.

---

## Phase 3: Validation and release integration

- [x] **V051-Q.1 Extend Rust example-integrity tests.** Assert that required
  entry files exist, include paths remain within the example workspace, retired
  managed paths migrate safely, and forbidden generated/cache/font files are
  absent.
- [x] **V051-Q.2 Compile ordinary Typst examples.** Compile every designated
  `main.typ` with the managed toolchain in CI or a deterministic validation
  script. Explicitly classify examples that require optional fonts or packages.
- [x] **V051-Q.3 Add language-scope regressions.** Parse the shipped
  multilingual fixtures and assert English/French/Spanish isolation, nested
  block inheritance, included-file behavior, and missing-provider declarations.
- [x] **V051-Q.4 Add documentation link validation.** Check local Markdown
  links, referenced example paths, image paths, and heading anchors.
- [x] **V051-Q.5 Verify package contents.** Confirm all examples, READMEs,
  tutorials, and tutorial assets are included in development and release bundles
  without adding generated project output.
- [ ] **V051-Q.6 Run cross-platform content review.** Validate Windows, Linux,
  and macOS instructions separately and mark platform-specific behavior instead
  of assuming parity.
- [ ] **V051-Q.7 Perform clean-install walkthroughs.** Test Open Examples,
  tutorial order, optional-provider installation, main-file selection, project
  export, and update behavior from v0.5.0 to v0.5.1.
- [x] **V051-Q.8 Prepare v0.5.1 release notes.** Summarize the learning-path
  redesign, documentation additions, post-v0.5.0 language-tool fixes, and other
  maintenance changes without presenting documentation work as a new subsystem.
- [x] **V051-Q.9 Add first-open release guidance.** Show a concise changelog
  once per application version and link to the complete release notes.

## Final acceptance criteria

- The bundled examples expose every major v0.5.0 multilingual workflow.
- The example hierarchy has one clear learning sequence and no duplicated
  authoritative multilingual template.
- Existing edited example copies survive the upgrade.
- Every ordinary example compiles or declares a precise optional prerequisite.
- English spellcheck cannot leak into explicit French or Spanish scopes.
- Missing dictionaries produce the documented declaration hint and gutter
  warning.
- Keyboard-language completion is demonstrated independently of spellcheck.
- No bundled project contains generated PDFs, caches, downloaded providers, or
  font binaries.
- Documentation has a user-facing landing page, no broken local links, and no
  obsolete screenshots.
- Shipped, experimental, and planned capabilities are clearly labeled.

## Remaining manual follow-up verification

The implementation, automated gates, v0.5.1 version bump, and release notes are
complete. The following manual verification items remain useful follow-up work:

- `V051-P.4`: capture the clean-install visual baseline and replacement list;
- tutorial screenshots under `docs/assets/tutorials/`;
- `V051-Q.6`: review platform-specific wording on Windows, Linux, and macOS;
- `V051-Q.7`: complete clean-install and v0.5.0-to-v0.5.1 upgrade walkthroughs.

Record any platform-specific findings as maintenance corrections without
changing the shipped v0.5.1 feature contract.

## Recommended execution order

```text
Inventory and migration contract
  -> example hierarchy and focused fixtures
  -> example READMEs
  -> user documentation landing page and tutorials
  -> automated compilation, scope, and link validation
  -> clean-install and upgrade walkthroughs
  -> v0.5.1 release notes
```

Content should be written alongside each example rather than after all examples
are complete. That keeps tutorial claims executable and prevents the examples
and documentation from drifting apart during the restructure.
