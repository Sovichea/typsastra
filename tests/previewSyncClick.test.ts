import { describe, expect, test } from "bun:test";
import { PreviewSyncController } from "../src/preview/previewSyncController";
import type { PreviewSyncDependencies } from "../src/preview/previewSyncController";
import type { PreviewClickPoint } from "../src/preview/previewFrame";
import type { SourceMapSessionController } from "../src/preview/sourceMapSessionController";
import type { TinymistLspClient } from "../src/compiler/lsp";

describe("PDF inverse-sync click ownership", () => {
  test("restarts a connected source-map task that never becomes document-ready", async () => {
    const sent: string[] = [];
    const staleSocket = { send: (text: string) => sent.push(`stale:${text}`) } as WebSocket;
    const freshSocket = { send: (text: string) => sent.push(`fresh:${text}`) } as WebSocket;
    let recovered = 0;
    let warmed = 0;
    const sourceMap = {
      ensureSession: async () => ({ socket: staleSocket, taskId: "source-map" }),
      waitForDocument: async (socket: WebSocket) => socket === freshSocket,
      recoverUnreadySession: async () => {
        recovered += 1;
        return { socket: freshSocket, taskId: "fresh-source-map" };
      },
      ensureWarm: async (_socket: WebSocket, warm: () => Promise<void>) => {
        warmed += 1;
        await warm();
        return true;
      },
    } as unknown as SourceMapSessionController;
    const client = { scrollPreview: async () => {} } as unknown as TinymistLspClient;
    const controller = new PreviewSyncController({
      getClient: () => client,
      getEditor: () => ({ state: { selection: { main: { head: 12 } } } }) as never,
      getActiveFilePath: () => "C:/project/main.typ",
      getPdfContext: () => ({
        rootPath: "C:/project/main.typ", taskId: "preview", refreshStyle: "on-save",
        externalRefreshPending: false,
      }) as never,
      isReady: () => true,
      mapPdfForwardTarget: async () => ({ filepath: "C:/project/main.typ", line: 1, character: 0 }),
      sourceMap,
    } as PreviewSyncDependencies);

    expect(await controller.sendInverse({ documentPosition: { page_no: 60, x: 296, y: 390 } } as PreviewClickPoint)).toBe(true);
    expect(recovered).toBe(1);
    expect(warmed).toBe(1);
    expect(sent).toEqual(['fresh:src-point {"page_no":60,"x":296,"y":390}']);
  });

  test("accepts a delayed large-document response once, then rejects stale responses", () => {
    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
      const controller = new PreviewSyncController({} as PreviewSyncDependencies);
      controller.recordPreviewClick({ documentPosition: { page_no: 60, x: 296, y: 390 } } as PreviewClickPoint);

      now += 2_500;
      expect(controller.consumePreviewClick()).toBe(true);
      expect(controller.consumePreviewClick()).toBe(false);

      controller.recordPreviewClick({ documentPosition: { page_no: 56, x: 242, y: 375 } } as PreviewClickPoint);
      now += 60_001;
      expect(controller.consumePreviewClick()).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });
});
