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

export class TinymistLspClient {
  private requestId = 0;
  private editorView?: EditorView;

  constructor(
    private onSvgPreviewStream: (svgContent: string) => void,
    private onStatus: (status: LspStatus) => void = () => {},
    private onInverseSync: (position: LspSourcePosition, defaultCursorPos: number) => number | void = () => {}
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

  private handleMessage(payload: any) {
    if (payload.method === "tinymist/preview/svgStream") {
      this.onSvgPreviewStream(payload.params.svg);
    }

    // Sometimes tinymist sends logs or errors!
    if (payload.method === "window/showMessage") {
      console.log("LSP Message:", payload.params);
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
        capabilities: {},
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

  public notifyTextOpen(uri: string, path: string, text: string, version: number): Promise<string> {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "typst", version, text }
    });

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
}
