# References and citations

Typsastra reads bibliography data from the `.bib` files already in the project.
The References sidebar is a local index over those files: it does not download
references, contact a citation service, or require a project database.

Open a project and select **References** in the sidebar activity bar.

## Search and inspect entries

The References sidebar lists every parsed entry with its type, title, authors,
year, citation key, and source file. Use the search field to match any of those
values, or filter the list:

- **All references** shows every parsed entry.
- **Cited** shows entries used by at least one `@key` or `cite(...)` call in the
  project's Typst files.
- **Uncited** shows entries with no discovered citation sites.
- **Problems** shows bibliography diagnostics such as duplicate keys,
  malformed entries, and unreadable files.

Selecting an entry opens its details, including all parsed fields, its `.bib`
location, and clickable citation sites. **Open .bib** jumps to the entry source.

## Insert a citation

Double-click an entry, or select it and choose **Insert Citation**. The
insertion follows the surrounding Typst context:

- In markup, Typsastra inserts `@key`.
- In math, it inserts `#cite(<key>)`.
- Inside code, it inserts the bare `cite(<key>)` expression.

Move the editor caret to the insertion point before choosing the entry. The
citation is inserted at the current cursor, not in the `.bib` file. If the
active tab is not a Typst document, switch back to a document first.

## Insert or reveal the bibliography

The Bibliography section at the bottom of the sidebar detects an existing
`#bibliography(...)` call anywhere in the project. When one exists, choose
**Reveal Bibliography** to jump to it; Typsastra does not add a second block.

When no block exists, choose a bundled Typst style and select **Insert
Bibliography**. Typsastra appends a block such as the following to the end of
the project's main document:

```typst
#bibliography("refs.bib", style: "apa")
```

Multiple bibliography files are written as an array with paths relative to the
main document. Custom CSL paths already present in the source remain unchanged.

The style list is bundled with the Typst version Typsastra targets and is never
fetched at runtime. If the project already contains a bibliography block,
Typsastra preserves its style and reveals it instead of replacing it.

## Offline example

Open the bundled `04-research-projects/05-bibliography-and-citations` example
or the [documentation demo project](../demo-project/README.md) to inspect local
BibTeX entries, chapter citations, and a bibliography block. Both are fully
offline. The example's `refs.bib` is ordinary source and can be edited with any
text editor.

## Troubleshooting

- **No .bib files found:** add a `.bib` file anywhere in the workspace. Files
  ignored by `.gitignore` and private workspace directories are excluded from
  project discovery.
- **An entry is missing:** save the `.bib` file, select **Refresh**, then open
  the **Problems** filter and check for malformed entries or duplicate citation
  keys.
- **A citation is not counted as cited:** verify that the citation uses a
  parsed key and is in a `.typ` file inside the workspace. Citations in
  comments, strings, and raw blocks are ignored.
- **The bibliography button is unavailable:** set a main document in the
  project first. If the project already has a bibliography block, use
  **Reveal Bibliography** instead.
