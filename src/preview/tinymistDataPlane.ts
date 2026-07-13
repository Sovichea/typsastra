const decoder = new TextDecoder();
const positionFrameKinds = new Set(["jump", "viewport"]);
const documentFrameKinds = new Set(["new", "diff-v1"]);

function protocolTextFromBytes(bytes: Uint8Array): string | null {
  const comma = bytes.indexOf(44);
  if (comma < 0) return null;
  const kind = decoder.decode(bytes.subarray(0, comma));
  if (documentFrameKinds.has(kind)) return null;
  return positionFrameKinds.has(kind) ? decoder.decode(bytes) : null;
}

export async function tinymistDataPlanePositionText(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    const kind = data.slice(0, Math.max(0, data.indexOf(",")));
    return documentFrameKinds.has(kind) ? null : data;
  }
  if (data instanceof ArrayBuffer) {
    return protocolTextFromBytes(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return protocolTextFromBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return protocolTextFromBytes(new Uint8Array(await data.arrayBuffer()));
  }
  return null;
}
