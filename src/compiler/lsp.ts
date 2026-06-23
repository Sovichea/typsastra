export class TinymistLspClient {
  private socket!: WebSocket;
  private requestId = 0;

  constructor(
    private serverPort: number,
    private onSvgPreviewStream: (svgContent: string) => void
  ) {}

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(`ws://127.0.0.1:${this.serverPort}`);
      this.socket.onopen = () => { this.initializeLsp(); resolve(); };
      this.socket.onerror = (err) => reject(err);
      this.socket.onmessage = async (event) => {
        const payload = JSON.parse(event.data);
        if (payload.method === "tinymist/preview/svgStream") {
          this.onSvgPreviewStream(payload.params.svg);
        }
      };
    });
  }

  private initializeLsp() {
    this.sendRequest("initialize", { processId: null, capabilities: {}, workspaceFolders: null });
  }

  public notifyTextChange(uri: string, text: string, version: number) {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  private sendRequest(method: string, params: any) {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id: this.requestId++, method, params }));
  }

  private sendNotification(method: string, params: any) {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
}
