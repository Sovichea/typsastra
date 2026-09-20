import { describe, expect, test } from "bun:test";
import {
  findTableDirectiveBlocks,
  generateTableTypst,
  tableDirectiveBlock,
} from "../src/components/tableTypst";
import { tableCellOrigin } from "../src/components/tableTool";
import {
  normalizeWorkspaceMetadata,
  type StoredTable,
  type StoredTableCell,
  type StoredTableAlignment,
} from "../src/workspace/workspaceStateStore";

function cell(text: string, align: StoredTableAlignment | null = null): StoredTableCell {
  return {
    text,
    align,
    verticalAlign: null,
    emphasis: null,
    colspan: 1,
    rowspan: 1,
    covered: false,
    borders: null,
    fill: null,
    textColor: null,
    rotate: false,
    breakable: null,
    inset: null,
    raw: false,
  };
}

const table: StoredTable = {
  id: "table_1",
  name: "Results",
  columns: 2,
  headerRow: true,
  headerRowCount: 1,
  headerColumn: false,
  headerRepeat: true,
  stroke: "solid",
  strokeWidth: 0.5,
  strokeColor: "#000000",
  style: "default",
  caption: "",
  captionPosition: "bottom",
  captionAlign: "left",
  columnSizes: ["", ""],
  rowSizes: ["", ""],
  gutter: 0,
  label: "",
  alt: "",
  footerRow: false,
  footerRepeat: true,
  breakable: false,
  rules: [],
  rows: [
    [cell("Name"), cell("Value")],
    [cell("Alpha"), cell("1*2", "right")],
  ],
};

describe("table typst generation", () => {
  test("generates a header row and a coordinate align function", () => {
    expect(generateTableTypst(table)).toBe([
      "#table(",
      "  columns: 2,",
      '  stroke: 0.5pt + rgb("#000000"),',
      "  align: (x, y) => if (x == 1 and y == 1) {",
      "    right",
      "  } else {",
      "    auto",
      "  },",
      "  table.header([Name], [Value]),",
      "  [Alpha], [1\\*2],",
      ")",
    ].join("\n"));
  });

  test("keeps header-column cells as regular cells", () => {
    const generated = generateTableTypst({ ...table, headerColumn: true, headerRow: false });
    // `table.header` marks a repeatable header section, not a header column.
    expect(generated).not.toContain("table.header([Alpha])");
    expect(generated).toContain("  [Alpha], [1\\*2],");
  });

  test("collapses row-wide border overrides into a y condition", () => {
    const border = { enabled: true, width: 1, color: "#9caec8" };
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [
        [
          { ...cell("Name"), borders: { top: null, right: null, bottom: border, left: null } },
          { ...cell("Value"), borders: { top: null, right: null, bottom: border, left: null } },
        ],
        [cell("Alpha"), cell("1*2")],
      ],
    });

    expect(generated).toContain([
      "  stroke: (x, y) => if y == 0 {",
      '    (bottom: 1pt + rgb("#9caec8"), rest: 0.5pt + rgb("#000000"))',
      "  } else if y == 1 {",
      '    (top: 1pt + rgb("#9caec8"), rest: 0.5pt + rgb("#000000"))',
      "  } else {",
      '    0.5pt + rgb("#000000")',
      "  },",
    ].join("\n"));
  });

  test("mirrors a one-sided border override onto the neighboring cell", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [
        [
          { ...cell("A"), borders: { top: null, right: null, bottom: { enabled: true, width: 2, color: "#000000" }, left: null } },
          cell("B"),
        ],
        [cell("C"), cell("D")],
      ],
    });

    // Typst lets the lower cell hide the upper cell's bottom stroke, so the
    // neighboring cell's top must carry the same override.
    expect(generated).toContain([
      "  } else if (x == 0 and y == 1) {",
      '    (top: 2pt + rgb("#000000"), rest: 0.5pt + rgb("#000000"))',
    ].join("\n"));
  });

  test("renders banded row and column styles with a fill function", () => {
    expect(generateTableTypst({ ...table, style: "banded-rows" })).toContain(
      '  fill: (x, y) => if y < 1 { rgb("#dbe4f0") } else if calc.odd(y) { rgb("#eef3f9") },',
    );
    expect(generateTableTypst({ ...table, style: "banded-columns" })).toContain(
      '  fill: (x, y) => if y < 1 { rgb("#dbe4f0") } else if calc.odd(x) { rgb("#eef3f9") },',
    );
    expect(generateTableTypst({ ...table, headerRow: false, style: "banded-rows" })).toContain(
      '  fill: (x, y) => if calc.odd(y) { rgb("#eef3f9") },',
    );
    expect(generateTableTypst({ ...table, style: "default" })).not.toContain("fill:");
  });

  test("renders booktabs rules without vertical lines", () => {
    const generated = generateTableTypst({ ...table, style: "booktabs" });

    expect(generated).toContain([
      "  stroke: (x, y) => if y == 0 {",
      '    (top: 1.5pt + rgb("#000000"), bottom: 0.75pt + rgb("#000000"), rest: none)',
      "  } else if y == 1 {",
      '    (top: 0.75pt + rgb("#000000"), bottom: 1.5pt + rgb("#000000"), rest: none)',
      "  } else {",
      "    none",
      "  },",
    ].join("\n"));
  });

  test("lets an explicit border override survive the booktabs style", () => {
    const generated = generateTableTypst({
      ...table,
      style: "booktabs",
      rows: [
        [cell("Name"), cell("Value")],
        [
          { ...cell("Alpha"), borders: { top: null, right: { enabled: true, width: 2, color: "#ff0000" }, bottom: null, left: null } },
          cell("1"),
        ],
        [cell("Beta"), cell("2")],
      ],
    });

    // The header rule is shared, so the neighbor's top side carries it too.
    expect(generated).toContain(
      '    (top: 0.75pt + rgb("#000000"), right: 2pt + rgb("#ff0000"), rest: none)',
    );
  });

  test("wraps a captioned table in an in-flow figure", () => {
    const bottom = generateTableTypst({ ...table, caption: "Results * summary" });
    expect(bottom.startsWith("#figure(\n  table(")).toBe(true);
    // No `placement`: that would float the whole figure to a page edge.
    expect(bottom).not.toContain("placement:");
    expect(bottom).toContain("  caption: [Results \\* summary],");
    expect(bottom.endsWith("\n)")).toBe(true);

    // `figure.caption(position: top)` moves only the caption, not the figure.
    const top = generateTableTypst({ ...table, caption: "Results", captionPosition: "top" });
    expect(top).toContain("  caption: figure.caption(position: top, [Results]),");

    const centered = generateTableTypst({ ...table, caption: "Results", captionAlign: "center" });
    expect(centered).toContain("  caption: align(center)[Results],");

    const topCentered = generateTableTypst({
      ...table,
      caption: "Results",
      captionPosition: "top",
      captionAlign: "center",
    });
    expect(topCentered).toContain(
      "  caption: figure.caption(position: top, align(center)[Results]),",
    );
  });

  test("omits the figure when there is no caption, alt, or label", () => {
    expect(generateTableTypst(table)).not.toContain("#figure(");
  });

  test("passes raw Typst content through and escapes text otherwise", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [[
        { ...cell('#link("https://example.com")[site]'), raw: true },
        cell("a*b"),
      ]],
    });

    expect(generated).toContain('[#link("https://example.com")[site]], [a\\*b],');
  });

  test("emits per-cell fill and inset over banding", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      style: "banded-rows",
      rows: [
        [{ ...cell("A"), fill: "#eef2f7" }, { ...cell("B"), inset: 2 }],
        [cell("C"), cell("D")],
      ],
    });

    expect(generated).toContain("  fill: (x, y) => if (x == 0 and y == 0) {");
    expect(generated).toContain('    rgb("#eef2f7")');
    expect(generated).toContain("    if calc.odd(y) { rgb(\"#eef3f9\") }");
    expect(generated).toContain("  inset: (x, y) => if (x == 1 and y == 0) {");
    expect(generated).toContain("    2pt");
  });

  test("wraps multiple header rows and honors repeat flags", () => {
    const generated = generateTableTypst({
      ...table,
      headerRowCount: 2,
      headerRepeat: false,
      footerRow: true,
      footerRepeat: false,
      rows: [
        [cell("Group"), cell("")],
        [cell("A"), cell("B")],
        [cell("1"), cell("2")],
        [cell("Total"), cell("3")],
      ],
    });

    expect(generated).toContain("  table.header(repeat: false, [Group], [], [A], [B]),");
    expect(generated).toContain("  table.footer(repeat: false, [Total], [3]),");
  });

  test("renders the report preset with header fill, banding, and rules", () => {
    const generated = generateTableTypst({
      ...table,
      style: "report",
      rows: [
        [cell("Name"), cell("Value")],
        [cell("A"), cell("1")],
        [cell("B"), cell("2")],
      ],
    });

    expect(generated).toContain("  stroke: none,");
    expect(generated).toContain(
      '  fill: (x, y) => if y < 1 { rgb("#dbe4f0") } else if calc.odd(y) { rgb("#eef3f9") },',
    );
    expect(generated).toContain('  table.hline(y: 0, stroke: 1.5pt + rgb("#000000")),');
    expect(generated).toContain('  table.hline(y: 1, stroke: 0.75pt + rgb("#000000")),');
    expect(generated).toContain('  table.hline(y: 3, stroke: 1.5pt + rgb("#000000")),');
  });

  test("colors cell text", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [[
        { ...cell("A"), fill: "#3f4759", textColor: "#ffffff", emphasis: "bold" },
        cell("B"),
      ]],
    });

    expect(generated).toContain('[#strong[#text(fill: rgb("#ffffff"))[A]]], [B],');
  });

  test("rotates cell content and can keep a spanned cell together", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [[
        { ...cell("USD/day"), rotate: true, breakable: false },
        cell("A"),
      ]],
    });

    expect(generated).toContain(
      "table.cell(breakable: false)[#rotate(-90deg, reflow: true)[USD/day]]",
    );
    expect(generated).toContain("[A],");
  });

  test("lets a captioned table break across pages", () => {
    const generated = generateTableTypst({ ...table, breakable: true, caption: "Results" });
    expect(generated.startsWith("#[\n  #show figure: set block(breakable: true)\n  #figure(")).toBe(true);
    expect(generated.endsWith("\n]")).toBe(true);
    // Without a figure there is nothing to make breakable.
    expect(generateTableTypst({ ...table, breakable: true })).toMatch(/^#table\(/u);
  });

  test("emits explicit rules before the footer", () => {
    const generated = generateTableTypst({
      ...table,
      footerRow: true,
      rules: [
        { axis: "horizontal", position: 1, start: 0, end: null, width: 1, color: "#9caec8" },
        { axis: "horizontal", position: 2, start: 1, end: 2, width: 0.5, color: "#000000" },
        { axis: "vertical", position: 1, start: 0, end: 1, width: 0.5, color: "#000000" },
      ],
      rows: [
        [cell("A"), cell("B")],
        [cell("1"), cell("2")],
        [cell("Total"), cell("3")],
      ],
    });

    expect(generated).toContain('  table.hline(y: 1, stroke: 1pt + rgb("#9caec8")),');
    expect(generated).toContain('  table.hline(y: 2, start: 1, end: 2, stroke: 0.5pt + rgb("#000000")),');
    expect(generated).toContain('  table.vline(x: 1, end: 1, stroke: 0.5pt + rgb("#000000")),');
    // Rules cannot follow a footer.
    expect(generated.indexOf("table.hline")).toBeLessThan(generated.indexOf("table.footer"));
  });

  test("emits row tracks", () => {
    const generated = generateTableTypst({ ...table, rowSizes: ["", "40pt"] });
    expect(generated).toContain("  rows: (auto, 40pt),");
  });

  test("emits column tracks, gutter, footer, alt, and label", () => {
    const generated = generateTableTypst({
      ...table,
      columnSizes: ["1fr", "2fr"],
      gutter: 4,
      footerRow: true,
      label: "tab:results",
      alt: "Totals by month",
      rows: [
        [cell("Name"), cell("Value")],
        [cell("Alpha"), cell("1")],
        [cell("Total"), cell("1")],
      ],
    });

    expect(generated).toContain("  columns: (1fr, 2fr),");
    expect(generated).toContain("  gutter: 4pt,");
    expect(generated).toContain("  table.footer([Total], [1]),");
    expect(generated).toContain('  alt: "Totals by month",');
    expect(generated.endsWith(") <tab:results>")).toBe(true);
  });

  test("escapes Typst markup characters", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [[cell("a[b]#c$d_e"), cell("plain")]],
    });
    expect(generated).toContain("[a\\[b\\]\\#c\\$d\\_e], [plain],");
  });

  test("combines horizontal and vertical alignment", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [[
        { ...cell("A"), align: "right", verticalAlign: "center" },
        { ...cell("B"), verticalAlign: "bottom" },
      ]],
    });

    expect(generated).toContain([
      "  align: (x, y) => if (x == 0 and y == 0) {",
      "    right + horizon",
      "  } else if (x == 1 and y == 0) {",
      "    bottom",
      "  } else {",
      "    auto",
      "  },",
    ].join("\n"));
  });

  test("wraps emphasis without breaking escaping", () => {
    const generated = generateTableTypst({
      ...table,
      columns: 3,
      headerRow: false,
      rows: [[
        { ...cell("A*B"), emphasis: "bold" },
        { ...cell("C"), emphasis: "italic" },
        { ...cell("D"), emphasis: "regular" },
      ]],
    });

    expect(generated).toContain(
      '[#strong[A\\*B]], [#emph[C]], [#text(weight: "regular", style: "normal")[D]],',
    );
  });

  test("preserves inline math and raw spans", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [[cell("$x^2$ and `code`"), cell("plain")]],
    });

    expect(generated).toContain("[$x^2$ and `code`], [plain],");
  });

  test("escapes unpaired dollars and backticks", () => {
    const generated = generateTableTypst({
      ...table,
      headerRow: false,
      rows: [[cell("price $5"), cell("a`b")]],
    });

    expect(generated).toContain("[price \\$5], [a\\`b],");
  });

  test("emits merged cells and per-cell stroke overrides", () => {
    const side = (enabled: boolean, width = 0.5, color = "#000000") => ({ enabled, width, color });
    const generated = generateTableTypst({
      ...table,
      stroke: "none",
      rows: [
        [{ ...cell("Header"), colspan: 2 }, { ...cell(""), covered: true }],
        [
          {
            ...cell("A"),
            borders: {
              top: side(true, 1, "#ff0000"),
              right: side(false),
              bottom: side(true),
              left: side(false),
            },
          },
          cell("B"),
        ],
      ],
    });

    expect(generated).toContain("table.header(table.cell(colspan: 2)[Header])");
    expect(generated).toContain([
      "  stroke: (x, y) => if y == 0 {",
      '    (bottom: 1pt + rgb("#ff0000"), rest: none)',
      "  } else if (x == 0 and y == 1) {",
      '    (top: 1pt + rgb("#ff0000"), bottom: 0.5pt + rgb("#000000"), rest: none)',
    ].join("\n"));
    // The merged header's bottom edge is shared with both body cells.
    expect(generated).toContain([
      "  } else if (x == 1 and y == 1) {",
      '    (top: 1pt + rgb("#ff0000"), rest: none)',
    ].join("\n"));
    expect(generated).toContain("  [A], [B],");
  });

  test("maps covered slots to their merged origin", () => {
    const merged: StoredTable = {
      ...table,
      rows: [
        [{ ...cell("A"), colspan: 2 }, { ...cell(""), covered: true }],
        [cell("B"), cell("C")],
      ],
    };

    expect(tableCellOrigin(merged, 0, 1)).toEqual({ row: 0, column: 0 });
    expect(tableCellOrigin(merged, 0, 0)).toEqual({ row: 0, column: 0 });
    expect(tableCellOrigin(merged, 1, 1)).toEqual({ row: 1, column: 1 });
    expect(tableCellOrigin(merged, 5, 0)).toBeNull();
  });

  test("emits rowspans for vertical merges", () => {
    const spanned: StoredTable = {
      ...table,
      headerRow: false,
      rows: [
        [{ ...cell("A"), rowspan: 2 }, cell("B")],
        [{ ...cell(""), covered: true }, cell("C")],
      ],
    };

    const generated = generateTableTypst(spanned);
    expect(generated).toContain("  table.cell(rowspan: 2)[A], [B],");
    expect(generated).toContain("  [C],");
  });

  test("wires selection, merge, reorder, and border interactions", async () => {
    const source = await Bun.file(
      new URL("../src/components/tableTool.ts", import.meta.url),
    ).text();

    expect(source).toContain("ArrowRight: { row, column: column + cell.colspan }");
    expect(source).toContain("event.shiftKey && this.selectionAnchor");
    // The builder mounts the shared toolbar with only its own entries.
    expect(source).toContain("private toolbarEntries(table: StoredTable): ToolbarEntry[]");
    expect(source).toContain('entries: this.toolbarEntries(table)');
    expect(source).toContain('id: "rows"');
    expect(source).toContain('id: "columns"');
    expect(source).toContain('id: "cells"');
    expect(source).toContain('id: "borders"');
    expect(source).toContain('id: "table"');
    expect(source).toContain('id: "style"');
    expect(source).toContain("private applyTableStyle(");
    expect(source).toContain('id: "bold"');
    expect(source).toContain('id: "italic"');
    expect(source).toContain("private applyEmphasis(");
    expect(source).toContain("private toggleEmphasis(");
    // New-table picker with rendered thumbnails.
    expect(source).toContain("private openSamplesDialog(");
    // Thumbnails are static images, not compiled on every open.
    expect(source).toContain('class="table-sample-image"');
    expect(source).toContain("src=\"/table-samples/");
    expect(source).not.toContain("renderSampleThumbnails");
    expect(source).toContain('this.openSamplesDialog()');
    // Uses the shared modal structure so the global focus trap applies.
    expect(source).toContain('"settings-overlay table-samples-overlay"');
    expect(source).toContain('role="dialog" aria-modal="true" aria-label="New table"');
    expect(source).toContain("private createFromSample(");
    expect(source).toContain('data-field="table-caption"');
    expect(source).toContain('id: "caption-position"');
    expect(source).toContain('id: "caption-center"');
    expect(source).toContain("private applyCaptionAlign(");
    // Tier 1 controls.
    expect(source).toContain("private applyRaw(");
    expect(source).toContain("private applyFill(");
    expect(source).toContain("private applyInset(");
    expect(source).toContain("private applyColumnSize(");
    expect(source).toContain("private applyRotate(");
    expect(source).toContain("private applyCellBreakable(");
    expect(source).toContain('label: "Rotate content"');
    expect(source).toContain('label: "Keep together"');
    expect(source).toContain('label: "Break across pages"');
    expect(source).toContain("private addRuleFromSelection(");
    expect(source).toContain("private shiftRulesForInsert(");
    expect(source).toContain("private shiftRulesForDelete(");
    expect(source).toContain('label: "Rule below"');
    expect(source).toContain("private applyHeaderRows(");
    expect(source).toContain("private applyRowSize(");
    expect(source).toContain('label: "Header rows"');
    expect(source).toContain('label: "Repeat header"');
    expect(source).toContain('label: "Repeat footer"');
    expect(source).toContain('label: "Row height"');
    // Custom track sizes in addition to the presets.
    expect(source).toContain("function normalizeTrackSize(");
    expect(source).toContain('kind: "field"');
    expect(source).toContain("Custom row height");
    expect(source).toContain("Custom column width");
    expect(source).toContain("private copiedFormats: StoredCellFormat[][] | null = null");
    expect(source).toContain("private copyFormatting(");
    expect(source).toContain("private pasteFormatting(");
    expect(source).toContain('"Copy formatting"');
    expect(source).toContain('"Paste formatting"');
    expect(source).toContain('label: "Typst content"');
    expect(source).toContain('label: "Column width"');
    expect(source).toContain('label: "Footer row"');
    expect(source).toContain('data-field="table-label"');
    expect(source).toContain('data-field="table-alt"');
    // Text boxes reuse the editor's caret field and font.
    expect(source).toContain('from "../ui/editorCaretInput"');
    expect(source).toContain('wrapEditorCaretInput(field, { shellClass: "table-tool-field-shell" })');
    expect(source).toContain('class="table-tool-field"');
    expect(source).toContain('wrapEditorCaretInput(input, { shellClass: "table-tool-cell-shell" })');
    expect(source).toContain("private markCellEditing(");
    expect(source).toContain('createAppIcon("copy"');
    expect(source).toContain('input.addEventListener("contextmenu"');
    expect(source).toContain("private openCellContextMenu(");
    expect(source).toContain("private insertRow(");
    expect(source).toContain("private insertColumn(");
    expect(source).toContain("private deleteRow(");
    expect(source).toContain("private deleteColumn(");
    expect(source).toContain("private copySelection(");
    expect(source).toContain("private pasteSelection(");
    expect(source).toContain('readText, writeText');
    expect(source).toContain('"Merge cells"');
    expect(source).toContain('this.deps.showPreviewMessage?.("Select more than one cell to merge.");');
    expect(source).toContain("this.draggingSelection = true");
    expect(source).toContain('input.addEventListener("pointerenter"');
    expect(source).toContain('this.applyBorderToSelection(table, "outline")');
    expect(source).toContain("--edge-color");
    expect(source).toContain("OPPOSITE_SIDE[side]");
    expect(source).toContain('event.code === "KeyZ"');
    expect(source).toContain("private undo(): void");
    expect(source).toContain("private redo(): void");
    expect(source).toContain("private commitHistory(): void");
  });

  test("uses Excel-style navigation and editing states", async () => {
    const source = await Bun.file(
      new URL("../src/components/tableTool.ts", import.meta.url),
    ).text();

    expect(source).toContain("private editingCell: Slot | null = null");
    expect(source).toContain("input.readOnly = true");
    expect(source).toContain("private enterEditMode(");
    expect(source).toContain("private commitEdit(): void");
    expect(source).toContain("private cancelEdit(");
    expect(source).toContain("private moveSelection(");
    // Typing a printable character replaces the content and starts editing.
    expect(source).toContain("this.enterEditMode(table, { row, column }, event.key)");
    // Escape restores the pre-edit value.
    expect(source).toContain("input.value = this.editStartValue");
    // A second click on the active cell enters editing.
    expect(source).toContain("if (isFocus && !this.editingCell)");
    // Standard clipboard shortcuts work in navigation state.
    expect(source).toContain('if (key === "c") {');
    expect(source).toContain("this.copySelection(table, false)");
    expect(source).toContain('if (key === "v") {');
    expect(source).toContain("this.pasteSelection(table)");
    // Highlight classes belong on the cell, not the inner caret shell.
    expect(source).toContain('input.closest<HTMLElement>(".table-tool-cell-wrap")');
    // Re-rendering keeps keyboard focus on the active cell.
    expect(source).toContain("const restoreFocus = host.contains(document.activeElement);");
    // Shift+arrows move DOM focus, so the next keydown extends from the focus
    // cell instead of recomputing from the anchor cell.
    expect(source).toContain(
      "if (!extend || !this.selectionAnchor) this.selectionAnchor = origin;\n"
      + "    this.selectionFocus = origin;\n"
      + "    this.syncSelectionHighlight();\n"
      + "    this.syncCellSelects(table);\n"
      + "    this.cellInputs.get(`${origin.row}:${origin.column}`)?.focus();",
    );
    // Focusing the range focus must not collapse the selection.
    expect(source).toContain("if (this.selectionFocus?.row === rowIndex");
  });

  test("builds and finds the managed directive block", () => {
    const block = tableDirectiveBlock(table);
    expect(block.startsWith("//@table:table_1\n//@generated-table-start\n")).toBe(true);
    expect(block.endsWith("\n//@generated-table-end")).toBe(true);

    const document = `= Chapter\n\n${block}\n\nAfter.`;
    const [found] = findTableDirectiveBlocks(document);
    expect(found.tableId).toBe("table_1");
    expect(document.slice(found.from, found.to)).toBe(block);
    expect(document.slice(found.contentFrom, found.contentTo)).toBe(generateTableTypst(table));
  });

  test("ignores a bare directive without a managed block", () => {
    expect(findTableDirectiveBlocks("//@table:table_1\n= Chapter")).toEqual([]);
  });
});

describe("table preview compilation", () => {
  test("compiles the generated snippet and renders it in the preview pane", async () => {
    const controller = await Bun.file(
      new URL("../src/components/tableTool.ts", import.meta.url),
    ).text();
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const native = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();

    expect(controller).toContain("compilePreview?(table: StoredTable): Promise<string[]>");
    expect(controller).toContain("private schedulePreview(): void");
    expect(controller).toContain("await compile(snapshot)");
    expect(app).toContain('invoke<string[]>("compile_typst_snippet_svg"');
    expect(app).toContain("sourceCode: this.tablePreviewSource(table)");
    expect(app).toContain("private tablePreviewSource(table: StoredTable): string");
    expect(app).toContain("table-tool-preview");
    // Transient notices float over the rendered table instead of replacing it.
    expect(app).toContain("table-tool-preview-notice");
    expect(app).toContain("table-tool-preview-notice-close");
    expect(app).toContain("private armTablePreviewNotice(");
    expect(app).toContain("5_000");
    expect(app).toContain("lastTablePreviewPages");
    expect(native).toContain("async fn compile_typst_snippet_svg(");
    expect(native).toContain('"page-{p}.svg"');
    expect(native).toContain('"#set page(width: auto, height: auto, margin: 12pt)');
    expect(native).toContain("compile_typst_snippet_svg,");
  });
});

describe("stored table normalization", () => {
  test("normalizes tables from the portable project config", () => {
    const metadata = normalizeWorkspaceMetadata({
      project: {
        tables: [
          {
            id: "table_2",
            name: "  Summary  ",
            columns: 3,
            headerColumn: true,
            caption: "Totals",
            captionPosition: "top",
            captionAlign: "center",
            columnSizes: ["1fr", "0.5cm", "bogus"],
            rowSizes: ["40pt"],
            headerRowCount: 5,
            headerRepeat: false,
            gutter: 99,
            label: "tab:summary",
            alt: "Summary",
            footerRow: true,
            footerRepeat: false,
            rules: [
              { axis: "horizontal", position: 1, start: 0, end: 3, width: 1, color: "#ABCDEF" },
              { axis: "vertical", position: 99, width: 0.5 },
              { axis: "bogus" },
            ],
            rows: [[
              { text: "a", align: "left", emphasis: "bold", fill: "#ABCDEF", textColor: "#112233", rotate: true, breakable: false, inset: 3, raw: true },
              { text: "b", emphasis: "bogus" },
              { text: "c", align: "bogus" },
            ]],
          },
          { id: "not-a-table", columns: 2 },
          { id: "table_3", columns: -4, style: "booktabs" },
          { id: "table_4", columns: 2, style: "bogus" },
        ],
      },
      workspace: null,
    }, () => "pid");

    expect(metadata.project.projectId).toBe("pid");
    expect(metadata.project.tables.map(entry => entry.id)).toEqual(["table_2", "table_3", "table_4"]);
    const [first, second, third] = metadata.project.tables;
    expect(first.name).toBe("Summary");
    expect(first.style).toBe("default");
    expect(first.caption).toBe("Totals");
    expect(first.captionPosition).toBe("top");
    expect(first.captionAlign).toBe("center");
    expect(second.caption).toBe("");
    expect(second.captionPosition).toBe("bottom");
    expect(second.captionAlign).toBe("left");
    expect(second.style).toBe("booktabs");
    expect(third.style).toBe("default");
    expect(first.headerRow).toBe(true);
    expect(first.headerColumn).toBe(true);
    expect(first.stroke).toBe("solid");
    expect(first.strokeWidth).toBe(0.5);
    expect(first.strokeColor).toBe("#000000");
    expect(first.rows[0].map(entry => entry.align)).toEqual(["left", null, null]);
    expect(first.rows[0].map(entry => entry.emphasis)).toEqual(["bold", null, null]);
    expect(first.columnSizes).toEqual(["1fr", "0.5cm", ""]);
    expect(first.rowSizes).toEqual(["40pt"]);
    expect(first.headerRowCount).toBe(1);
    expect(first.headerRepeat).toBe(false);
    expect(first.footerRepeat).toBe(false);
    expect(first.gutter).toBe(20);
    expect(first.label).toBe("tab:summary");
    expect(first.alt).toBe("Summary");
    expect(first.footerRow).toBe(true);
    expect(first.rules).toHaveLength(2);
    expect(first.rules[0]).toMatchObject({ axis: "horizontal", position: 1, start: 0, end: null, color: "#abcdef" });
    expect(first.rules[1]).toMatchObject({ axis: "vertical", position: 3, start: 0, end: null });
    expect(first.rows[0][0].fill).toBe("#abcdef");
    expect(first.rows[0][0].textColor).toBe("#112233");
    expect(first.rows[0][0].rotate).toBe(true);
    expect(first.rows[0][0].breakable).toBe(false);
    expect(first.rows[0][0].inset).toBe(3);
    expect(first.rows[0][0].raw).toBe(true);
    expect(second.columnSizes).toEqual([""]);
    expect(second.gutter).toBe(0);
    expect(second.footerRow).toBe(false);
    expect(first.rows[0][0]).toMatchObject({
      colspan: 1,
      rowspan: 1,
      covered: false,
      borders: null,
    });
    expect(second.columns).toBe(1);
    expect(second.rows).toEqual([[{
      text: "",
      align: null,
      verticalAlign: null,
      emphasis: null,
      colspan: 1,
      rowspan: 1,
      covered: false,
      borders: null,
      fill: null,
      textColor: null,
      rotate: false,
      breakable: null,
      inset: null,
      raw: false,
    }]]);
  });

  test("repairs overlapping spans into a consistent grid", () => {
    const metadata = normalizeWorkspaceMetadata({
      project: {
        tables: [{
          id: "table_1",
          columns: 2,
          stroke: "none",
          rows: [
            [{ text: "a", colspan: 2 }, { text: "b" }],
            [{ text: "c" }, { text: "d" }],
          ],
        }],
      },
      workspace: null,
    }, () => "pid");

    const normalized = metadata.project.tables[0];
    expect(normalized.stroke).toBe("none");
    expect(normalized.rows[0][0].colspan).toBe(2);
    expect(normalized.rows[0][1].covered).toBe(true);
    expect(normalized.rows[0][1].text).toBe("");
    expect(normalized.rows[1][0].text).toBe("c");
  });
});
