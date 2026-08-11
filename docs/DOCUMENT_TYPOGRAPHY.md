# Document typography and Font Tools

Typsastra separates two concerns that were previously combined:

- **Document Typography** writes ordinary, portable Typst font and text-size settings.
- **Font Tools** prepares optional machine-local font variants and lets a project activate them.

This keeps the document source understandable without Typsastra while avoiding font binaries in the project.

## Document Typography

Open **Document Typography** from the `Aa` toolbar button. The dialog controls:

- the ordered Typst fallback font stack;
- the document text size;
- one optional language provider assignment per writing script; and
- project-specific private font folders.

Applying the settings writes an ordinary top-level rule:

```typst
#set text(
  font: (
    "Libertinus Serif",
    "Noto Sans Khmer",
  ),
  size: 11pt,
)
```

Font order has normal Typst semantics. Earlier families may supply punctuation, numbers, spaces, or glyphs also present in later families. Typsastra does not insert script-matching show rules or rewrite text runs because those transformations can weaken source portability and precise forward/inverse synchronization.

When updating an existing `#set text`, Typsastra preserves unrelated named arguments. If a document has multiple top-level `#set text` rules and the intended rule is ambiguous, Typsastra stops and asks the author to simplify or choose the source rule manually.

## Language metadata

Language tools need a small Typsastra directive because Typst font selection does not identify the spellcheck or completion provider:

```typst
// typsastra:document-languages [{"script":"latin","language":"en-US"},{"script":"khmer","language":"km"}]
```

This directive contains only script-to-language routing. It does not contain fonts, scale factors, or generated-font paths. The configured main file supplies this routing to related included files and local templates, so the directive does not need to be copied into every chapter.

## Font Tools

Open **Font Tools** from the sidebar activity bar. It provides a machine-local preparation workflow:

1. Select an installed, private-local, or Typst-visible source family.
2. Choose an integer scale from 50% to 200%.
3. Edit the Typst specimen and inspect the actual compiled result.
4. Prepare the named family.
5. Activate it for the current project.

A non-100% variant receives a deterministic alias made from the original family and whole percentage:

```text
Moul + 95% -> Moul 95
```

The alias behaves like a normal font family after activation:

```typst
#text(font: "Moul 95")[Scaled display text]
```

The **Apply to selection** action writes that ordinary Typst expression around the current editor selection. Activated aliases also appear in Document Typography's normal font selector.

Scale 100% uses the original family and does not create a duplicate font. Scaling is intended for fine optical adjustment; Typsastra warns outside 90–110% because large transformations can vary substantially between fonts.

## Storage, reuse, and limits

Prepared variants are stored in Typsastra's global application-data cache, not in `.typsastra` and not beside the source document. This means:

- a matching variant can be reused by multiple projects;
- copying or exporting a project never redistributes the source or generated font;
- project activation remains machine-local; and
- another machine must prepare or provide the same alias before compiling source that names it.

Typsastra recommends no more than 10 variants per font face and asks before creating another. It does not delete variants automatically. If the original font changes, Font Tools marks the prepared variant as changed and offers renewal. If a cached variant is missing, it is shown as missing and can be recreated from its source family.

## Private font folders

Global private font folders are configured in Settings. A workspace can additionally configure its own private folders from Document Typography:

- folders inside the project are stored as relative paths;
- external folders remain absolute and machine-local;
- font binaries are never copied into the project or archive.

Supported compiler font sources are `.ttf`, `.otf`, `.ttc`, and `.otc`. Scaled preparation requires an individual `.ttf` or `.otf` face. Collections remain available at their original size. WOFF and WOFF2 are web-font formats and are not used as Typst compiler fonts. Variable TTF/OTF faces may be used at their default instance, but arbitrary variation-axis preparation is not supported.

Compiler-embedded families cannot be transformed unless Typsastra can locate a corresponding local font file.

## Legacy migration

Older documents may contain `typsastra:document-scripts` or `typsastra:script-fonts` entries with scale factors. When such a document becomes the main file, Typsastra offers a guided migration:

1. prepare deterministic named aliases in the global cache;
2. activate those aliases for the workspace;
3. replace scaled metadata with ordinary font names in `#set text`; and
4. retain only language routing in `typsastra:document-languages`.

Migration is explicit and can be declined. It does not place font data in the project.

## Portability boundary

The Typst syntax remains portable, but a prepared alias is a local font dependency just like any other privately installed family. Share the permitted original font separately and let each collaborator prepare the same percentage, or use a commonly installed unscaled family when exact portability matters more than optical adjustment.
