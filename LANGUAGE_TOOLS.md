# Language Tools Providers

Typstry's editor spellcheck, correction suggestions, and typing word suggestions are routed through a provider registry in `src-tauri/src/segmentation/registry.rs`.

The frontend remains provider-neutral:

- CodeMirror asks Rust for provider capabilities.
- Incremental editor ranges are sent to `analyze_language_ranges`.
- Correction popups call `language_suggestions` with the provider ID stored on the issue.
- Typing suggestions call `complete_language_word` with the active provider ID.
- Replacements are still guarded by document key, revision, document identity, and source text.

## Bundled providers

### Khmer

Provider ID: `khmer-segmenter`

Khmer uses the pinned `third_party/khmer_segmenter` implementation for normalization-preserving segmentation, dictionary checks, correction ranking, and completion. See [Khmer Spellcheck and Word Completion](./KHMER_SPELLCHECK.md).

### English (US)

Provider ID: `hunspell:en_US`

English is bundled by default under `src-tauri/resources/dictionaries/hunspell/en_US/`.

The dictionary files are Hunspell-format `en_US.aff` and `en_US.dic` from the LibreOffice dictionaries repository, derived from SCOWL. License/source details are retained in `README_en_US.txt` and summarized in `metadata.json`.

Typstry uses the pure-Rust `spellbook` engine to read Hunspell-compatible dictionaries. This avoids requiring a system Hunspell installation or shipping platform-specific native Hunspell libraries.

English support uses:

- Spellcheck and correction suggestions from `spellbook`.
- A Typstry-built prefix index from `.dic` stems for typing word suggestions.
- Conservative editor token filtering to avoid marking obvious Typst commands, identifiers, URLs, email fragments, acronyms, and one-letter fragments.

## Future Hunspell-compatible languages

Additional languages should be added as dictionary resources plus metadata:

```text
src-tauri/resources/dictionaries/hunspell/<locale>/
  <locale>.aff
  <locale>.dic
  README or LICENSE
  metadata.json
```

The provider registry should instantiate one provider per enabled/installed language ID, e.g. `hunspell:fr_FR`.

For languages with reliable whitespace or Unicode word boundaries, a Hunspell-compatible provider can provide full basic spellcheck/correction support quickly.

For languages that require segmentation, such as Thai, the Hunspell-compatible provider should be treated as a basic fallback:

- Use dictionary-derived segmentation/tokenization when no custom segmenter exists.
- Mark provider capabilities with a lower boundary quality when that metadata is surfaced.
- Let a future custom provider replace the fallback without changing the editor contract.

Provider-specific language logic belongs in Rust providers. Generic frontend controllers should not hardcode language-specific script regexes or dictionary behavior.
