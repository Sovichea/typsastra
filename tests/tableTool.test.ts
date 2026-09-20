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
  return { text, align, verticalAlign: null, emphasis: null, colspan: 1, rowspan: 1, covered: false, borders: null };
}

const table: StoredTable = {
  id: "table_1",
  name: "Results",
  columns: 2,
  headerRow: true,
  headerColumn: false,
  stroke: "solid",
  strokeWidth: 0.5,
  strokeColor: "#000000",
  style: "default",
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

  test("marks each row's first cell for a header column", () => {
    expect(generateTableTypst({ ...table, headerColumn: true, headerRow: false })).toContain(
      "  table.header([Alpha]), [1\\*2],",
    );
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
      "  fill: (x, y) => if calc.odd(y) { luma(245) },",
    );
    expect(generateTableTypst({ ...table, style: "banded-columns" })).toContain(
      "  fill: (x, y) => if calc.odd(x) { luma(245) },",
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
    expect(source).toContain('data-menu="rows"');
    expect(source).toContain('data-menu="columns"');
    expect(source).toContain('data-menu="cells"');
    expect(source).toContain('data-menu="borders"');
    expect(source).toContain('data-menu="table"');
    expect(source).toContain('data-field="table-style"');
    expect(source).toContain("private applyTableStyle(");
    expect(source).toContain('data-emphasis="bold"');
    expect(source).toContain('data-emphasis="italic"');
    expect(source).toContain('data-emphasis="regular"');
    expect(source).toContain("private applyEmphasis(");
    expect(source).toContain('createAppIcon("chevronDown"');
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
    expect(source).toContain("private openTableMenu(");
    expect(source).toContain('"Merge cells"');
    expect(source).toContain("this.draggingSelection = true");
    expect(source).toContain('input.addEventListener("pointerenter"');
    expect(source).toContain('this.applyBorderToSelection(table, "outline")');
    expect(source).toContain("--edge-color");
    expect(source).toContain("OPPOSITE_SIDE[side]");
    expect(source).toContain('event.code === "KeyZ"');
    expect(source).toContain("private undo(): void");
    expect(source).toContain("private redo(): void");
    expect(source).toContain("private commitHistory(): void");
    expect(source).toContain("private refreshTableMenu(): void");
    expect(source).toContain('item.addEventListener("click", () => onSelect())');
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
    expect(app).toContain("sourceCode: generateTableTypst(table)");
    expect(app).toContain("table-tool-preview");
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
            rows: [[
              { text: "a", align: "left", emphasis: "bold" },
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
    expect(second.style).toBe("booktabs");
    expect(third.style).toBe("default");
    expect(first.headerRow).toBe(true);
    expect(first.headerColumn).toBe(true);
    expect(first.stroke).toBe("solid");
    expect(first.strokeWidth).toBe(0.5);
    expect(first.strokeColor).toBe("#000000");
    expect(first.rows[0].map(entry => entry.align)).toEqual(["left", null, null]);
    expect(first.rows[0].map(entry => entry.emphasis)).toEqual(["bold", null, null]);
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
