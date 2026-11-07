# Bibliography and citations

Set `main.typ` as the project main file. This focused example demonstrates a
local BibTeX bibliography, citations in an included chapter, and ordinary
Typst cross-references.

- `refs.bib` owns the bibliography entries.
- `chapters/01-references.typ` cites entries with `@key` and refers to the
  chapter heading and citation table with `@sec:...` and `@tab:...`.
- `main.typ` includes the chapter and inserts the bibliography with
  `#bibliography("refs.bib", style: "apa")`.

The example is offline: no DOI lookup, remote bibliography service, or network
access is required. Open it in Normal Preview to see the rendered citations and
bibliography.

Tutorial: <https://github.com/Sovichea/typsastra/blob/main/docs/tutorials/PROJECTS_AND_MAIN_FILES.md>
