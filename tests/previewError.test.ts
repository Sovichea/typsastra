import { describe, expect, test } from "bun:test";
import {
  decodeRustUnicodeEscapes,
  parsePreviewCompilerDiagnostic,
  parsePreviewCompilerFailure,
  previewErrorText,
  relocatePreviewCompilerFailureMessage,
  relocatePreviewCompilerFailurePaths,
  typstPackageEntrypoint,
  typstPackageImports
} from "../src/compiler/previewError";

describe("preview compiler errors", () => {
  test("preserves structured command failure details for developer logs", () => {
    expect(previewErrorText({
      message: "Low-memory query failed",
      data: { reason: "unsupported export option" }
    })).toBe(["Low-memory query failed", "", '{\n  "reason": "unsupported export option"\n}'].join("\n"));
  });

  test("unwraps Tinymist export failures and identifies cached package locations", () => {
    const error = {
      message: String.raw`crates\tinymist\src\task\export.rs:606:17: ExportTask(2): document is not available for export: "error: expected path or string, found array\n    ┌─ C:\Users\Tester\AppData\Local\typst\packages\preview\cetz\0.3.2\src\canvas.typ:129:10\n    │\n129 │           ..vertices,\n    │           ^^^^^^^^^^\n"`
    };

    const failure = parsePreviewCompilerFailure(error);

    expect(failure.message).toStartWith("error: expected path or string, found array");
    expect(failure.message).not.toContain("ExportTask(2)");
    expect(failure.location).toEqual({
      filePath: String.raw`C:\Users\Tester\AppData\Local\typst\packages\preview\cetz\0.3.2\src\canvas.typ`,
      line: 129,
      column: 10
    });
    expect(failure.package?.spec).toBe("@preview/cetz:0.3.2");
    expect(failure.packageCacheRoot).toBe(
      String.raw`C:\Users\Tester\AppData\Local\typst\packages`
    );
  });

  test("locates direct package imports in Typst source", () => {
    const source = [
      '#import "template.typ": template',
      "#let chart() = {",
      '  import "@preview/timeliney:0.3.0"',
      "}"
    ].join("\n");

    expect(typstPackageImports(source, "template.typ")).toEqual([{
      package: {
        namespace: "preview",
        name: "timeliney",
        version: "0.3.0",
        spec: "@preview/timeliney:0.3.0"
      },
      filePath: "template.typ",
      line: 3,
      column: 3
    }]);
  });

  test("relocates private mirror paths without changing compiler details", () => {
    const cachePath = String.raw`C:\Project\.typsastra\cache\render\main.typ`;
    const originalPath = String.raw`C:\Project\main.typ`;
    const failure = parsePreviewCompilerFailure(
      `error: unknown variable\n  ┌─ ${cachePath}:94:12\n94 │ #strong-[Text]`
    );

    const displayed = relocatePreviewCompilerFailureMessage(failure, originalPath);

    expect(displayed).toContain(`${originalPath}:94:12`);
    expect(displayed).not.toContain(".typsastra");
    expect(displayed).toContain("#strong-[Text]");
  });

  test("decodes and relocates every compiler source frame", () => {
    const escaped = String.raw`C:\Project\u{1781}\.typsastra\cache\render\main.typ`;
    const decoded = decodeRustUnicodeEscapes(escaped);
    const message = [
      "error: invalid value",
      `  ${escaped}:12:4`,
      "12 | bad()",
      "   | ^^^^^",
      "",
      "help: while calling `wrapper`",
      `  ${escaped}:30:1`,
      "30 | #wrapper()",
    ].join("\n");
    const relocated = relocatePreviewCompilerFailurePaths(message, path =>
      path.includes(".typsastra") ? String.raw`C:\Project\main.typ` : path
    );

    expect(decoded).not.toContain(String.raw`\u{1781}`);
    expect(relocated.match(/C:\\Project\\main\.typ/g)?.length).toBe(2);
  });

  test("parses terminal output into primary and collapsed call frames", () => {
    const message = [
      "error: cannot calculate sum of empty array with no default",
      String.raw`  C:\Project\03_sources\lib.typ:71:26`,
      "71 | let subtotal = values.sum()",
      "   |                ^^^^^^^^^^^^",
      "",
      "help: while calling `render-items`",
      String.raw`  C:\Project\main.typ:147:1`,
      "147 | #render-items(items)",
      "    | ^^^^^^^^^^^^^^^^^^^^",
    ].join("\n");

    const diagnostic = parsePreviewCompilerDiagnostic(message);

    expect(diagnostic?.summary).toBe("cannot calculate sum of empty array with no default");
    expect(diagnostic?.frames).toHaveLength(2);
    expect(diagnostic?.frames[0]).toMatchObject({ kind: "primary", line: 71, column: 26 });
    expect(diagnostic?.frames[1]).toMatchObject({
      kind: "help",
      label: "while calling `render-items`",
      line: 147,
    });
  });

  test("reads a package entrypoint from typst.toml", () => {
    expect(typstPackageEntrypoint([
      "[package]",
      'name = "timeliney"',
      'entrypoint = "timeliney.typ"'
    ].join("\n"))).toBe("timeliney.typ");
  });
});
