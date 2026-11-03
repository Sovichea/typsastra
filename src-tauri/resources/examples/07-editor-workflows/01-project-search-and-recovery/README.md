# Project search and recovery

This three-file notebook is a safe workspace for the editor workflows added in
Typsastra v0.10: project search, reviewed replacement, unsaved-work recovery,
the shared main-document outline, and Back/Forward source navigation.

## Set up

1. Open `main.typ` and choose **Set as Main File** if it is not already pinned.
2. Compile the preview once. The document includes both chapters.
3. Keep the Explorer or Outline visible while you work through the exercises.

## Search across the project

1. Open project search with `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS).
2. Search for `canopy`. **Main document only** is enabled by default, so the
   results come from `main.typ` and its included chapters.
3. Clear **Main document only** and repeat the search to see the whole project.
4. Try **Regex** with `canopy|plot` and **Fuzzy** with `cnpy`.
5. Add a filter such as `chapters/**` or exclude `main.typ`.
6. Enable **Match case**, **Whole word**, or **Match diacritics** and compare
   the result count. Select a result and confirm that the editor opens the file
   and selects the match without moving the PDF.

Project search reads unsaved editor buffers before disk. If an open file has
unsaved edits, its search results reflect those edits.

## Review a replacement

1. Search for `canopy` with a literal query.
2. Open the replace field and enter `forest canopy`.
3. Select **Review** rather than **Replace All**.
4. Clear the checkbox for one match, then inspect the before/after lines in the
   review view.
5. Choose **Apply Replacement**. The affected files open as unsaved tabs; the
   source files are not written yet.
6. Use **Undo Replace** in the Search sidebar while the affected buffers still
   match the batch output. Otherwise, undo each file normally.
7. Save or discard the tabs when you are done. Reload the project to restore the
   original source if you do not want to keep the changes.

Matches that would split a grapheme cluster are skipped. If a selected file
changes after the search, the batch stops and the results refresh.

## Review unsaved work

Typsastra snapshots dirty editor text outside the project while you type.

1. Edit a paragraph in `main.typ` and leave the tab unsaved.
2. Wait a few seconds for the idle snapshot.
3. Continue editing another file; inactive dirty tabs are snapshotted too.
4. After an unexpected exit, reopen this project. Typsastra offers the available
   snapshots and shows a unified diff before restoring one.
5. Restore a snapshot as an unsaved buffer, review it, then save it or discard
   it. A restored buffer never overwrites the file on disk automatically.

Recovery data is machine-local and is not part of the project archive.

## Shared outline and source navigation

1. Open `chapters/01-observations.typ` from Explorer.
2. The Outline still shows the whole main document. Headings from the active
   chapter are emphasized; headings from other files are muted.
3. Select a heading in another chapter. Open the outline again and confirm that
   its expansion and selection survived the tab change.
4. Open the tab-list menu at the right edge of the tab bar and choose
   `main.typ`.
5. Use `Alt+Left` and `Alt+Right`, or your configured shortcuts, to retrace
   source jumps from search, the outline, definitions, diagnostics, inverse
   sync, Explorer opens, and tab selections.
6. Return to a previous location and confirm that the editor selection and
   viewport are restored without recompiling the preview or moving the PDF.

## Extend the exercise

- Add a `chapters/03-review.typ` file, include it from `main.typ`, and search
  again.
- Rename a heading and confirm that the Outline updates.
- Make two files dirty, then inspect the Recovery view after a restart.
- Export a PDF or project archive to confirm that generated preview data and
  recovery snapshots stay outside the source tree.
