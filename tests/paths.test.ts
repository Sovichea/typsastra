import { describe, expect, test } from "bun:test";
import { fileNameFromPath, filePathFromUri, filePathKey, filePathToUri, nativeFilePath, relativeFilePath, remapFilePath, resolveTypstPath } from "../src/platform/paths";

describe("platform paths", () => {
  test("round-trips Windows paths and encodes spaces", () => {
    const path = "C:\\Work Files\\report.typ";
    const uri = filePathToUri(path);

    expect(uri).toBe("file:///C:/Work%20Files/report.typ");
    expect(filePathFromUri(uri)).toBe("C:/Work Files/report.typ");
  });

  test("round-trips Unix paths without adding a fourth slash", () => {
    const path = "/home/user/Work Files/report.typ";
    const uri = filePathToUri(path);

    expect(uri).toBe("file:///home/user/Work%20Files/report.typ");
    expect(filePathFromUri(uri)).toBe(path);
  });

  test("preserves case sensitivity for Unix and folds Windows keys", () => {
    expect(filePathKey("/work/Main.typ")).not.toBe(filePathKey("/work/main.typ"));
    expect(filePathKey("C:\\Work\\Main.typ")).toBe(filePathKey("c:/work/main.typ"));
  });

  test("normalizes compiler-bound paths to native separators", () => {
    expect(nativeFilePath("C:/Work Files\\cache/render/main.typ"))
      .toBe("C:\\Work Files\\cache\\render\\main.typ");
    expect(nativeFilePath("/work/cache\\render/main.typ"))
      .toBe("/work/cache/render/main.typ");
  });

  test("extracts file names with either separator", () => {
    expect(fileNameFromPath("C:\\Work\\main.typ")).toBe("main.typ");
    expect(fileNameFromPath("/work/main.typ")).toBe("main.typ");
  });

  test("derives workspace-relative paths without crossing the root", () => {
    expect(relativeFilePath("C:\\Work", "c:\\Work\\chapters\\one.typ")).toBe("chapters/one.typ");
    expect(relativeFilePath("/work", "/work/chapters/one.typ")).toBe("chapters/one.typ");
    expect(relativeFilePath("/work", "/outside/one.typ")).toBeNull();
  });

  test("remaps renamed files and descendants across platforms", () => {
    expect(remapFilePath("C:\\Work\\main.typ", "c:/work/main.typ", "C:\\Work\\book.typ"))
      .toBe("C:\\Work\\book.typ");
    expect(remapFilePath("C:\\Work\\chapters\\one.typ", "C:\\Work\\chapters", "C:\\Work\\content"))
      .toBe("C:\\Work\\content\\one.typ");
    expect(remapFilePath("/work/chapters/one.typ", "/work/chapters", "/work/content"))
      .toBe("/work/content/one.typ");
    expect(remapFilePath("/work/main.typ", "/work/chapters", "/work/content"))
      .toBe("/work/main.typ");
  });

  test("resolves Typst import paths relative to the document or workspace root", () => {
    expect(resolveTypstPath("C:\\Work\\main.typ", "C:\\Work", "chapters/one.typ"))
      .toBe("C:/Work/chapters/one.typ");
    expect(resolveTypstPath("C:\\Work\\chapters\\one.typ", "C:\\Work", "../parts/two.typ"))
      .toBe("C:/Work/parts/two.typ");
    expect(resolveTypstPath("C:\\Work\\chapters\\one.typ", "C:\\Work", "/chapters/two.typ"))
      .toBe("C:/Work/chapters/two.typ");
    expect(resolveTypstPath("C:\\Work\\main.typ", "C:\\Work", "D:/Shared/two.typ"))
      .toBe("D:/Shared/two.typ");
    expect(resolveTypstPath("/work/chapters/one.typ", "/work", "./two.typ"))
      .toBe("/work/chapters/two.typ");
  });

  test("does not treat Typst packages, URLs, or empty paths as local files", () => {
    expect(resolveTypstPath("C:\\Work\\main.typ", "C:\\Work", "@preview/example:1.0.0")).toBeNull();
    expect(resolveTypstPath("C:\\Work\\main.typ", "C:\\Work", "https://example.com/file.typ")).toBeNull();
    expect(resolveTypstPath("C:\\Work\\main.typ", "C:\\Work", "")).toBeNull();
  });

  test("unescapes Typst string escapes before resolving", () => {
    expect(resolveTypstPath("C:\\Work\\main.typ", "C:\\Work", "chapters\\\\one\\\".typ"))
      .toBe("C:/Work/chapters/one\".typ");
  });
});
