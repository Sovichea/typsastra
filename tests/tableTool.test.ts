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
  return { text, align, colspan: 1, rowspan: 1, covered: false, borders: null };
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
  rows: [
    [cell("Name"), cell("Value")],
    [cell("Alpha"), cell("1*2", "right")],
  ],
};

describe("table typst generation", () => {
  test("generates a header row and per-cell alignment", () => {
    expect(generateTableTypst(table)).toBe([
      "#table(",
      "  columns: 2,",
      '  stroke: 0.5pt + rgb("#000000"),',
      "  table.header([Name], [Value]),",
      "  [Alpha], #align(right)[1\\*2],",
      ")",
    ].join("\n"));
  });

  test("marks each row's first cell for a header column", () => {
    expect(generateTableTypst({ ...table, headerColumn: true, headerRow: false })).toContain(
      "  table.header([Alpha]), #align(right)[1\\*2],",
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

    expect(generated).toContain("  stroke: none,");
    expect(generated).toContain("table.header(table.cell(colspan: 2)[Header])");
    expect(generated).toContain(
      'table.cell(stroke: (top: 1pt + rgb("#ff0000"), right: none, bottom: 0.5pt + rgb("#000000"), left: none))[A]',
    );
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
            rows: [[{ text: "a", align: "left" }, { text: "b" }, { text: "c", align: "bogus" }]],
          },
          { id: "not-a-table", columns: 2 },
          { id: "table_3", columns: -4 },
        ],
      },
      workspace: null,
    }, () => "pid");

    expect(metadata.project.projectId).toBe("pid");
    expect(metadata.project.tables.map(entry => entry.id)).toEqual(["table_2", "table_3"]);
    const [first, second] = metadata.project.tables;
    expect(first.name).toBe("Summary");
    expect(first.headerRow).toBe(true);
    expect(first.headerColumn).toBe(true);
    expect(first.stroke).toBe("solid");
    expect(first.strokeWidth).toBe(0.5);
    expect(first.strokeColor).toBe("#000000");
    expect(first.rows[0].map(entry => entry.align)).toEqual(["left", null, null]);
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
