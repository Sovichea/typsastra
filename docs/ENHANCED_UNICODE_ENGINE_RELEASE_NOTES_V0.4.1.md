# Typsastra Enhanced Unicode Engine v0.4.1

This patch release fixes duplicated logical text in PDFs when complex-script
text follows a styled source span. It preserves v0.4.0's public API, visual
positioning, compact glyph namespace, and standard two-byte PDF character
codes.

## Source identity

- Engine version: `0.4.1`
- Typst CLI compatibility: `0.15.1`
- Enhanced Typst revision: `e3a60d5aa897d718b465efc3de0031c7d74efb3b`
- Enhanced Krilla revision: `bb0873416484587814b9ecb682e262056f8effe2`
- License: Apache-2.0

## Changes since v0.4.0

- Normalize mixed-span text batches whose authoritative first item contains a
  separator prefix from a preceding styled span.
- Preserve the foreign prefix exactly once while assigning overlapping visual
  fragments to one logical source sequence.
- Reject ambiguous or non-contiguous mixed-span layouts so they continue
  through the ordinary text path.
- Preserve legitimate repeated text at distinct source positions.

The issue affected valid Khmer source such as:

```typ
#strong[ផ្នែក ក] ក្រសួងប្រៃសណីយ៍។
#strong[Label] ការគ្រប់គ្រងគម្រោង។
```

In v0.4.0, the rendered PDF looked correct, but extraction could duplicate
parts of words—for example, `ក្រសួង` became `ក្រសួសួង` and `គ្រប់គ្រង` became
`គ្រប់ប់គ្រង`. The repaired batch keeps one semantic owner for each overlapping
source interval without deduplicating equal text from separate source offsets.

## Regression validation

The fixed source revision was validated with static Noto Sans Khmer v2.004
Regular and Bold fonts. Poppler, PDFium, and pypdf extracted the authored UTF-8
text exactly, and PDFium search found the repaired words while retaining the
expected count for legitimately repeated control text.

`qpdf --check` reported no syntax or stream-encoding errors. A combined
PDF/A-2b and PDF/UA-1 document passed both veraPDF profiles. Visual inspection
at 144 DPI found no layout, clipping, overlap, or legibility regression.

## Platform packages

The release workflow builds ZIP packages for Windows x64, Linux x64, Linux
ARM64, macOS x64, and macOS ARM64. Each package contains the compatible `typst`
executable, the Apache-2.0 license, and exact source metadata. The generated
`enhanced-unicode-manifest.json` records each archive's byte length and SHA-256
digest for Typsastra's managed installer.

## Release gate

Every platform build must:

1. report the expected Typst 0.15.1 CLI version,
2. compile Typsastra's multilingual Enhanced Unicode fixture,
3. compile the wide repeated-fill regression fixture, and
4. compile PDFs for every supported base PDF version, PDF/A profile, and
   PDF/UA-1 combination before the release is published.

The release gate covers PDF 1.4, 1.5, 1.6, 1.7, and 2.0; all eleven PDF/A
profiles exposed by Typst; PDF/UA-1; and compatible PDF/A-2a+PDF/UA-1 and
PDF/A-3a+PDF/UA-1 combinations. The Linux x64 artifacts are independently
checked with pinned veraPDF 1.30.2. Publication is blocked unless every claimed
PDF/A and PDF/UA profile is reported compliant.

## Scope

This optional engine is used only for explicit PDF export. Tinymist remains
the compiler and language service for live preview, autocomplete, diagnostics,
and source synchronization.
