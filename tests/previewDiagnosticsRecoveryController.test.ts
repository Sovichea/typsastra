import { describe, expect, test } from "bun:test";
import {
  parsePreviewCompilerDiagnostic,
  type TypstSourceLocation,
} from "../src/compiler/previewError";
import type { LspDiagnostic } from "../src/compiler/lsp";
import { PreviewDiagnosticsRecoveryController } from "../src/diagnostics/previewDiagnosticsRecoveryController";
import type { PreviewFrame } from "../src/preview/previewFrame";

describe("preview diagnostics recovery controller", () => {
  test("renders accepted LSP errors with a navigable source location", () => {
    const filePath = String.raw`C:\Users\Tester\project\main.typ`;
    let displayedPath = "";
    let overlayMessage = "";
    let navigated: TypstSourceLocation | null = null;
    let navigateFromOverlay: ((location: TypstSourceLocation) => void) | null = null;
    const previewFrame = {
      setCompilerError(
        _title: string,
        message: string,
        options: {
          displayPath: (path: string) => string;
          navigate: (location: TypstSourceLocation) => void;
        },
      ) {
        expect(message).toContain(`${filePath}:12:6`);
        const diagnostic = parsePreviewCompilerDiagnostic(message);
        expect(diagnostic?.summary).toBe("unknown variable: document-");
        expect(diagnostic?.frames[0]?.snippet).toContain("Hint: remove the trailing minus sign");
        overlayMessage = message;
        displayedPath = options.displayPath(filePath);
        navigateFromOverlay = options.navigate;
      },
    } as unknown as PreviewFrame;
    const controller = new PreviewDiagnosticsRecoveryController({
      activeFilePath: () => filePath,
      pinnedMainFilePath: () => filePath,
      previewImported: () => true,
      previewDisabled: () => false,
      renderMode: () => "on-type",
      editorText: () => "#document-",
      previewFrame: () => previewFrame,
      previewRenderPending: () => false,
      previewRenderQueued: () => false,
      navigateToCompilerLocation: (path, line, column) => {
        navigated = { filePath: path, line, column };
      },
      renderPdfPreview: () => {},
      log: () => {},
    });

    controller.recoverAfterAcceptedDiagnostics([{
      severity: 1,
      message: "unknown variable: document-\nHint: remove the trailing minus sign",
      range: {
        start: { line: 11, character: 5 },
        end: { line: 11, character: 14 },
      },
    }]);

    expect(displayedPath).toBe("main.typ");
    expect(overlayMessage.indexOf(`${filePath}:12:6`)).toBeLessThan(
      overlayMessage.indexOf("Hint: remove the trailing minus sign"),
    );
    expect(navigateFromOverlay).not.toBeNull();
    navigateFromOverlay!({ filePath, line: 12, column: 6 });
    expect(navigated).toEqual({ filePath, line: 12, column: 6 });
  });

  test("restores an accepted LSP error after a successful PDF presentation", () => {
    const filePath = String.raw`C:\Users\Tester\project\lib.typ`;
    let overlayCount = 0;
    let clearCount = 0;
    const previewFrame = {
      setCompilerError() {
        overlayCount += 1;
      },
      clearErrorOverlay() {
        clearCount += 1;
      },
    } as unknown as PreviewFrame;
    const controller = new PreviewDiagnosticsRecoveryController({
      activeFilePath: () => filePath,
      pinnedMainFilePath: () => String.raw`C:\Users\Tester\project\main.typ`,
      previewImported: () => true,
      previewDisabled: () => false,
      renderMode: () => "on-type",
      editorText: () => "..range(total-weeks + 1).map()",
      previewFrame: () => previewFrame,
      previewRenderPending: () => false,
      previewRenderQueued: () => false,
      navigateToCompilerLocation: () => {},
      renderPdfPreview: () => {},
      log: () => {},
    });
    const error = {
      severity: 1,
      message: "type array has no method `map`",
      range: {
        start: { line: 193, character: 12 },
        end: { line: 193, character: 15 },
      },
    } satisfies LspDiagnostic;

    controller.recoverAfterAcceptedDiagnostics([error]);
    expect(overlayCount).toBe(1);
    expect(controller.needsExternalPreviewRecovery()).toBeTrue();

    controller.onRenderSucceeded();
    expect(overlayCount).toBe(2);
    expect(clearCount).toBe(0);
    expect(controller.needsExternalPreviewRecovery()).toBeTrue();

    controller.recoverAfterAcceptedDiagnostics([]);
    expect(clearCount).toBe(1);
    expect(controller.needsExternalPreviewRecovery()).toBeTrue();
    controller.onRenderSucceeded();
    expect(controller.needsExternalPreviewRecovery()).toBeFalse();
  });

  test("waits for an in-flight PDF presentation before showing an accepted error", () => {
    const filePath = String.raw`C:\Users\Tester\project\lib.typ`;
    let renderPending = true;
    let overlayCount = 0;
    const previewFrame = {
      setCompilerError() {
        overlayCount += 1;
      },
      clearErrorOverlay() {},
    } as unknown as PreviewFrame;
    const controller = new PreviewDiagnosticsRecoveryController({
      activeFilePath: () => filePath,
      pinnedMainFilePath: () => String.raw`C:\Users\Tester\project\main.typ`,
      previewImported: () => true,
      previewDisabled: () => false,
      renderMode: () => "on-type",
      editorText: () => "..range(total-weeks + 1).map()",
      previewFrame: () => previewFrame,
      previewRenderPending: () => renderPending,
      previewRenderQueued: () => false,
      navigateToCompilerLocation: () => {},
      renderPdfPreview: () => {},
      log: () => {},
    });

    controller.recoverAfterAcceptedDiagnostics([{
      severity: 1,
      message: "type array has no method `map`",
      range: {
        start: { line: 193, character: 12 },
        end: { line: 193, character: 15 },
      },
    }]);
    expect(overlayCount).toBe(0);

    renderPending = false;
    controller.onRenderSucceeded();
    expect(overlayCount).toBe(1);
  });
});
