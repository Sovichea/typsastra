# Enhanced Unicode Engine validation

Typsastra's Enhanced Unicode Engine is experimental. Its PDF output must be tested independently for:

1. logical Unicode extraction,
2. copy and paste,
3. search,
4. text-selection geometry, and
5. behavior across independent PDF viewers.

Successful extraction in one library is not proof that every PDF viewer will draw correct selection rectangles. The validation harness therefore reports logical text and geometry separately.

## Run the automated comparison

Build the enhanced Typst fork in release mode, then run:

```sh
bun run validate:enhanced-unicode
```

By default, the harness compares the `typst` executable on `PATH` with a sibling checkout at:

```text
../typst-unicode-pdf/target/release/typst
```

Override either executable when needed:

```sh
bun run validate:enhanced-unicode -- \
  --baseline /path/to/official/typst \
  --enhanced /path/to/enhanced/typst
```

On Windows, `.exe` paths are accepted normally. The environment variables `TYPSASTRA_BASELINE_TYPST` and `TYPSASTRA_ENHANCED_TYPST` provide the same overrides.

Generated artifacts are written to:

```text
artifacts/enhanced-unicode/
├── baseline.pdf
├── enhanced.pdf
├── report.json
└── report.md
```

The command is diagnostic by default, so incomplete engine work still produces a comparison report. Once the enhanced engine is expected to pass every automated check, use strict mode in its release workflow:

```sh
bun run validate:enhanced-unicode -- --strict
```

## Test corpus

The fixture at `tests/fixtures/enhanced-unicode/unicode-selection.typ` contains directly authored, labeled lines for:

- precomposed Latin text,
- decomposed combining sequences,
- Khmer,
- Arabic,
- Devanagari,
- Thai,
- Lao,
- mixed-script text, and
- punctuation and Khmer digits.

Directly authored lines keep Typsastra source navigation meaningful and avoid hiding exporter defects behind generated content.

## Automated results

For each case, the harness records:

| Check | Meaning |
|---|---|
| Exact logical text | Extracted Unicode is byte-for-byte equivalent to the authored line. |
| Whitespace-insensitive text | The logical characters survive, but the viewer may be inferring unwanted spaces between positioned units. |
| Geometry | PDF.js text items are finite and remain within page bounds. |
| Unexpected controls | Extracted C0 control characters indicate an invalid Unicode mapping. |

The PDF.js check uses Typsastra's pinned `pdfjs-dist` patch with `preserveLogicalText`. It tests the logical-text items used by standalone PDF selection, search, and Typsastra's custom clipboard serialization.

## Use a local engine in Typsastra

Developer mode can use the enhanced `typst` executable from the Typsastra
engine release, or a compatible local build, for an explicit **Export PDF**
operation:

1. Open **Settings > Developer** and enable **Developer mode**.
2. Enable **Enhanced Unicode PDF engine** to download and install the pinned,
   checksummed v0.4.0 package for the current platform.
3. Alternatively, choose a compatible local executable built from the pinned
   enhanced Typst fork.
4. Leave **Use for PDF export** enabled and export the document normally.

Typsastra validates a locally selected executable with `typst --version` when
it is selected and again before export. Managed installation verifies the
release archive's expected byte length and SHA-256 before extracting it into
Typsastra's application-local toolchain directory. The setting stores only the
validated executable's absolute local path.

This integration intentionally has a narrow boundary:

- live preview still uses the selected Tinymist toolchain,
- LSP, autocomplete, forward sync, and inverse sync still use Tinymist,
- disabling Developer mode restores the normal Tinymist export path, and
- an invalid or missing enhanced executable stops export with an explicit
  error instead of silently producing a normal PDF.

The automated geometry result only verifies that PDF.js produces finite rectangles contained by the page. It does not prove that those rectangles align accurately with every painted complex-script glyph. Viewer selection alignment remains part of the manual compatibility matrix.

In this mode, enhanced PDFs preserve authored space glyphs and PDF.js does not
infer additional spaces from the distance between positioned logical units. The
patch covers both PDF.js's browser build and the legacy Node build used by the
automated validator, so the report exercises the same extraction semantics as
Typsastra's standalone preview.

A 2026-08-26 rerun with the published Enhanced Unicode Engine v0.3.1 Windows
archive returns exact patched-PDF.js extraction for 8 of 10 cases and bounded
geometry for all 10. Arabic is exact. Devanagari still contains invalid control
characters from unsupported collection-font mappings, and the mixed fixture
inherits that Devanagari failure. The tested archive was 23,310,845 bytes with
SHA-256 `e087ebd335c20a5273796803f9244526916e13900e71e010ce59de7720d31faf`;
its executable reports `typst 0.15.1 (75202cf0)`.

## Viewer compatibility matrix

The generated report contains an automated PDF.js row and placeholders for manual testing in:

- Adobe Acrobat Reader,
- Microsoft Edge,
- Google Chrome,
- Firefox, and
- macOS Preview.

### Published Khmer viewer evidence carried forward to v0.4.0

The original [Typst Forum announcement](https://forum.typst.app/t/typsastra-enhanced-unicode-engine-for-better-unicode-in-pdfs/9709)
published a viewer matrix on 2026-08-21. It tested an Enhanced Unicode Engine
v0.1.0 Khmer article using Khmer OS fonts. The search term `អក្សរ` appears 12
times in the source:

| Viewer | Tested version | Render | Selection | Copy/paste | Search |
|---|---|---|---|---|---|
| Chrome | 151.0.7922.174 (Official Build, 64-bit) | Pass | Pass | Pass | 12/12 |
| Brave | 1.94.117 (Official Build, 64-bit) | Pass | Pass | Pass | 12/12 |
| Microsoft Edge | 151.0.4129.107 (Official build, 64-bit) | Pass | Pass | Pass | 12/12 |
| Okular | 25.08.1 | Pass | Pass | Pass | Pass |
| SumatraPDF | 3.6.1 | Pass | Pass | Pass | Pass |
| Adobe Acrobat | 2022.001.20085 | Pass | Pass | Pass | 6/12 |
| Firefox | 154.0.1 (64-bit) | Pass | Partial | Partial | 0/12 |
| ONLYOFFICE Desktop Editors Community | 9.3.1.8 (x64 exe) | Pass | Pass visually | Fail | 0/12 |
| Typsastra | 0.8.0 | Pass | Pass | Pass | 12/12 |

The same post records exact extraction for all 18 tested Khmer OS fonts with
PDFium, PyMuPDF, Poppler `pdftotext -raw`, and Poppler `pdftotext -layout`.
The v0.4.0 release notes carry this matrix forward without changing any result.
This preserves the published compatibility results and now records the tested
application versions. The operating systems used for the original matrix were
not recorded.

### Verified Typsastra standalone preview

Typsastra now renders directly opened PDFs with bundled PDFium. PDF.js remains
the engine used by the automated comparison above and by live Typst previews;
the standalone viewer uses PDFium so its painted page, extracted characters,
and selectable geometry come from the same native PDF engine.

`bun run validate:pdfium-unicode` compiles the fixture, extracts characters
through bundled `pdfium-bundled 0.1.1`, passes them through the production
`buildPdfiumTextRuns()` adapter, and compares every labeled line exactly. A
2026-08-26 run against the same published v0.3.1 Windows archive produced:

| Capability | Result |
|---|---|
| Exact reconstructed text | 9/10 labeled cases |
| Combining Latin, Khmer, Devanagari, Thai, and Lao | Exact |
| Arabic | The Latin label and Arabic sentence are returned as one reversed visual run |
| Mixed script | Exact for the current fixture |
| Selection bounds | Requires manual viewer confirmation |
| Complex-script rectangle alignment | Requires manual viewer confirmation |

PDFium avoids the invalid Devanagari mappings exposed by PDF.js, while PDF.js
extracts the Arabic line exactly. This isolates the remaining failure to bidirectional run ordering
in Typsastra's PDFium adapter rather than missing Unicode data in the v0.3.1
export. Keep it visible in the compatibility matrix until the labeled Arabic
line reconstructs exactly.

For every viewer, manually record:

1. whether a complete labeled line can be selected without rectangles extending outside the page,
2. whether copied text matches the fixture exactly,
3. whether searching the exact authored sequence finds the line, and
4. whether mixed-direction selections remain visually attached to the selected text.

This matrix describes viewer compatibility; a viewer failure does not by itself prove that the exported PDF is invalid. A regression shared by multiple independent viewers is stronger evidence of an export defect.

## Automated PDF standards validation

The engine release workflow compiles the standards fixture with every PDF
standard supported by the pinned Typst revision:

- PDF 1.4, 1.5, 1.6, 1.7, and 2.0;
- PDF/A-1a, PDF/A-1b, PDF/A-2a, PDF/A-2b, PDF/A-2u, PDF/A-3a, PDF/A-3b,
  PDF/A-3u, PDF/A-4, PDF/A-4e, and PDF/A-4f;
- PDF/UA-1; and
- combined PDF/A-2a+PDF/UA-1 and PDF/A-3a+PDF/UA-1 output.

Base PDF versions are checked against their binary headers on every release
platform. The Linux x64 release package is additionally validated with
veraPDF 1.30.2, pinned by archive checksum. The release cannot be published
unless veraPDF reports every claimed PDF/A and PDF/UA profile compliant.

Run the same matrix locally with:

```powershell
python scripts/validate-enhanced-unicode-pdf-standards.py `
  --typst C:\path\to\typst.exe `
  --output-dir $env:TEMP\typsastra-pdf-standards `
  --verapdf C:\path\to\verapdf.bat
```

Conformance validation complements, rather than replaces, the viewer matrix:
standards validators test the PDF's declared structure while manual viewer
tests expose selection, search, clipboard, and geometry interoperability.

## Engine release 0.4.1

The current reproducible engine packages are defined by
[`release-v0.4.1.json`](../toolchains/enhanced-unicode/release-v0.4.1.json) and
published from this repository under the scoped tag
`enhanced-unicode-v0.4.1`. Keeping the artifacts in the Typsastra repository
avoids presenting the Typst fork as an unrelated or official upstream binary.

The release workflow also compiles
`tests/fixtures/enhanced-unicode/wide-repeated-fill.typ` with every platform
binary. This retains the fallback for logical units that would otherwise
exceed signed 16-bit TrueType component coordinates.

The release remains explicitly opt-in and separate from Tinymist. It is used
only for explicit PDF exports and never replaces live preview, LSP,
autocomplete, diagnostics, or source synchronization. See the
[v0.4.1 engine release notes](ENHANCED_UNICODE_ENGINE_RELEASE_NOTES_V0.4.1.md)
for pinned source revisions, supported packages, and current validation scope.
