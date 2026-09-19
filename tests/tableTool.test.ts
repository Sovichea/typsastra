import { describe, expect, test } from "bun:test";
import {
  findTableDirectiveBlocks,
  generateTableTypst,
  tableDirectiveBlock,
} from "../src/components/tableTypst";
import { normalizeWorkspaceMetadata, type StoredTable } from "../src/workspace/workspaceStateStore";

const table: StoredTable = {
  id: "table_1",
  name: "Results",
  columns: 2,
  headerRow: true,
  headerColumn: false,
  rows: [
    [{ text: "Name", align: null }, { text: "Value", align: null }],
    [{ text: "Alpha", align: null }, { text: "1*2", align: "right" }],
  ],
};

describe("table typst generation", () => {
  test("generates a header row and per-cell alignment", () => {
    expect(generateTableTypst(table)).toBe([
      "#table(",
      "  columns: 2,",
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
      rows: [[{ text: "a[b]#c$d_e", align: null }, { text: "plain", align: null }]],
    });
    expect(generated).toContain("[a\\[b\\]\\#c\\$d\\_e], [plain],");
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
    expect(first.rows[0].map(cell => cell.align)).toEqual(["left", null, null]);
    expect(second.columns).toBe(1);
    expect(second.rows).toEqual([[{ text: "", align: null }]]);
  });
});
