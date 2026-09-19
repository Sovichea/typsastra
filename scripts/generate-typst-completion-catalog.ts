import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value?: string };
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
  textEdit?: { newText?: string };
};

type CompletionResult = CompletionItem[] | { items?: CompletionItem[] } | null;

const executable = process.argv[2]
  ?? process.env.TINYMIST_PATH
  ?? "tinymist";
const output = resolve(process.argv[3] ?? "src/editor/typstCompletionCatalog.generated.json");
const probePath = resolve(".typsastra-completion-catalog.typ");
const probeUri = pathToFileURL(probePath).href;
const rootUri = pathToFileURL(resolve(".")).href;

const child = Bun.spawn([executable, "lsp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

let requestId = 0;
let version = 1;
let incoming = new Uint8Array();
const pending = new Map<number, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function headerEnd(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10
      && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
  }
  return -1;
}

function consumeMessages(): void {
  while (true) {
    const end = headerEnd(incoming);
    if (end < 0) return;
    const header = new TextDecoder().decode(incoming.slice(0, end));
    const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1]);
    if (!Number.isFinite(length)) throw new Error(`Invalid LSP header: ${header}`);
    const messageEnd = end + 4 + length;
    if (incoming.length < messageEnd) return;
    const message = JSON.parse(new TextDecoder().decode(incoming.slice(end + 4, messageEnd))) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    incoming = incoming.slice(messageEnd);
    if (typeof message.id !== "number") continue;
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "LSP request failed"));
    else waiter.resolve(message.result);
  }
}

async function readMessages(): Promise<void> {
  const reader = child.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    incoming = appendBytes(incoming, value);
    consumeMessages();
  }
}

function send(message: unknown): void {
  const payload = JSON.stringify(message);
  const bytes = new TextEncoder().encode(payload);
  child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`);
  child.stdin.write(bytes);
  child.stdin.flush();
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = ++requestId;
  const response = new Promise<unknown>((resolveResponse, reject) => {
    pending.set(id, { resolve: resolveResponse, reject });
  });
  send({ jsonrpc: "2.0", id, method, params });
  return response;
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

function items(result: CompletionResult): CompletionItem[] {
  return Array.isArray(result) ? result : result?.items ?? [];
}

function insertion(item: CompletionItem): string {
  return item.textEdit?.newText ?? item.insertText ?? item.label;
}

function serializable(item: CompletionItem): CompletionItem {
  return {
    label: item.label,
    ...(item.kind === undefined ? {} : { kind: item.kind }),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.documentation ? { documentation: item.documentation } : {}),
    ...(item.insertText ? { insertText: item.insertText } : {}),
    ...(item.insertTextFormat === undefined ? {} : { insertTextFormat: item.insertTextFormat }),
    ...(item.sortText ? { sortText: item.sortText } : {}),
    ...(item.textEdit?.newText ? { textEdit: { newText: item.textEdit.newText } } : {}),
  };
}

function looksCallable(item: CompletionItem): boolean {
  const text = `${item.detail ?? ""} ${insertion(item)}`;
  return item.kind === 2 || item.kind === 3 || /(?:=>|\()/u.test(text);
}

function signatureParameters(detail: string | undefined): string[] {
  if (!detail?.startsWith("(")) return [];
  const parameters: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 1; index < detail.length; index += 1) {
    const character = detail[index] ?? "";
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        if (current.trim()) parameters.push(current.trim());
        break;
      }
      depth -= 1;
      current += character;
      continue;
    }
    if (character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
      current += character;
      continue;
    }
    if (character === "," && depth === 0) {
      if (current.trim()) parameters.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  return parameters;
}

function fieldsFromSignature(item: CompletionItem): CompletionItem[] {
  return signatureParameters(item.detail).flatMap(parameter => {
    const match = /^([\p{L}_][\p{L}\p{M}\p{N}_-]*):\s*(.+)$/u.exec(parameter);
    if (!match) return [];
    const [, label, detail] = match;
    return [{
      label,
      kind: 5,
      detail,
      insertText: `${label}: `,
    }];
  });
}

async function complete(text: string, character: number): Promise<CompletionItem[]> {
  version += 1;
  notify("textDocument/didChange", {
    textDocument: { uri: probeUri, version },
    contentChanges: [{ text }],
  });
  return items(await request("textDocument/completion", {
    textDocument: { uri: probeUri },
    position: { line: 0, character },
    context: { triggerKind: 1 },
  }) as CompletionResult);
}

const messagePump = readMessages();

try {
  const initialize = await request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "Typsastra completion catalog" }],
    capabilities: {
      workspace: { workspaceFolders: true },
      textDocument: {
        completion: {
          completionItem: {
            snippetSupport: true,
            documentationFormat: ["markdown", "plaintext"],
          },
        },
      },
    },
  }) as { serverInfo?: { name?: string; version?: string } };
  notify("initialized", {});
  notify("textDocument/didOpen", {
    textDocument: {
      uri: probeUri,
      languageId: "typst",
      version,
      text: "#",
    },
  });

  const globals = (await complete("#", 1))
    .filter(item => item.label && !item.label.startsWith("@"));
  const fields: Record<string, CompletionItem[]> = {};
  for (const item of globals.filter(looksCallable)) {
    const name = item.label.replace(/^#/u, "").replace(/\.(?:paren|bracket)$/u, "");
    if (!/^[\p{L}_][\p{L}\p{M}\p{N}_.-]*$/u.test(name)) continue;
    const named = fieldsFromSignature(item);
    if (named.length === 0 || fields[name]) continue;
    fields[name] = named.map(serializable);
  }

  const catalog = {
    schemaVersion: 1,
    generatedBy: initialize.serverInfo ?? { name: "tinymist" },
    globals: globals.map(serializable),
    fields,
  };
  await Bun.write(output, `${JSON.stringify(catalog, null, 2)}\n`);
  console.error(
    `Wrote ${catalog.globals.length} global entries and ${Object.values(fields).reduce((sum, value) => sum + value.length, 0)} fields to ${output}.`,
  );
} finally {
  notify("textDocument/didClose", { textDocument: { uri: probeUri } });
  await request("shutdown", null).catch(() => {});
  notify("exit", null);
  child.stdin.end();
  await child.exited;
  await messagePump;
  const stderr = await new Response(child.stderr).text();
  if (child.exitCode !== 0 && stderr.trim()) console.error(stderr.trim());
}
