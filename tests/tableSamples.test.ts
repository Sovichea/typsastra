import { describe, expect, test } from "bun:test";
import { TABLE_SAMPLES } from "../src/components/tableSamples";
import { generateTableTypst } from "../src/components/tableTypst";

describe("table samples", () => {
  test("every sample generates Typst", () => {
    expect(TABLE_SAMPLES.length).toBeGreaterThanOrEqual(5);
    for (const sample of TABLE_SAMPLES) {
      const code = generateTableTypst(sample.build());
      expect(code.startsWith("#table(") || code.startsWith("#figure(")).toBe(true);
      expect(sample.name.length).toBeGreaterThan(0);
      expect(sample.description.length).toBeGreaterThan(0);
    }
  });

  test("offers an empty table first and a grouped report", () => {
    const ids = TABLE_SAMPLES.map(sample => sample.id);
    expect(ids[0]).toBe("empty");
    expect(ids).toContain("grouped");
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the grade book sample styles a dark header and colored cells", () => {
    const grades = TABLE_SAMPLES.find(sample => sample.id === "grades")!.build();
    const code = generateTableTypst(grades);
    expect(grades.stroke).toBe("none");
    expect(grades.headerColumn).toBe(true);
    expect(grades.rows[0][0].fill).toBe("#3f4759");
    expect(grades.rows[0][0].textColor).toBe("#ffffff");
    expect(code).toContain('#text(fill: rgb("#ffffff"))');
  });

  test("the grouped sample exercises merges, headers, and a footer", () => {
    const grouped = TABLE_SAMPLES.find(sample => sample.id === "grouped")!.build();
    expect(grouped.headerRowCount).toBe(2);
    expect(grouped.footerRow).toBe(true);
    expect(grouped.rows.some(row => row.some(entry => entry.covered))).toBe(true);
    const code = generateTableTypst(grouped);
    expect(code).toContain("table.header(");
    expect(code).toContain("table.footer(");
    expect(code).toContain("table.cell(colspan: 3)");
  });
});
