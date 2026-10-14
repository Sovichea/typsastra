import { invoke } from "@tauri-apps/api/core";
import type { TinymistLspClient } from "../compiler/lsp";
import {
  sourceMapPreviewTaskId,
  staleSourceMapTaskIds,
  type PreviewRefreshStyle,
} from "./previewPolicy";
import {
  tinymistDataPlaneFrameConfirmsSourceMap,
  tinymistDataPlaneFrameKind,
  tinymistDataPlanePositionText,
} from "./tinymistDataPlane";

export type SourceMapLogSource = "forward sync" | "inverse sync";

export type SourceMapSession = {
  socket: WebSocket;
  taskId: string;
};

export type SourceMapSessionDependencies = {
  log: (source: SourceMapLogSource, kind: "info" | "warning", message: string) => void;
  onPositionPayload: (text: string) => void | Promise<void>;
  activeFilePath: () => string | null;
  pathKey: (path: string) => string;
};

export class SourceMapSessionController {
  private previewTaskKey: string | null = null;
  private registeredTaskIdValue: string | null = null;
  private startupKey: string | null = null;
  private startup: Promise<SourceMapSession | null> | null = null;
  private retryKey: string | null = null;
  private retryNotBefore = 0;
  private failureCount = 0;
  private socketValue: WebSocket | null = null;
  private socketUrl = "";
  private documentReadySocket: WebSocket | null = null;
  private documentReadyPromise: Promise<boolean> | null = null;
  private resolveDocumentReady: ((ready: boolean) => void) | null = null;
  private warmupSocket: WebSocket | null = null;
  private warmup: Promise<boolean> | null = null;
  private recovery: Promise<SourceMapSession | null> | null = null;

  constructor(private readonly dependencies: SourceMapSessionDependencies) {}

  public get registeredTaskId(): string | null {
    return this.registeredTaskIdValue;
  }

  public get socket(): WebSocket | null {
    return this.socketValue;
  }

  public isDocumentReady(socket: WebSocket): boolean {
    return this.documentReadySocket === socket;
  }

  public async ensureSession(
    client: TinymistLspClient,
    rootPath: string,
    taskId: string,
    refreshStyle: PreviewRefreshStyle,
    source: SourceMapLogSource,
    background = false,
  ): Promise<SourceMapSession | null> {
    const sourceMapTask = sourceMapPreviewTaskId(taskId);
    const taskKey = `${this.dependencies.pathKey(rootPath)}\u0000${sourceMapTask}`;
    if (background && this.retryKey === taskKey && performance.now() < this.retryNotBefore) {
      return null;
    }
    if (this.startupKey === taskKey && this.startup) return await this.startup;

    const startup = this.startSession(
      client,
      rootPath,
      taskId,
      sourceMapTask,
      taskKey,
      refreshStyle,
      source,
    );
    this.startupKey = taskKey;
    this.startup = startup;
    try {
      return await startup;
    } finally {
      if (this.startup === startup) {
        this.startup = null;
        this.startupKey = null;
      }
    }
  }

  public waitForDocument(socket: WebSocket, timeoutMs: number): Promise<boolean> {
    if (this.documentReadySocket === socket) return Promise.resolve(true);
    if (this.socketValue !== socket || !this.documentReadyPromise) return Promise.resolve(false);
    const readiness = this.documentReadyPromise;
    return new Promise(resolve => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(ready);
      };
      const timeout = window.setTimeout(() => finish(false), timeoutMs);
      void readiness.then(finish);
    });
  }

  public async ensureWarm(
    socket: WebSocket,
    warm: () => Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.documentReadySocket === socket) return true;
    if (this.socketValue !== socket) return false;
    if (this.warmupSocket !== socket || !this.warmup) {
      const pending = (async () => {
        await warm();
        return await this.waitForDocument(socket, timeoutMs);
      })();
      this.warmupSocket = socket;
      this.warmup = pending;
      void pending.finally(() => {
        if (this.warmup === pending) {
          this.warmup = null;
          this.warmupSocket = null;
        }
      });
    }
    return await this.warmup;
  }

  public reset(options: { retry?: boolean } = {}): void {
    this.previewTaskKey = null;
    this.registeredTaskIdValue = null;
    this.startup = null;
    this.startupKey = null;
    if (options.retry ?? true) {
      this.retryKey = null;
      this.retryNotBefore = 0;
      this.failureCount = 0;
    }
    this.clearDocumentReadiness();
    this.socketValue?.close();
    this.socketValue = null;
    this.socketUrl = "";
  }

  public resetIfTaskFailed(taskId: string): boolean {
    if (this.registeredTaskIdValue && taskId !== this.registeredTaskIdValue) return false;
    this.reset({ retry: false });
    return true;
  }

  public async retire(client: TinymistLspClient | undefined): Promise<string | null> {
    const taskId = this.registeredTaskIdValue;
    this.reset();
    if (taskId && client) await client.stopPreview(taskId);
    return taskId;
  }

  /** Restart a connected task that never published a source-map document. */
  public recoverUnreadySession(
    client: TinymistLspClient,
    rootPath: string,
    taskId: string,
    refreshStyle: PreviewRefreshStyle,
    source: SourceMapLogSource,
  ): Promise<SourceMapSession | null> {
    if (this.recovery) return this.recovery;
    const recovery = (async () => {
      this.dependencies.log(source, "warning", "Source-map task connected without a ready document; restarting the hidden task.");
      await this.retire(client);
      return this.ensureSession(client, rootPath, taskId, refreshStyle, source);
    })();
    this.recovery = recovery;
    void recovery.then(() => {
      if (this.recovery === recovery) this.recovery = null;
    }, () => {
      if (this.recovery === recovery) this.recovery = null;
    });
    return recovery;
  }

  private async startSession(
    client: TinymistLspClient,
    rootPath: string,
    legacyTaskId: string,
    sourceMapTask: string,
    taskKey: string,
    refreshStyle: PreviewRefreshStyle,
    source: SourceMapLogSource,
  ): Promise<SourceMapSession | null> {
    if (this.previewTaskKey === taskKey) {
      const existingSocket = await this.ensureSocket(client.getLatestPreviewDataPlaneUrl(), source);
      if (existingSocket) return { socket: existingSocket, taskId: sourceMapTask };
    }

    this.clearDocumentReadiness();
    this.socketValue?.close();
    this.socketValue = null;
    this.socketUrl = "";

    for (const staleTask of staleSourceMapTaskIds(legacyTaskId, this.registeredTaskIdValue)) {
      await client.stopPreview(staleTask).catch(() => {});
    }
    this.previewTaskKey = null;
    this.registeredTaskIdValue = null;

    this.dependencies.log(
      source,
      "info",
      `Starting hidden Tinymist source-map session: root=${rootPath}; task=${sourceMapTask}; mode=${refreshStyle}; active=${this.dependencies.activeFilePath() ?? "n/a"}.`,
    );
    const url = await client.startPreview(rootPath, sourceMapTask, refreshStyle, false);
    if (!url) {
      this.dependencies.log(source, "warning", `Tinymist source-map session failed to start for task ${sourceMapTask}.`);
      return null;
    }
    this.previewTaskKey = taskKey;
    this.registeredTaskIdValue = sourceMapTask;

    const dataPlaneUrl = client.getLatestPreviewDataPlaneUrl();
    const socket = await this.ensureSocket(dataPlaneUrl, source);
    if (socket) {
      this.retryKey = null;
      this.retryNotBefore = 0;
      this.failureCount = 0;
      return { socket, taskId: sourceMapTask };
    }

    this.dependencies.log(
      source,
      "warning",
      `Tinymist data-plane connection failed for task ${sourceMapTask}: ${dataPlaneUrl || "URL unavailable"}.`,
    );
    await client.stopPreview(sourceMapTask).catch(() => {});
    if (this.registeredTaskIdValue === sourceMapTask) this.registeredTaskIdValue = null;
    if (this.previewTaskKey === taskKey) this.previewTaskKey = null;
    this.failureCount = this.retryKey === taskKey ? this.failureCount + 1 : 1;
    this.retryKey = taskKey;
    this.retryNotBefore = performance.now()
      + Math.min(60_000, 2_000 * (2 ** Math.min(5, this.failureCount - 1)));
    return null;
  }

  private async ensureSocket(url: string, source: SourceMapLogSource): Promise<WebSocket | null> {
    if (!url) return null;
    if (this.socketUrl === url && this.socketValue?.readyState === WebSocket.OPEN) return this.socketValue;

    this.clearDocumentReadiness();
    this.socketValue?.close();
    this.socketValue = null;
    this.socketUrl = url;
    this.documentReadyPromise = new Promise(resolve => {
      this.resolveDocumentReady = resolve;
    });
    const proxyUrl = await invoke<string>("start_preview_ws_proxy", { targetUrl: url }).catch(error => {
      this.dependencies.log(
        source,
        "warning",
        `Failed to start native Tinymist data-plane bridge for ${url}: ${String(error)}`,
      );
      return "";
    });
    if (!proxyUrl || this.socketUrl !== url) return null;

    return await new Promise(resolve => {
      const socket = new WebSocket(proxyUrl);
      socket.binaryType = "arraybuffer";
      let settled = false;
      const finish = (value: WebSocket | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(value);
      };
      const timeout = window.setTimeout(() => {
        socket.close();
        if (this.socketValue === socket || this.socketUrl === url) {
          this.clearDocumentReadiness();
          if (this.socketValue === socket) this.socketValue = null;
        }
        finish(null);
      }, 10_000);
      socket.addEventListener("open", () => {
        this.dependencies.log(
          source,
          "info",
          `Source-map bridge connected locally; waiting for its Tinymist upstream: ${url}.`,
        );
      }, { once: true });
      socket.addEventListener("message", event => {
        void this.handleSocketMessage(event.data, socket);
        void tinymistDataPlaneFrameKind(event.data).then(frameKind => {
          if (frameKind !== "transport" || this.socketUrl !== url) return;
          this.socketValue = socket;
          this.dependencies.log(
            source,
            "info",
            `Tinymist source-map data plane connected without requesting a vector document snapshot: ${url}.`,
          );
          finish(socket);
        });
      });
      socket.addEventListener("close", () => {
        if (this.socketValue === socket) {
          this.clearDocumentReadiness();
          this.socketValue = null;
        }
      });
      socket.addEventListener("error", () => {
        if (this.socketValue === socket || this.socketUrl === url) {
          this.clearDocumentReadiness();
          if (this.socketValue === socket) this.socketValue = null;
        }
        finish(null);
      }, { once: true });
    });
  }

  private async handleSocketMessage(data: unknown, socket: WebSocket): Promise<void> {
    const frameKind = await tinymistDataPlaneFrameKind(data);
    if (tinymistDataPlaneFrameConfirmsSourceMap(frameKind)) this.markDocumentReady(socket);
    if (frameKind === "document") return;
    const text = await tinymistDataPlanePositionText(data);
    if (text) await this.dependencies.onPositionPayload(text);
  }

  private markDocumentReady(socket: WebSocket): void {
    if (this.socketValue !== socket || this.documentReadySocket === socket) return;
    this.documentReadySocket = socket;
    this.resolveDocumentReady?.(true);
    this.resolveDocumentReady = null;
  }

  private clearDocumentReadiness(): void {
    this.resolveDocumentReady?.(false);
    this.resolveDocumentReady = null;
    this.documentReadyPromise = null;
    this.documentReadySocket = null;
    this.warmup = null;
    this.warmupSocket = null;
  }
}
