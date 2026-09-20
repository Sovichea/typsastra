import type { StoredTable, StoredTableCell } from "../workspace/workspaceStateStore";

function cell(text: string, init: Partial<StoredTableCell> = {}): StoredTableCell {
  return {
    text,
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
    ...init,
  };
}

const covered = (): StoredTableCell => cell("", { covered: true });

function table(init: Partial<StoredTable> & { columns: number; rows: StoredTableCell[][] }): StoredTable {
  const { columns, rows, ...overrides } = init;
  return {
    id: "sample",
    name: "Sample",
    columns,
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
    columnSizes: Array.from({ length: columns }, () => ""),
    rowSizes: Array.from({ length: rows.length }, () => ""),
    gutter: 0,
    label: "",
    alt: "",
    footerRow: false,
    footerRepeat: true,
    breakable: false,
    rules: [],
    rows,
    ...overrides,
  };
}

export type TableSample = {
  id: string;
  name: string;
  description: string;
  build: () => StoredTable;
};

/**
 * Ready-made tables offered when creating a new table. The compositions follow
 * examples from the Typst documentation (Table Guide, `table`/`grid` reference),
 * adapted to the builder's model and preset styles.
 */
export const TABLE_SAMPLES: TableSample[] = [
  {
    id: "empty",
    name: "Empty table",
    description: "A blank 2×2 table with a header row.",
    build: () => table({
      id: "sample_empty",
      name: "Empty table",
      columns: 2,
      rows: [
        [cell("Header 1"), cell("Header 2")],
        [cell(""), cell("")],
      ],
    }),
  },
  {
    id: "basic",
    name: "Basic table",
    description: "The simple header-and-rows table from the reference.",
    build: () => table({
      id: "sample_basic",
      name: "Basic table",
      columns: 3,
      rows: [
        [cell("Name"), cell("Score"), cell("Grade")],
        [cell("Ada"), cell("95"), cell("A")],
        [cell("Linus"), cell("88"), cell("B+")],
        [cell("Grace"), cell("92"), cell("A-")],
      ],
    }),
  },
  {
    id: "itinerary",
    name: "Itinerary",
    description: "The Table Guide’s travel table, zebra-striped.",
    build: () => table({
      id: "sample_itinerary",
      name: "Itinerary",
      columns: 4,
      style: "banded-rows",
      columnSizes: ["40pt", "1fr", "1fr", "2fr"],
      rows: [
        [cell("Day"), cell("Location"), cell("Hotel"), cell("Activities")],
        [cell("1"), cell("Paris"), cell("Hôtel de l’Europe"), cell("Arrival, river cruise")],
        [cell("2"), cell("Paris"), cell("Hôtel de l’Europe"), cell("Louvre, Eiffel Tower")],
        [cell("3"), cell("Lyon"), cell("Hotel Carlton"), cell("Old town walk")],
        [cell("4"), cell("Nice"), cell("Hotel Negresco"), cell("Beach, market")],
      ],
    }),
  },
  {
    id: "revenue",
    name: "Quarterly revenues",
    description: "The reference’s revenue table with striped columns.",
    build: () => table({
      id: "sample_revenue",
      name: "Quarterly revenues",
      columns: 4,
      style: "banded-columns",
      rows: [
        [cell(""), cell("Q1"), cell("Q2"), cell("Q3")],
        [cell("Revenue:"), cell("1000 €"), cell("2000 €"), cell("3000 €")],
        [cell("Expenses:"), cell("500 €"), cell("1000 €"), cell("1500 €")],
        [cell("Profit:"), cell("500 €"), cell("1000 €"), cell("1500 €")],
      ],
    }),
  },
  {
    id: "math",
    name: "Volumes",
    description: "The reference’s math table, with inline equations and inset.",
    build: () => table({
      id: "sample_math",
      name: "Volumes",
      columns: 3,
      columnSizes: ["auto", "1fr", "1fr"],
      rows: [
        [cell("Shape"), cell("Volume"), cell("Parameters")],
        [
          cell("Cylinder"),
          cell("$pi h (D^2 - d^2) / 4$"),
          cell("$h$: height, $D$: outer radius, $d$: inner radius", { inset: 6 }),
        ],
        [
          cell("Tetrahedron"),
          cell("$sqrt(2) / 12 a^3$"),
          cell("$a$: edge length", { inset: 6 }),
        ],
      ],
    }),
  },
  {
    id: "grades",
    name: "Grade book",
    description: "The reference’s exam table: dark header, colored cells, no grid.",
    build: () => {
      const dark = "#3f4759";
      const green = "#99cc99";
      const aqua = "#99ffff";
      const head = (text: string) => cell(text, { fill: dark, textColor: "#ffffff", emphasis: "bold" });
      const row = (name: string) => cell(name, { fill: dark, textColor: "#ffffff", emphasis: "bold" });
      const grade = (text: string, fill: string) => cell(text, { fill });
      return table({
        id: "sample_grades",
        name: "Grade book",
        columns: 4,
        headerColumn: true,
        stroke: "none",
        gutter: 2,
        rows: [
          [head(""), head("Exam 1"), head("Exam 2"), head("Exam 3")],
          [row("John"), grade("N/A", "#f2f2f2"), grade("A", green), grade("N/A", "#f2f2f2")],
          [row("Mary"), grade("N/A", "#f2f2f2"), grade("A", green), grade("A", green)],
          [row("Robert"), grade("B", aqua), grade("A", green), grade("B", aqua)],
        ],
      });
    },
  },
  {
    id: "vertical",
    name: "Vertical headers",
    description: "Rotated month headers, a caption, and page-break friendly.",
    build: () => table({
      id: "sample_vertical",
      name: "Vertical headers",
      columns: 4,
      columnSizes: ["auto", "1fr", "1fr", "1fr"],
      breakable: true,
      caption: "Revenue by month",
      captionAlign: "center",
      rows: [
        [
          cell(""),
          cell("January", { rotate: true }),
          cell("February", { rotate: true }),
          cell("March", { rotate: true }),
        ],
        [cell("Revenue"), cell("1,240"), cell("1,510"), cell("1,690")],
        [cell("Expenses"), cell("820"), cell("910"), cell("1,020")],
        [cell("Profit"), cell("420"), cell("600"), cell("670")],
      ],
    }),
  },
  {
    id: "booktabs",
    name: "Booktabs",
    description: "Horizontal rules only, for a publication look.",
    build: () => table({
      id: "sample_booktabs",
      name: "Booktabs",
      columns: 3,
      style: "booktabs",
      rows: [
        [cell("Item"), cell("Count"), cell("Total")],
        [cell("Apples"), cell("12"), cell("6.00")],
        [cell("Pears"), cell("7"), cell("5.25")],
        [cell("Plums"), cell("20"), cell("8.00")],
      ],
    }),
  },
  {
    id: "report",
    name: "Report",
    description: "Header fill, zebra rows, and top/header/bottom rules.",
    build: () => table({
      id: "sample_report",
      name: "Report",
      columns: 3,
      style: "report",
      columnSizes: ["1fr", "1fr", "2fr"],
      caption: "Quarterly results",
      captionAlign: "center",
      rows: [
        [cell("Region"), cell("Q1"), cell("Q2")],
        [cell("North"), cell("1,240"), cell("1,510")],
        [cell("South"), cell("980"), cell("1,120")],
        [cell("West"), cell("1,470"), cell("1,690")],
      ],
    }),
  },
  {
    id: "grouped",
    name: "Grouped report",
    description: "Merged header, footer, math and raw cells, and a caption.",
    build: () => table({
      id: "sample_grouped",
      name: "Grouped report",
      columns: 3,
      headerRowCount: 2,
      footerRow: true,
      columnSizes: ["1fr", "1fr", "2fr"],
      caption: "Sales by region",
      captionAlign: "center",
      rows: [
        [cell("Region", { colspan: 3, emphasis: "bold" }), covered(), covered()],
        [cell("Name"), cell("Units"), cell("Notes")],
        [cell("North"), cell("1,240"), cell("$x^2$ sample math")],
        [cell("South"), cell("980"), cell('#link("https://typst.app")[details]', { raw: true })],
        [cell("Total", { colspan: 2, emphasis: "bold" }), covered(), cell("2,220")],
      ],
    }),
  },
];
