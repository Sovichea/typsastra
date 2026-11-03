# Linked table

This example demonstrates the current Table Tools workflow: a project-owned
table model, a `//@table:<id>` anchor, and a managed Typst block that stays in
sync with the builder.

The example intentionally ships only the generated source, not a stored table
model. The anchor is therefore flagged as missing until you recover or create
its table. Both paths are supported.

## Recover the table from source

1. Open `main.typ` and set it as the main file.
2. Find the `//@table:basic_table` anchor. Its gutter action offers to recreate
   the table from the generated block or unlink it.
3. Choose the recreate action. Table Tools opens the recovered `basic_table`
   model with the generated cells.
4. Edit a cell, merge cells, or change the style. The managed block and preview
   update together.

## Create the table from a sample

1. Open **Table Tools** in the sidebar.
2. Choose **New → Basic table**. The sample creates the id `basic_table`, which
   links to the existing anchor.
3. Edit the grid and confirm that the `//@generated-table-start` block rewrites
   in place.

## Try the current tools

- Change header, footer, and repeated-row behavior.
- Apply a built-in style, explicit rules, banding, or column tracks.
- Add a caption, label, and alternative description.
- Import CSV or TSV data, then sort or transpose it.
- Export the table as `.typ`, delete the project table, and import the file
  again to restore the model losslessly.
- Create a second table and use `//@table:` completion to link it elsewhere in
  the document.

Project table definitions live in `.typsastra/config.json` and travel with the
project. Generated caches and exported PDFs do not.

Tutorial: <https://docs.typsastra.com/tutorials/TABLE_TOOLS/>
