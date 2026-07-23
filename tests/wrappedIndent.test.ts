import { describe, expect, test } from "bun:test";
import { wrappedLineIndentColumns } from "../src/editor/wrappedIndent";

describe("wrapped editor indentation", () => {
  test("aligns continuation rows with leading spaces", () => {
    expect(wrappedLineIndentColumns("    #set text(size: 11pt)", 2)).toBe(4);
  });

  test("uses the configured tab width", () => {
    expect(wrappedLineIndentColumns("\t#let value = 1", 4)).toBe(4);
    expect(wrappedLineIndentColumns(" \t#let value = 1", 4)).toBe(4);
  });

  test("does not indent unindented or whitespace-only lines", () => {
    expect(wrappedLineIndentColumns("Khmer ខ្មែរ", 2)).toBe(0);
    expect(wrappedLineIndentColumns("    ", 2)).toBe(0);
    expect(wrappedLineIndentColumns("", 2)).toBe(0);
  });
});
