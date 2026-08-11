# Khmer Spellcheck and Word Completion

Typsastra provides local Khmer segmentation, spellcheck, corrections, and optional word completion through the Rust language-provider registry. The pinned `khmer_segmenter` implementation now owns word boundaries, known-word checks, intended-word diagnostics, correction ranking, and completion ranking. Typsastra retains only the provider-neutral editor contract and the conversion from normalized byte ranges to CodeMirror UTF-16 source ranges.

## Reference implementation identity

Khmer is Typsastra's first Deep language implementation and is the regression baseline for adding other complex scripts.

```text
Provider ID:       khmer-segmenter
Language tag:      km
ISO 15924 script:  Khmr
Support:           Deep · Experimental
Policy contract:   1
Capability schema: 1
Upstream commit:   67a79f64f0c68908345099009765615588da1faa (v0.2.0-rc.2)
```

The gitlink at `third_party/khmer_segmenter` pins the code, curated language data, and normalization behavior. Typsastra rebuilds the KDIC and hyphenation binaries from that revision and stores only those compiled runtime artifacts under `src-tauri/resources/language-providers/khmer/`. RC2 uses the segmenter's single-pass analysis API, which returns segmentation plus spelling diagnostics whose source ranges already map to the original document. `tests/fixtures/khmer/provider.json` records the same commit and exact expected output. Runtime artifacts retain the usage and attribution requirements documented upstream. Changing the submodule, dictionary, normalization, or post-processing requires an intentional fixture update and an explanation in the change review.

Typsastra does not add semantic or LLM-generated boundary repairs after the segmenter. The pinned deterministic output is the lexical baseline even when another compound convention could also be linguistically defensible.

## Reference architecture

```text
CodeMirror transaction
  |
  +-- synchronous script editing policy (frontend)
  |     src/editor/editingPolicies/khmer/
  |     - grapheme tailoring
  |     - cursor and shift-selection boundaries
  |     - backward and forward deletion units
  |     - temporary composition boundary widget
  |     - incomplete-composition editor issue
  |
  +-- revisioned language request (frontend controller)
        src/editor/spellcheck.ts / autocomplete.ts
          |
          +-- provider-neutral Tauri IPC
                analyze_language_ranges
                complete_language_word
                language_suggestions
                  |
                  +-- Khmer provider (Rust)
                        src-tauri/src/segmentation/registry.rs
                        - mapped normalization and segmentation
                        - byte-to-UTF-16 source ranges
                        - upstream intended-word diagnostic mapping
                        - upstream known-word, correction, and completion APIs
                          |
                          +-- pinned khmer_segmenter submodule
```

The editing policy never performs dictionary lookup or IPC. The Rust provider never controls cursor movement or inserts editor-only composition markers. This boundary is required for other languages to add either component independently.

## Khmer behavior inventory

### Frontend editing policy

| Behavior | Owner | Contract |
|:--|:--|:--|
| Script ownership | `khmer/policy.ts` | `Khmr`, Unicode range `[U+1780, U+1800)` |
| Left/right movement | policy registry and `grapheme.ts` | Move between Khmer-tailored grapheme boundaries |
| Shift-selection | policy registry and `grapheme.ts` | Extend by the same readable boundaries |
| Backspace | `khmer/policy.ts` | Delete one code point, except `COENG + consonant` together |
| Forward Delete | `khmer/policy.ts` | Delete the complete following Khmer cluster |
| Dependent marks | `khmer/policy.ts` | Merge with the owned Khmer cluster |
| Temporary boundary | `khmer/composition.ts` | Prevent a newly typed trailing COENG from shaping with an existing next consonant |
| Incomplete composition | `khmer/composition.ts` and spellcheck controller | Publish an editor issue after completion is dismissed or the cursor moves away |
| Invisible marker | composition widget and editor theme | Display editor-only geometry; never modify document text |

### Native language provider

| Behavior | Owner | Contract |
|:--|:--|:--|
| Normalization and source spans | pinned segmenter | Return normalized ranges mapped to original byte ranges |
| Editor offsets | Khmer provider | Convert upstream source-byte boundaries to CodeMirror UTF-16 once |
| Lexical segmentation | pinned segmenter and dictionary | Deterministic dictionary/frequency output |
| Segmentation words | pinned segmenter | May include supplemental forms solely to maintain reliable boundaries |
| Spellcheck validity and prefixes | pinned segmenter | Use the curated spelling vocabulary and completion index; a segmentation-only form is not silently accepted as correctly spelled |
| Completion | `complete_language_word` | Return provider ID, explicit UTF-16 replacement range, and bounded ranked options |
| Current known word | Khmer provider | Put the exact current known word first before longer completions |
| Corrections | pinned segmenter and capability contract | Return ranked corrections for upstream intended-word spans |
| Hyphenation metadata | pinned hyphenation dictionary | Retained in token metadata; not used to insert SHY into editor source |

### Settings and user state

| Setting/state | Effect |
|:--|:--|
| `editor.spellcheck` | Enables unknown-word analysis for all enabled providers |
| `editor.wordCompletion` | Enables provider-advertised typing suggestions independently from spellcheck |
| `typsastra:document-languages` | Assigns the Khmer provider to Khmer text for the configured main document and its local dependencies; the Khmer editing policy remains independent |
| `editor.userDictionary` | Treats exact personal words as known in frontend issue filtering |
| `editor.ignoredWords` | Keeps an informational underline/log entry but excludes the word from problem counts |
| `editor.showZws` | Controls visibility of invisible markers, including temporary composition geometry |
| `preview.khmerRenderPreparation` | Separate experimental rendering pipeline; not part of editor language analysis |

### Native commands

- `get_provider_capabilities` advertises Khmer's actual capability record.
- `analyze_language_ranges` returns normalization-preserving tokens and structured provider failures.
- `complete_language_word` performs segmented prefix completion with an explicit replacement range.
- `language_suggestions` routes correction requests to the pinned segmenter's spelling API.
- `finish_startup_initialization` reloads providers and returns the same versioned capabilities.

## User controls

Script-aware Khmer editing is applied independently from these two user controls:

- **Spellcheck** marks upstream intended-word diagnostics. Right-click an underlined word to apply a ranked correction, add it to the personal dictionary, or ignore it.
- **Typing word suggestions** shows dictionary completions while typing. It can be disabled without disabling spellcheck or Typst/Tinymist code completion.

Personal dictionary entries are normalized, deduplicated, and stored in the `editor.userDictionary` array in Typsastra's platform-specific `settings.json`. Adding a word triggers fresh analysis immediately. Personal entries affect spellcheck only; they do not modify the bundled Khmer dictionary or completion ranking.

## Analysis pipeline

1. CodeMirror invalidates the active document revision immediately after an edit, tab change, close, workspace close, or spellcheck setting change.
2. After the debounce, the editor sends only the edited text ranges (expanded to containing logical lines/runs for boundary stability) in an `analyze_language_ranges` request.
3. The Khmer segmenter normalizes and segments the submitted text while retaining original source byte spans.
4. Typsastra maps these byte boundaries to CodeMirror UTF-16 offsets using a single-pass linear lookup vector ($O(N + T)$) built once per chunk.
5. The frontend applies results only when the document key, revision, and CodeMirror document identity still match.
6. Every replacement verifies that the current source slice still equals the issue's captured source text.

Normalization mapping covers reordered Khmer marks, composed vowel forms, and removed ZWSP, ZWNJ, and ZWJ characters. Normalized text is used for dictionary lookup while underlines and replacements continue to target the original visible source.

### Exact mapping example

For source `😀កំា`, CodeMirror counts the emoji as two UTF-16 units. The provider normalizes the Khmer source cluster to `កាំ` but returns the original source range `[2, 5)`. An underline therefore covers `កំា`, not a reconstructed normalized string.

For completion source `😀សាលារ`, the cursor is at UTF-16 offset `7`. The response replaces `[2, 7)` and can return `សាលារៀន`; the emoji and adjacent source remain untouched.

## Correction suggestions

Khmer correction suggestions are enabled through the provider capability contract. Typsastra calls the segmenter's stable `SpellcheckProfile::Typing` API, which can return a diagnostic spanning more than one lexical segment. Typsastra maps every diagnostic back to one original UTF-16 editor range and sends that same text to `suggest_spelling` when the user opens the correction menu.

The segmenter owns normalization equivalence, reviewed typo rules, candidate bounds, confidence filtering, and ranking. Typsastra does not maintain a second word list or edit-distance index. This keeps segmentation, spellcheck, completion, command-line integrations, and other consumers consistent.

## Word completion

`complete_language_word` receives the active Khmer run and cursor offset. The provider segments the run, evaluates recent token combinations for compound prefixes, and returns an explicit UTF-16 replacement range plus frequency-ranked options. Recombining recent boundaries is necessary for inputs such as `សាលារ`, which may segment as `សាលា` plus `រ` while still being a prefix of `សាលារៀន`.

The frontend refreshes bounded native results after every Khmer character. Accepting a completion replaces only the returned range and does not consume adjacent text.

When the current token is already a known dictionary word, Typsastra includes that exact word as the first completion option before longer ranked suggestions. For example, typing `ការងារ` returns `ការងារ` first so Enter can accept the current word instead of forcing the next candidate.

Word completion remains controlled by the **Typing word suggestions** setting. Disabling it removes dictionary completions while leaving spellcheck, script-aware Khmer editing, and Typst/Tinymist code completion available.

## Known limitations

- The segmenter is a deterministic lexical engine, not a semantic parser. Names, new terminology, slang, and domain-specific words may be returned as unknown.
- Dictionary compounds follow the pinned dictionary and frequency artifacts. Another valid lexical convention may prefer different boundaries.
- Typsastra does not use an LLM or heuristic sentence reconstruction to override deterministic token output.
- Corrections remain lexical and confidence-filtered; they do not infer sentence meaning.
- Completion ranking is dictionary/frequency based and does not model sentence meaning.
- The editing policy owns the main Khmer block `[U+1780, U+1800)`; it does not claim unrelated scripts or generic invisible characters.
- Experimental Khmer render preparation is a separate preview/export transformation and must not be interpreted as spellcheck segmentation.
- A normalization mapping changes lookup text only. Typsastra never silently normalizes or rewrites saved source.

## Validation

Relevant coverage is in:

- `tests/fixtures/khmer/editing.json` for locked boundaries, deletion, selection, mixed text, and multiple cursors;
- `tests/fixtures/khmer/provider.json` for the upstream commit, token output, normalization source spans, and completion ranges;
- `tests/khmerReference.test.ts` for table-driven frontend reference behavior and the editor-only composition invariant;
- `src-tauri/src/segmentation/registry.rs` for normalization ranges, encoding equivalence, completion boundaries, and ranking;
- `tests/spellcheck.test.ts` for stale responses, safe replacement, IPC failures, and personal dictionary behavior;
- `tests/autocomplete.test.ts` for explicit completion ranges and refresh behavior;
- `tests/settings.test.ts` for setting defaults and personal dictionary persistence normalization.

Run the focused regression suite:

```bash
bun run test:khmer
cargo test --lib khmer_reference_provider_fixtures_are_locked
```

The normal `bun test` and `cargo test --lib` commands include these fixtures. `.github/workflows/khmer-regression.yml` also runs them when the editing policy, Unicode utilities, completion, spellcheck, provider, fixture, or pinned submodule changes.

