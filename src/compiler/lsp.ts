import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorView } from "@codemirror/view";

type TinymistPreviewResult = {
  staticServerAddr?: string;
  staticServerPort?: number;
  dataPlanePort?: number;
};

export type LspStatusKind = "starting" | "running" | "initializing" | "ready" | "preview-starting" | "preview-ready" | "sync-pending" | "syncing" | "stopped" | "error";

export type LspStatus = {
  kind: LspStatusKind;
  message: string;
};

type ScrollPreviewRequest = {
  event: "panelScrollTo" | "changeCursorPosition";
  filepath: string;
  line: number;
  character: number;
};

export type LspSourcePosition = {
  line: number;
  character?: number;
};

export type LspDiagnostic = {
  range: {
    start: LspSourcePosition;
    end: LspSourcePosition;
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

export type LspLogEntry = {
  kind: "error" | "warning" | "info" | "log";
  message: string;
  source?: string;
};

export class TinymistLspClient {
  private requestId = 0;
  private editorView?: EditorView;

  constructor(
    private onSvgPreviewStream: (svgContent: string) => void,
    private onStatus: (status: LspStatus) => void = () => {},
    private onInverseSync: (position: LspSourcePosition, defaultCursorPos: number) => number | void = () => {},
    private onDiagnostics: (uri: string, diagnostics: LspDiagnostic[], version?: number) => void = () => {},
    private onLog: (entry: LspLogEntry) => void = () => {}
  ) {}

  public setEditorView(view: EditorView) {
    this.editorView = view;
  }

  public async connect(): Promise<void> {
    try {
      this.setStatus("starting", "Starting Tinymist");
      await invoke("start_tinymist_lsp");
      this.setStatus("running", "Tinymist process running");

      await listen<string>("lsp-status", (event) => {
        if (event.payload === "stopped") {
          this.setStatus("stopped", "Tinymist stopped");
        } else if (event.payload === "running") {
          this.setStatus("running", "Tinymist process running");
        }
      });

      await listen<string>("lsp-rx", (event) => {
        try {
          const payload = JSON.parse(event.payload);
          this.handleMessage(payload);
        } catch (e) {
          console.error("Failed to parse LSP payload", e);
        }
      });

      this.setStatus("initializing", "Initializing LSP");
      await this.initializeLsp();
      this.setStatus("ready", "LSP ready");
    } catch (e) {
      console.error("Failed to start Tinymist LSP over IPC:", e);
      this.setStatus("error", `LSP unavailable: ${String(e)}`);
      throw e;
    }
  }

  public async restart(): Promise<void> {
    this.setStatus("starting", "Restarting Tinymist");
    await invoke("start_tinymist_lsp");
    this.setStatus("running", "Tinymist process running");
    this.setStatus("initializing", "Initializing LSP");
    await this.initializeLsp();
    this.setStatus("ready", "LSP ready");
  }

  private handleMessage(payload: any) {
    if (payload.id !== undefined && typeof payload.method === "string") {
      this.handleServerRequest(payload);
      return;
    }

    if (payload.method === "tinymist/preview/svgStream") {
      this.onSvgPreviewStream(payload.params.svg);
    }

    // Sometimes tinymist sends logs or errors!
    if (payload.method === "window/showMessage") {
      this.emitLog(payload.params?.type, payload.params?.message, "showMessage");
    }

    if (payload.method === "window/logMessage") {
      this.emitLog(payload.params?.type, payload.params?.message, "logMessage");
    }

    if (payload.method === "textDocument/publishDiagnostics") {
      const params = payload.params;
      if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
        this.onDiagnostics(params.uri, params.diagnostics, params.version);
      }
    }

    if (payload.error) {
      this.onLog({
        kind: "error",
        source: "response",
        message: payload.error.message ?? JSON.stringify(payload.error)
      });
    }

    // Handle Inverse Sync from Tinymist (clicking preview -> jump editor)
    if (payload.method === "window/showDocument" && this.editorView) {
      const position = payload.params?.selection?.start;
      if (!position || typeof position.line !== "number") return;

      try {
        const defaultCursorPos = this.editorPositionFromLspPosition(position);
        const mappedCursorPos = this.onInverseSync(position, defaultCursorPos);
        const cursorPos = typeof mappedCursorPos === "number" ? mappedCursorPos : defaultCursorPos;
        this.editorView.dispatch({
          selection: { anchor: cursorPos },
          effects: EditorView.scrollIntoView(cursorPos, { y: "center" })
        });
        this.editorView.focus();
      } catch (err) {
        console.warn("Could not scroll to preview source position", position, err);
      }
    }
  }

  private editorPositionFromLspPosition(position: LspSourcePosition): number {
    const doc = this.editorView!.state.doc;
    const lineNumber = Math.max(1, Math.min(position.line + 1, doc.lines)); // LSP is 0-indexed, CodeMirror line() is 1-indexed
    const lineInfo = doc.line(lineNumber);
    const character = this.utf8ByteOffsetToStringOffset(lineInfo.text, position.character ?? 0);
    return lineInfo.from + character;
  }

  private utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number {
    const target = Math.max(0, byteOffset);
    let bytes = 0;
    let offset = 0;

    for (const char of text) {
      const size = new TextEncoder().encode(char).length;
      if (bytes + size > target) break;
      bytes += size;
      offset += char.length;
    }

    return offset;
  }

  private async initializeLsp() {
    return new Promise<void>(async (resolve) => {
      const id = this.requestId++;

      const unlisten = await listen<string>("lsp-rx", (event) => {
        try {
          const payload = JSON.parse(event.payload);
          if (payload.id === id) {
            unlisten();
            this.sendNotification("initialized", {});
            resolve();
          }
        } catch (e) {}
      });

      this.sendRequest("initialize", {
        processId: null,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              didSave: true
            },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: false
            }
          },
          workspace: {
            configuration: true
          }
        },
        initializationOptions: {
          preview: {
            background: {
              enabled: true,
              args: ["--host", "127.0.0.1:8589"]
            }
          },
          tinymist: {
            preview: {
              background: {
                enabled: true,
                args: ["--host", "127.0.0.1:8589"]
              }
            }
          }
        },
        workspaceFolders: null
      }, id);
    });
  }

  public openTextDocument(uri: string, text: string, version: number): Promise<void> {
    return this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "typst", version, text }
    });
  }

  public notifyTextOpen(uri: string, path: string, text: string, version: number): Promise<string> {
    this.openTextDocument(uri, text, version);
    return this.startPreview(path);
  }

  public startPreview(path: string): Promise<string> {
    // Force tinymist to render this specific file instead of auto-detecting an entry point.
    // NOTE: These commands specifically require the raw OS path, not a URI!
    this.sendRequest("workspace/executeCommand", {
      command: "tinymist.pinMain",
      arguments: [path]
    }, this.requestId++);

    this.sendRequest("workspace/executeCommand", {
      command: "tinymist.focusMain",
      arguments: [path]
    }, this.requestId++);

    // Tinymist 0.15 expects a Vec<String> as the first argument and returns server metadata.
    return new Promise<string>(async (resolve) => {
      this.setStatus("preview-starting", "Starting preview");
      const id = this.requestId++;
      let unlisten: (() => void) | undefined;
      const timeout = setTimeout(() => {
        console.warn("LSP Preview request timed out!");
        unlisten?.();
        this.setStatus("error", "Preview startup timed out");
        resolve("");
      }, 5000);

      unlisten = await listen<string>("lsp-rx", (event) => {
        try {
          const payload = JSON.parse(event.payload);
          if (payload.id === id) {
            clearTimeout(timeout);
            unlisten?.();
            if (payload.error) {
              console.error("Tinymist preview startup failed:", payload.error);
              this.setStatus("error", "Preview startup failed");
              resolve("");
              return;
            }
            const previewUrl = this.normalizePreviewUrl(payload.result);
            this.setStatus(previewUrl ? "preview-ready" : "error", previewUrl ? "Preview ready" : "Preview URL unavailable");
            resolve(previewUrl);
          }
        } catch (e) {}
      });

      this.sendRequest("workspace/executeCommand", {
        command: "tinymist.doStartPreview",
        arguments: [[path]]
      }, id);
    });
  }

  public notifyTextChange(uri: string, text: string, version: number): Promise<void> {
    return this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  public scrollPreview(taskId: string, request: ScrollPreviewRequest): Promise<void> {
    return this.sendRequest("workspace/executeCommand", {
      command: "tinymist.scrollPreview",
      arguments: [taskId, request]
    });
  }

  private sendRequest(method: string, params: any, customId?: number): Promise<void> {
    return invoke("send_lsp_message", { message: JSON.stringify({ jsonrpc: "2.0", id: customId ?? this.requestId++, method, params }) });
  }

  private sendNotification(method: string, params: any): Promise<void> {
    return invoke("send_lsp_message", { message: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }

  private sendResponse(id: number | string, result: any): Promise<void> {
    return invoke("send_lsp_message", { message: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }

  private normalizePreviewUrl(result: string | TinymistPreviewResult | null | undefined): string {
    if (typeof result === "string") {
      return result.startsWith("http") ? result : `http://${result}`;
    }

    if (result?.staticServerAddr) {
      return result.staticServerAddr.startsWith("http")
        ? result.staticServerAddr
        : `http://${result.staticServerAddr}`;
    }

    if (result?.staticServerPort) {
      return `http://127.0.0.1:${result.staticServerPort}`;
    }

    if (result?.dataPlanePort) {
      return `http://127.0.0.1:${result.dataPlanePort}`;
    }

    return "";
  }

  private setStatus(kind: LspStatusKind, message: string) {
    this.onStatus({ kind, message });
  }

  private handleServerRequest(payload: any) {
    switch (payload.method) {
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
        this.sendResponse(payload.id, null);
        return;
      case "workspace/configuration": {
        const count = Array.isArray(payload.params?.items) ? payload.params.items.length : 0;
        this.sendResponse(payload.id, Array.from({ length: count }, () => null));
        return;
      }
      default:
        if (payload.method.startsWith("$/")) {
          return;
        }
        this.sendResponse(payload.id, null);
    }
  }

  private emitLog(type: number | undefined, message: unknown, source: string) {
    const text = typeof message === "string" ? message : JSON.stringify(message ?? "");
    if (!text) return;

    this.onLog({
      kind: this.logKindFromLspType(type),
      source,
      message: text
    });
  }

  private logKindFromLspType(type: number | undefined): LspLogEntry["kind"] {
    switch (type) {
      case 1:
        return "error";
      case 2:
        return "warning";
      case 3:
        return "info";
      default:
        return "log";
    }
  }
}
