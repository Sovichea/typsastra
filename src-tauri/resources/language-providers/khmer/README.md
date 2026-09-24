# Khmer runtime dictionaries

These compiled artifacts are generated from the language data pinned by the
`third_party/khmer_segmenter` submodule:

- `khmer_dictionary.kdict` is the unified KDIC v2 artifact used by the v0.3.2
  provider. It supplies deterministic analysis plus the curated spellcheck,
  completion, and correction metadata used by Typsastra's language tools.
  Typsastra selects the visual spelling accuracy together with the reviewed
  practical (community) spelling authority, so COENG DA/TA variants and the
  reviewed legacy variants such as `អោយ` and `ឲ្យ` are accepted. Word
  composition and the completion length cap are baked into the pack by the
  pinned submodule.

It is application runtime data, not an independent editable source of Khmer
vocabulary. Replace it with the bundled Rust KDIC artifact
(`port/rust/data/khmer_dictionary.kdict`) whenever the pinned submodule release
changes.

The source attribution, usage terms, and rebuild procedure are documented in
the pinned submodule's `docs/DATA.md` and `docs/EMBEDDED_DICTIONARY.md` files.
