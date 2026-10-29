# Search a project

Project search finds text across the files in the current workspace without
opening each file first. It uses unsaved editor buffers when a file is open and
reads UTF-8 files from disk otherwise.

Open it from the magnifier in the activity bar, **Edit → Search Project**, or
`Ctrl+Shift+F` (`Cmd+Shift+F` on macOS). The Search panel replaces the sidebar
content; the editor and PDF preview stay visible.

## Search modes

- **Literal** searches for the text as entered. Match case, Whole word, and
  Diacritics use the same behavior as editor Find.
- **Regex** treats the query as a regular expression. Capture syntax and Unicode
  matching match editor Find. A single file whose expression takes longer than
  one second is stopped and the results are marked incomplete.
- **Fuzzy** ranks ordered subsequences in relative file paths and source lines.
  Path matches appear in their own section. Whole word, diacritics, and regex
  controls are disabled in this mode.

## Filters

Use **Filters** to add comma- or newline-separated include and exclude globs:

```text
chapters/**, *.typ
**/draft-*, *.bib
```

Patterns without a slash apply to the file name. `**` crosses directory
boundaries and `*` does not. Files ignored by `.gitignore`, binary files, files
larger than 10 MiB, and generated application data are skipped by default.
Enable **Include ignored files** to search ignored paths as well.

## Results

Results are grouped by relative file path and show line numbers and highlighted
excerpts. Select a content result to open its file and select the match without
moving the PDF. Selecting a fuzzy path match opens the file without selecting a
source range.

Queries run in a background worker after a short typing pause. Typsastra cancels
work for an older query and shows at most 20,000 matches; the status line reports
truncated or incomplete results. Changed files are checked before navigation. If
a file changed since the result was produced, the search refreshes instead of
applying stale offsets.

## Limits and privacy

Project search stays inside the workspace. It does not search generated app
caches, project archives, binary files, or paths outside the workspace. Query
text and results are session-only; they are not written to project settings.
