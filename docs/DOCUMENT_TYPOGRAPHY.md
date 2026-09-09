# Document typography

Typsastra records document fonts and optional scales for each writing script.
One font per script can participate in the ordinary ordered Typst fallback
stack. Additional fonts for the same script can be prepared at independent
scales and called explicitly throughout the document.

## Problems addressed

Typst applies one `size` to every family in a normal fallback stack. Different
scripts can have different visual proportions, so fonts at the same nominal
point size may not look balanced.

A font may also contain glyphs for several scripts. For example, a Khmer family
may contain Latin glyphs. In an ordinary ordered stack, placing that family
first can prevent the intended Latin family from being reached. Typsastra 0.6
uses ordinary Typst fallback order and does not enforce script-specific font
ownership. Strict script routing remains an area for future exploration.

Regex show rules can force another font or size onto a script, but they
reconstruct matching content. Forward and inverse sync can then resolve to a
match or paragraph boundary instead of the intended source character. Typsastra
does not use that approach.

## Default managed Typst rule

By default, Typsastra writes an ordinary Typst fallback stack. Row order has
the same meaning it has in a handwritten Typst document:

```typst
// typsastra:typography:start
// typsastra:document-scripts [{"family":"MiSans Khmer","script":"khmer","scale":0.95},{"family":"MiSans Latin","script":"latin","scale":1.1},{"family":"MiSans Arabic","script":"arabic","scale":1}]
#set text(
  font: (
    "MiSans Khmer",
    "MiSans Latin",
    "MiSans Arabic",
  ),
  size: 11pt,
)
// typsastra:typography:end
```

This is the most portable and predictable default. If an earlier font contains
a requested glyph, Typst uses it; otherwise Typst proceeds through the stack.

## Fallback order and mixed scripts

Ordinary order cannot guarantee a distinct family for every script when an
earlier font contains glyphs for later scripts:

- `("Calibri", "Siemreap")` preserves Calibri for Latin text and normally uses
  it for Western digits and shared punctuation.
- `("Siemreap", "Calibri")` gives Siemreap priority, but its bundled Latin
  glyphs may prevent embedded English from reaching Calibri.

For v0.6, choose the order that best matches the document's dominant
typography. Typsastra deliberately keeps the generated rule simple and
portable. Script-specific enforcement may be introduced later only after its
handling of punctuation, digits, inherited marks, and mixed-script shaping has
been fully defined.

The Document Typography dialog lets authors drag script rows into the desired
priority order. A focused drag handle also supports Up and Down Arrow for
keyboard reordering. This is the actual Typst fallback order.

The metadata comment is ignored by Typst. Typsastra uses it only to restore the
typography configuration and prepare private cached font variants. Language
tools are configured independently from the status bar and stored in portable
`.typsastra/config.json` project metadata. Older typography `language` fields
may seed that project metadata once, but new typography writes omit them.
Retired shared-mark metadata is ignored and removed the next time the rule is
applied.

## Additional scaled fonts

Use **Add font** to configure another family for an existing script. Clear
**Default text font** so the row becomes **Prepared font only**. Typsastra then
prepares and activates its selected scale without adding the family to the
managed `#set text(font: ...)` fallback stack.

For example, Khmer OS can remain the default Khmer text font while Moul is
prepared at a different scale:

```typst
// The directive also records Moul with "defaultText": false.
#text(font: "Moul")[មូល]

#show heading.where(level: 1): it => text(font: "Moul")[it]
```

The family keeps its normal name, so the prepared variant can be used anywhere
Typst accepts a font family. Default and prepared-only font roles do not own
language tools; spellcheck and completion use the independent project language
assignment. The generated variant is machine-local, just like other non-unit
typography scales, so recipients need the same font and Typsastra configuration.

## Private local font directories

Fonts do not have to be installed into the operating system to be used by
Document Typography. Add one or more folders under **Settings → Editor →
Private local font directories**. The font selector then groups families in
this order:

1. Typst built-in;
2. Private local;
3. System fonts.

Global directories belong in **Settings → Editor → Private local font
directories**. A workspace can additionally configure folders in **Document
Typography → Workspace private fonts**. Inside-project folders are recorded as
safe relative paths; folders outside the project are stored as absolute,
machine-local paths. Workspace paths are saved in the ignored
`.typsastra/local.json`, so they are not exported, archived, or shared with a
copy of the project.

Typsastra reads the font files in place and supplies the effective global and
workspace directories to Tinymist diagnostics, live and draft preview, forward
and inverse synchronization, scale-variant generation, and PDF export.
Changing either list restarts the active Tinymist session so every compiler path
sees the same catalog.

A directory is rejected when it contains no supported fonts or when one of its
family names is already supplied by the operating system or another private
directory. This prevents an ambiguous family name from resolving to different
font files between compiler sessions. Typsastra never copies these source font
files into `.typsastra`, the global scaled-font cache, or a project export.
Only a generated non-unit scale variant is written to Typsastra's private
global cache under the existing scaling policy.

Private local compiler fonts do not become CodeMirror editor or application UI
fonts. Those selectors continue to use browser-accessible installed fonts.
Recipients must configure or install the same family themselves; the Typst
source remains ordinary and does not contain the private machine path.

### Supported private font formats

Private directory discovery supports individual TrueType and OpenType fonts
(`.ttf` and `.otf`) and font collections (`.ttc` and `.otc`). Collections can
be used at their original `1.0` scale, but Typsastra cannot generate scaled
variants from an individual face inside a collection.

WOFF and WOFF2 are web-delivery formats and are not loaded from private font
directories. They are ignored when supported desktop fonts are present in the
same directory. A directory containing only WOFF or WOFF2 files is rejected as
having no supported fonts. Obtain a desktop TTF or OTF release from the font
publisher instead of renaming or redistributing the web-font file.

Variable fonts are supported when packaged as TTF or OTF. At `1.0` scale,
Typsastra passes the original file to Tinymist without creating named
instances. Document Typography selects the family and does not expose
arbitrary variation axes; Typst remains responsible for supported weight,
style, and stretch selection. Non-unit scaling preserves the font's variation
tables while changing its em square, but this path is not qualified across all
variable-font implementations and inherits the experimental PDF-scaling
limitation below.

## Uniform script scaling

Every script entry accepts a uniform scale from `0.5` to `2.0`, relative to the
shared document point size. For an `11pt` document, Latin can use `1.1`, Khmer
`0.95`, and Arabic `1.0`; no script has a special base-font role.

Fonts supplied internally by the Typst compiler, such as New Computer Modern,
must remain at `1.0` unless that family is also installed locally. Typsastra
cannot access or extract the compiler's embedded font files to create a scaled
variant. The typography dialog disables the scale field for these fonts. A
manually edited non-unit directive produces an error and is reset to `1.0`
instead of starting font generation. Install a local copy of the family to
enable scaling.

Typsastra treats `0.90×` through `1.10×` as the recommended fine-adjustment
range. Values outside that range require confirmation because script scaling
is intended to balance fonts optically, not to double or substantially change
the document text size. Accurate representation beyond ±10% is not guaranteed
and varies from one font to another.

When a file is selected as the project's main file, Typsastra reads its managed
typography directive before changing the preview target. If its generated font
cache is missing or no longer matches the directive, Typsastra lists the
required scales and asks for confirmation before generating fonts. Cancelling
also cancels the main-file change, so the directive, typography toolbar, font
cache, and Tinymist session cannot silently diverge. An already matching cache
does not prompt again.
Selecting a main file without a managed typography directive clears scaled
fonts left by the previous main file before Tinymist restarts.

Typography directives in non-main files are inert workspace configuration.
They can be edited through source or the typography toolbar without prompting,
generating fonts, or restarting Tinymist. Typsastra evaluates such a directive
only if that file is later selected as the project's main file.

When a scale differs from `1.0`, Typsastra:

1. locates every installed TTF or OTF face in the selected family;
2. creates a uniformly scaled copy by changing the OpenType units-per-em value;
3. recalculates the `head` table and whole-font checksums;
4. writes the result to Typsastra's private application-data font cache;
5. records the selected global variants outside the project and restarts
   Tinymist with only those variant directories in `TYPST_FONT_PATHS`.

Changing units-per-em asks the font engine to interpret outlines, advances,
vertical metrics, and OpenType positioning anchors against a different em
square. Generated fonts retain their original internal family names. The
global cache is private to the local Typsastra installation. Another project
requesting the same font and scale reuses the cached variant without rescaling.
Font bytes and machine-specific cache paths are never written under
`.typsastra`, copied with workspace settings, or included in project exports.
Recipients install the original fonts and reproduce any scale locally.
Typsastra rechecks the main-file directive before starting workspace services,
so a directive changed outside the app cannot silently reuse a stale selection.

Typsastra recommends keeping at most 10 cached scale variants per font face.
Reusing an existing variant never prompts. When a main-file change, toolbar
edit, or direct typography-directive edit would create an additional variant
after that limit, Typsastra asks for confirmation first. It does not delete an
existing variant automatically.

Manage generated variants from **Settings → Storage → Scaled-font cache**.
The cache manager groups variants by family and reports their scale, disk use,
last use, saved workspace references, and whether the original source font is
current, changed, missing, or unavailable to legacy metadata. You can renew a
variant explicitly, delete selected variants, or delete only variants that no
saved workspace selection references. Renewing and deleting referenced
variants restarts the font-dependent workspace services; unused cleanup does
not interrupt the compiler. None of these controls copy source font files into
a project or export.

### Known Typst PDF limitation

Non-`1.0` script scaling is experimental for PDF output. Typst's PDF subsetter
may normalize a generated font back to a 1000-unit em square while retaining
advance widths calculated from the scaled font. When that happens, glyphs keep
their unscaled outlines but occupy scaled horizontal space, which looks like
excessive letter spacing. Typst does not apply this normalization consistently
to every font or scale; for example, a 2x subset may retain a 500-unit em square
while another scaled subset is normalized to 1000 units.

This behavior is reproducible with the Typst CLI and a generated font, without
Typsastra's preview layer. Typsastra therefore does not rewrite the exported
PDF or apply a preview-only correction. Preview and exported PDF intentionally
show the same result. Use `1.0` scales when reliable, portable PDF output is
required, and verify every non-unit scale in the exported PDF with the intended
PDF reader.

The managed source block remains valid Typst. Outside Typsastra, or when the
generated font cache is absent, the original installed family is used and the
metadata scale is ignored. This preserves source compatibility at the cost of
the optional visual scale not being portable.

Two assignments that use the same physical family with different scales are
not supported because both generated copies would have the same internal family
name. Choose separate families or use the same scale for those assignments.

OpenType collections (`.ttc` and `.otc`) are not transformed. Select an
individual TTF or OTF face for scaling.

## Application and boundaries

**Apply to document** inserts or replaces the managed block. **Apply as
template** updates a detected local template or creates
`typsastra-template.typ`, allowing included chapters to inherit the same rule.

Document Typography does not change CodeMirror's source-editor font or Typst
`lang` and `dir`. Its optional language selection does control Typsastra
spellcheck and word completion for the assigned script. A script with no
language is intentionally left unchecked and receives no Typsastra completion.
Typst language scopes and keyboard layouts do not override this selection.
When the file is configured as the workspace main document, these language
assignments are inherited by its included chapters, imported templates, and
imported local libraries. Do not duplicate the directive in each dependency.
Unrelated files remain isolated and may provide their own directive.

An applied template retains separate `typsastra:script-fonts` metadata because
Typsastra needs the original family, script, order, and scale to edit the
generated typography rule. This is typography metadata, not language routing;
it deliberately contains no language-provider assignments.

Typsastra does not override `raw`; inline and block raw content keeps Typst's
normal raw-font behavior.

## Rust and WASM

The pure transformation engine lives in `crates/font-scaler`. Desktop
Typsastra uses its native Rust API. The same crate exposes a WASM binding behind
the `wasm` feature:

```text
cargo check --manifest-path crates/font-scaler/Cargo.toml --features wasm
```

The WASM host supplies font bytes and persists the result. The transformation
engine itself performs no filesystem or system-font access.
