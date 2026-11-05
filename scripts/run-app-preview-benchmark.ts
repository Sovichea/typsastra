import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const api = (process.env.TYPSASTRA_DEV_API ?? "http://127.0.0.1:17342").replace(/\/$/, "");
const project = process.env.BENCHMARK_APP_PROJECT?.trim() || null;
const iterations = Math.max(1, Math.min(10, Number(process.env.BENCHMARK_APP_ITERATIONS ?? 3) || 3));
const page = Math.max(1, Number(process.env.BENCHMARK_APP_PAGE ?? 1) || 1);
const output = join(process.cwd(), "artifacts", "performance", "app-preview");

type LogEntry = {
  sequence: number;
  kind: string;
  source: string;
  message: string;
};

type Metrics = Record<string, number>;

const METRIC_NAMES = [
  "preview.compile",
  "preview.draft-prepare",
  "preview.load",
  "preview.geometry",
  "preview.first-page",
  "preview.canvas-render",
  "preview.page-render",
  "preview.render-cancel",
] as const;

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${api}${path}`, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  return response;
}

async function action(value: Record<string, unknown>): Promise<void> {
  await request("/ui/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function logs(after: number): Promise<{ entries: LogEntry[]; nextSequence: number }> {
  const response = await request(`/logs?after=${after}`);
  return await response.json() as { entries: LogEntry[]; nextSequence: number };
}

async function waitForHealth(): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    try {
      await request("/health");
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`Typsastra developer API is not reachable at ${api}.`);
}

function parseMetrics(entries: LogEntry[]): Metrics {
  const metrics: Metrics = {};
  for (const entry of entries) {
    if (entry.source !== "performance") continue;
    const match = /^(preview\.[a-z-]+): ([\d.]+) ms(?: \(.*\))?$/.exec(entry.message);
    if (!match) continue;
    metrics[match[1]] = Number(match[2]);
  }
  return metrics;
}

async function waitForRender(
  after: number,
): Promise<{ entries: LogEntry[]; metrics: Metrics }> {
  const deadline = performance.now() + 90_000;
  let entries: LogEntry[] = [];
  while (performance.now() < deadline) {
    const result = await logs(after);
    entries = result.entries;
    after = result.nextSequence;
    const failed = entries.find(entry =>
      entry.message.includes("released: succeeded=false")
    );
    if (failed) throw new Error(failed.message);
    const released = entries.some(entry =>
      entry.message.includes("released: succeeded=true")
    );
    const metrics = parseMetrics(entries);
    if (released && metrics["preview.load"] !== undefined) {
      return { entries, metrics };
    }
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for the preview render.");
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
  return {
    samples: samples.map(value => Number(value.toFixed(2))),
    minimumMs: Number(percentile(0.05).toFixed(2)),
    medianMs: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maximumMs: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

async function renderMode(mode: "normal" | "draft"): Promise<Metrics> {
  await action({ action: "close-dialogs" });
  const start = await logs(0);
  await action({ action: "preview-content-mode", mode });
  await action({ action: "preview-page", page });
  await action({ action: "close-dialogs" });
  const { metrics } = await waitForRender(start.nextSequence);
  return metrics;
}

await waitForHealth();
await request("/screenshot/window?restore=true");
if (project) {
  await request("/project/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  await Bun.sleep(8_000);
}
await action({ action: "close-dialogs" });
await action({ action: "preview-content-mode", mode: "normal" });
await action({ action: "preview-page", page });
await Bun.sleep(2_000);

// Warm both modes before measuring. The editor starts in Normal mode.
await renderMode("draft");
await renderMode("normal");

const samples: Record<"normal" | "draft", Metrics[]> = {
  normal: [],
  draft: [],
};
for (let iteration = 0; iteration < iterations; iteration += 1) {
  samples.draft.push(await renderMode("draft"));
  samples.normal.push(await renderMode("normal"));
}

const allMetrics = new Set<string>([
  ...METRIC_NAMES,
  ...Object.keys(samples.normal[0] ?? {}),
  ...Object.keys(samples.draft[0] ?? {}),
]);
const comparison = [...allMetrics]
  .filter(name => samples.normal.some(metrics => metrics[name] !== undefined)
    || samples.draft.some(metrics => metrics[name] !== undefined))
  .map(name => {
    const normal = samples.normal.flatMap(metrics => metrics[name] === undefined ? [] : [metrics[name]]);
    const draft = samples.draft.flatMap(metrics => metrics[name] === undefined ? [] : [metrics[name]]);
    return {
      metric: name,
      normal: normal.length > 0 ? summarize(normal) : null,
      draft: draft.length > 0 ? summarize(draft) : null,
      speedup: normal.length > 0 && draft.length > 0
        && summarize(normal).medianMs > 0
        && summarize(draft).medianMs > 0
        ? Number((summarize(normal).medianMs / summarize(draft).medianMs).toFixed(2))
        : null,
    };
  });

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  api,
  project,
  page,
  iterations,
  samples,
  comparison,
};
await mkdir(output, { recursive: true });
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));

const rows = comparison.map(row => {
  const normal = row.normal ? `${row.normal.medianMs.toFixed(2)} ms` : "n/a";
  const draft = row.draft ? `${row.draft.medianMs.toFixed(2)} ms` : "n/a";
  const speedup = row.speedup === null ? "n/a" : `${row.speedup.toFixed(2)}×`;
  return `| \`${row.metric}\` | ${normal} | ${draft} | ${speedup} |`;
}).join("\n");
const markdown = `# Typsastra WebView preview benchmark

Generated: ${report.generatedAt}<br>
Page: ${page}<br>
Iterations: ${iterations}

| Metric | Normal median | Draft median | Speedup |
|---|---:|---:|---:|
${rows}

Raw results are written to \`artifacts/performance/app-preview/report.json\`.
`;
await writeFile(join(output, "report.md"), markdown);
console.log(markdown);
