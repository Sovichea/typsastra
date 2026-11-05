import { cpus, totalmem, release, type } from "node:os";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { Text } from "@codemirror/state";
import { expandSpellcheckRange } from "../src/editor/spellcheck";
import { PERFORMANCE_BUDGETS } from "../src/performance/diagnostics";

const root = process.cwd();
const output = join(root, "artifacts", "performance");
const fixtures = ["01-page", "20-pages-interaction", "30-pages", "100-pages"] as const;
const compileIterations = 5;
const incrementalIterations = 10;

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function commandOutput(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function compileFixture(fixture: string): Promise<number> {
  const startedAt = performance.now();
  const child = Bun.spawn([
    "typst", "compile",
    join(root, "benchmarks", "fixtures", `${fixture}.typ`),
    join(output, `${fixture}.pdf`)
  ], { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Typst failed to compile ${fixture}.`);
  return performance.now() - startedAt;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: samples.map(value => Number(value.toFixed(2))),
    minimumMs: Number(sorted[0].toFixed(2)),
    medianMs: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    maximumMs: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

async function directorySize(path: string): Promise<number | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      const child = join(path, entry.name);
      bytes += entry.isDirectory()
        ? (await directorySize(child) ?? 0)
        : (await stat(child)).size;
    }
    return bytes;
  } catch {
    return null;
  }
}

type ProcessMemorySample = {
  workingSetBytes: number;
  peakWorkingSetBytes: number;
};

type WindowsMemoryApi = {
  openProcess(pid: number): number;
  closeHandle(handle: number): void;
  readMemory(handle: number): ProcessMemorySample | null;
};

function loadWindowsMemoryApi(): WindowsMemoryApi | null {
  if (process.platform !== "win32") return null;
  try {
    const kernel = dlopen("kernel32.dll", {
      OpenProcess: {
        args: [FFIType.u32, FFIType.bool, FFIType.u32],
        returns: FFIType.ptr,
      },
      CloseHandle: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
    }).symbols as {
      OpenProcess: (access: number, inherit: boolean, pid: number) => number;
      CloseHandle: (handle: number) => boolean;
    };
    const psapi = dlopen("psapi.dll", {
      GetProcessMemoryInfo: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.bool,
      },
    }).symbols as {
      GetProcessMemoryInfo: (handle: number, counters: unknown, size: number) => boolean;
    };
    return {
      openProcess: pid => kernel.OpenProcess(0x0410, false, pid),
      closeHandle: handle => { kernel.CloseHandle(handle); },
      readMemory: handle => {
        const counters = new Uint8Array(72);
        new DataView(counters.buffer).setUint32(0, counters.byteLength, true);
        if (!psapi.GetProcessMemoryInfo(handle, ptr(counters), counters.byteLength)) {
          return null;
        }
        const view = new DataView(counters.buffer);
        return {
          peakWorkingSetBytes: Number(view.getBigUint64(8, true)),
          workingSetBytes: Number(view.getBigUint64(16, true)),
        };
      },
    };
  } catch {
    return null;
  }
}

const windowsMemoryApi = loadWindowsMemoryApi();

async function readProcessMemory(pid: number): Promise<ProcessMemorySample | null> {
  if (windowsMemoryApi) {
    const handle = windowsMemoryApi.openProcess(pid);
    if (!handle) return null;
    try {
      return windowsMemoryApi.readMemory(handle);
    } finally {
      windowsMemoryApi.closeHandle(handle);
    }
  }
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const rss = /VmRSS:\s+(\d+)\s+kB/i.exec(status);
      const peak = /VmHWM:\s+(\d+)\s+kB/i.exec(status);
      if (!rss) return null;
      return {
        workingSetBytes: Number(rss[1]) * 1024,
        peakWorkingSetBytes: Number(peak?.[1] ?? rss[1]) * 1024,
      };
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const child = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      if (await child.exited !== 0) return null;
      const kilobytes = Number((await new Response(child.stdout).text()).trim());
      if (!Number.isFinite(kilobytes) || kilobytes <= 0) return null;
      return {
        workingSetBytes: kilobytes * 1024,
        peakWorkingSetBytes: kilobytes * 1024,
      };
    } catch {
      return null;
    }
  }
  return null;
}

async function findManagedTinymist(): Promise<string | null> {
  const localData = process.env.LOCALAPPDATA;
  if (!localData) return null;
  const toolchainRoot = join(localData, "com.typsastra.editor.dev", "toolchain");
  try {
    const versions = await readdir(toolchainRoot, { withFileTypes: true });
    const candidates = versions
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of candidates) {
      const executable = join(toolchainRoot, version, "tinymist.exe");
      if ((await stat(executable)).isFile()) return executable;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveTinymistBinary(): Promise<string | null> {
  const configured = process.env.TINYMIST_BIN?.trim();
  if (configured && (await stat(configured).catch(() => null))?.isFile()) return configured;
  const onPath = Bun.which("tinymist");
  if (onPath) return onPath;
  return findManagedTinymist();
}

type ThumbnailWorkerRun = {
  workers: number;
  jobs: number;
  wallMs: number;
  medianJobMs: number;
  maxProcessPeakMiB: number | null;
  maxAggregatePeakMiB: number | null;
};

type ThumbnailWorkerBenchmark = {
  available: boolean;
  binary: string | null;
  version: string | null;
  fixture: string;
  jobsPerRun: number;
  diagramsPerJob: number;
  runs: ThumbnailWorkerRun[];
  speedup: number | null;
  speedupTwo: number | null;
  reason: string | null;
};

const THUMBNAIL_WORKER_COUNTS = [1, 2, 4] as const;
const THUMBNAIL_JOBS_PER_RUN = 6;
const THUMBNAIL_DIAGRAMS_PER_JOB = 6;

function summarizeThumbnailRun(
  workers: number,
  wallMs: number,
  durations: number[],
  peaks: number[],
  aggregatePeakBytes: number,
): ThumbnailWorkerRun {
  const sorted = [...durations].sort((left, right) => left - right);
  const median = sorted[Math.max(0, Math.floor(sorted.length / 2))] ?? 0;
  return {
    workers,
    jobs: durations.length,
    wallMs: Number(wallMs.toFixed(2)),
    medianJobMs: Number(median.toFixed(2)),
    maxProcessPeakMiB: peaks.length > 0
      ? Number((Math.max(...peaks) / 1024 / 1024).toFixed(2))
      : null,
    maxAggregatePeakMiB: aggregatePeakBytes > 0
      ? Number((aggregatePeakBytes / 1024 / 1024).toFixed(2))
      : null,
  };
}

async function benchmarkTinymistThumbnailWorkers(): Promise<ThumbnailWorkerBenchmark> {
  const binary = await resolveTinymistBinary();
  const empty = {
    available: false,
    binary,
    version: null,
    fixture: "benchmarks/fixtures/thumbnail-worker.typ",
    jobsPerRun: THUMBNAIL_JOBS_PER_RUN,
    diagramsPerJob: THUMBNAIL_DIAGRAMS_PER_JOB,
    runs: [] as ThumbnailWorkerRun[],
    speedup: null,
    speedupTwo: null,
    reason: null as string | null,
  };
  if (!binary) {
    return { ...empty, reason: "Tinymist CLI was not found; set TINYMIST_BIN to enable this section." };
  }
  const version = await commandOutput([binary, "--version"]).catch(error => {
    empty.reason = `Tinymist CLI could not be inspected: ${String(error)}`;
    return null;
  });
  if (!version) return empty;

  const fixture = join(root, "benchmarks", "fixtures", "thumbnail-worker.typ");
  const fixtureRoot = join(root, "benchmarks", "fixtures");
  const outputRoot = join(output, "thumbnail-workers");
  await mkdir(outputRoot, { recursive: true });
  let sequence = 0;
  const runJob = async (active: Set<number>): Promise<number> => {
    const job = sequence++;
    const jobDirectory = join(outputRoot, `job-${job}`);
    await rm(jobDirectory, { recursive: true, force: true });
    await mkdir(jobDirectory, { recursive: true });
    const destination = join(jobDirectory, "page-{p}.svg");
    const startedAt = performance.now();
    const child = Bun.spawn([
      binary,
      "compile",
      fixture,
      destination,
      "--root",
      fixtureRoot,
      "--format",
      "svg",
    ], {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, RAYON_NUM_THREADS: "1" },
    });
    if (child.pid) active.add(child.pid);
    const exitCode = await child.exited;
    if (child.pid) active.delete(child.pid);
    const stderr = (await new Response(child.stderr).text()).trim();
    await rm(jobDirectory, { recursive: true, force: true });
    if (exitCode !== 0) {
      throw new Error(`Tinymist thumbnail compile failed: ${stderr}`);
    }
    return performance.now() - startedAt;
  };

  try {
    await runJob(new Set());
  } catch (error) {
    return {
      ...empty,
      available: false,
      version,
      reason: `Tinymist thumbnail fixture could not compile: ${String(error)}`,
    };
  }
  const runs: ThumbnailWorkerRun[] = [];
  for (const workers of THUMBNAIL_WORKER_COUNTS) {
    const active = new Set<number>();
    const peaks = new Map<number, number>();
    let aggregatePeakBytes = 0;
    let monitoring = true;
    const monitor = (async () => {
      while (monitoring) {
        let aggregate = 0;
        for (const pid of active) {
          const sample = await readProcessMemory(pid);
          if (!sample) continue;
          peaks.set(pid, Math.max(peaks.get(pid) ?? 0, sample.peakWorkingSetBytes));
          aggregate += sample.workingSetBytes;
        }
        aggregatePeakBytes = Math.max(aggregatePeakBytes, aggregate);
        await Bun.sleep(15);
      }
    })();
    const durations: number[] = [];
    const jobs = Array.from({ length: THUMBNAIL_JOBS_PER_RUN }, (_, index) => index);
    const startedAt = performance.now();
    await Promise.all(Array.from({ length: workers }, async () => {
      while (jobs.length > 0) {
        jobs.shift();
        durations.push(await runJob(active));
      }
    }));
    const wallMs = performance.now() - startedAt;
    monitoring = false;
    await monitor;
    const perProcessPeaks = [...peaks.values()];
    runs.push(summarizeThumbnailRun(
      workers,
      wallMs,
      durations,
      perProcessPeaks,
      aggregatePeakBytes,
    ));
  }
  const single = runs.find(run => run.workers === 1);
  const double = runs.find(run => run.workers === 2);
  const quad = runs.find(run => run.workers === 4);
  return {
    available: true,
    binary,
    version,
    fixture: "benchmarks/fixtures/thumbnail-worker.typ",
    jobsPerRun: THUMBNAIL_JOBS_PER_RUN,
    diagramsPerJob: THUMBNAIL_DIAGRAMS_PER_JOB,
    runs,
    speedup: single && quad && quad.wallMs > 0
      ? Number((single.wallMs / quad.wallMs).toFixed(2))
      : null,
    speedupTwo: single && double && double.wallMs > 0
      ? Number((single.wallMs / double.wallMs).toFixed(2))
      : null,
    reason: null,
  };
}

const typstVersion = await commandOutput(["typst", "--version"]);
const tinymistPackage = await Bun.file(join(root, "node_modules", "tinymist", "package.json")).json();
const gitRevision = await commandOutput(["git", "rev-parse", "--short", "HEAD"]);
const gitStatus = await commandOutput(["git", "status", "--porcelain"]);

// This is a first-process measurement, not a true OS cold-cache measurement.
const firstProcessCompileMs = await compileFixture("01-page");

const compile: Record<string, ReturnType<typeof summarize>> = {};
for (const fixture of fixtures) {
  await compileFixture(fixture); // Per-fixture warmup, excluded from the report.
  const samples: number[] = [];
  for (let iteration = 0; iteration < compileIterations; iteration += 1) {
    samples.push(await compileFixture(fixture));
  }
  compile[fixture] = summarize(samples);
}

const paragraph = "Technical writing ភាសាខ្មែរ with mixed scripts and repeatable content.\n";
const largeSource = paragraph.repeat(Math.ceil(100_000 / paragraph.length)).slice(0, 100_000);
await writeFile(join(output, "100000-characters.typ"), largeSource);
const doc = Text.of(largeSource.split("\n"));
let maximumSubmittedRange = 0;
const incrementalSamples: number[] = [];
for (let run = 0; run < incrementalIterations; run += 1) {
  const startedAt = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    const position = (index * 97) % Math.max(1, doc.length - 1);
    const range = expandSpellcheckRange(doc, position, position + 1, [/[A-Za-z]/u, /[\u1780-\u17ff]/u]);
    maximumSubmittedRange = Math.max(maximumSubmittedRange, range.to - range.from);
  }
  incrementalSamples.push(performance.now() - startedAt);
}

const tinymistThumbnailWorkers = await benchmarkTinymistThumbnailWorkers();

const processor = cpus()[0];
const report = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  scope: "CLI compiler, Tinymist thumbnail workers, incremental-range calculation, and built frontend artifacts; not total desktop runtime",
  source: {
    gitRevision,
    workingTreeDirty: gitStatus.length > 0
  },
  machine: {
    platform: process.platform,
    architecture: process.arch,
    operatingSystem: `${type()} ${release()}`,
    cpu: processor?.model.trim() ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem()
  },
  tools: {
    bun: Bun.version,
    typst: typstVersion,
    tinymistPackage: String(tinymistPackage.version),
    tinymistCli: tinymistThumbnailWorkers.version
  },
  budgets: PERFORMANCE_BUDGETS,
  compile: {
    iterationsPerFixture: compileIterations,
    firstProcessOnePageMs: Number(firstProcessCompileMs.toFixed(2)),
    warm: compile
  },
  tinymistThumbnailWorkers,
  incrementalSpellcheck: {
    documentUtf16: doc.length,
    editsPerIteration: 1_000,
    iterations: incrementalIterations,
    timing: summarize(incrementalSamples),
    maximumSubmittedUtf16: maximumSubmittedRange
  },
  artifacts: {
    frontendDistBytes: await directorySize(join(root, "dist"))
  },
  limitations: [
    "The first-process compile does not clear operating-system filesystem caches.",
    "Typst CLI process timings are not equivalent to in-app Tinymist preview latency.",
    "Frontend dist size is not installer size.",
    "Desktop, WebView, PDF renderer, GPU, and long-lived LSP memory are not measured by this harness.",
    "Tinymist thumbnail worker memory is reported as peak working set and excludes the main LSP process.",
    "Thumbnail worker runs use a small Fletcher fixture; larger diagrams or Cetz canvases may use more memory.",
    "Aggregate worker memory is an upper bound because shared pages can be counted more than once."
  ]
};

const one = report.compile.warm["01-page"];
const interaction = report.compile.warm["20-pages-interaction"];
const thirty = report.compile.warm["30-pages"];
const hundred = report.compile.warm["100-pages"];
const spellcheck = report.incrementalSpellcheck.timing;
const mib = (bytes: number | null) => bytes === null ? "not built" : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const workerMiB = (value: number | null) => value === null ? "n/a" : `${value.toFixed(2)} MiB`;
const thumbnailWorkers = report.tinymistThumbnailWorkers;
const thumbnailSection = thumbnailWorkers.available
  ? `## Tinymist thumbnail workers

Each run launches ${thumbnailWorkers.jobsPerRun} fresh Tinymist CLI processes against \`${thumbnailWorkers.fixture}\`, with the requested number of workers pulling from a shared queue. Each process compiles ${thumbnailWorkers.diagramsPerJob} diagram pages, matching the app's chunk size. No LSP is started.

| Workers | Jobs | Wall time | Median job | Max process peak | Max aggregate peak |
|---:|---:|---:|---:|---:|---:|
${thumbnailWorkers.runs.map(run =>
  `| ${run.workers} | ${run.jobs} | ${run.wallMs.toFixed(2)} ms | ${run.medianJobMs.toFixed(2)} ms | ${workerMiB(run.maxProcessPeakMiB)} | ${workerMiB(run.maxAggregatePeakMiB)} |`
).join("\n")}

- Two-worker speedup: **${thumbnailWorkers.speedupTwo === null ? "n/a" : `${thumbnailWorkers.speedupTwo.toFixed(2)}×`}**.
- Four-worker speedup: **${thumbnailWorkers.speedup === null ? "n/a" : `${thumbnailWorkers.speedup.toFixed(2)}×`}**.
- The main Typsastra Tinymist LSP is not running during this measurement.
- Peak working set is sampled while each process is alive; very short-lived processes can be under-sampled.
`
  : `## Tinymist thumbnail workers

Tinymist CLI measurements were skipped: ${thumbnailWorkers.reason ?? "Tinymist CLI is unavailable."}
`;
const markdown = `# Typsastra benchmark report

Generated: ${report.generatedAt}<br>
Revision: \`${gitRevision}\`${report.source.workingTreeDirty ? " (working tree had uncommitted changes)" : ""}

## Scope

This report measures CLI compiler process time, dedicated Tinymist thumbnail worker time and memory, incremental spellcheck-range calculation, and built frontend artifact size. It does **not** claim to measure total Typsastra desktop memory, the long-lived LSP, or end-to-end WebView preview latency.

## Machine and tools

| Item | Value |
|---|---|
| OS | ${report.machine.operatingSystem} (${report.machine.architecture}) |
| CPU | ${report.machine.cpu} (${report.machine.logicalCpuCount} logical CPUs) |
| Installed memory | ${(report.machine.totalMemoryBytes / 1024 / 1024 / 1024).toFixed(2)} GiB |
| Bun | ${report.tools.bun} |
| Typst | ${report.tools.typst} |
| Tinymist npm package | ${report.tools.tinymistPackage} |
| Tinymist CLI | ${report.tools.tinymistCli ?? "not found"} |

## Results

Each warm compiler result contains ${compileIterations} fresh Typst CLI processes after a fixture-specific warmup.

| Workload | Minimum | Median | p95 / maximum |
|---|---:|---:|---:|
| One-page compile | ${one.minimumMs.toFixed(2)} ms | ${one.medianMs.toFixed(2)} ms | ${one.p95Ms.toFixed(2)} ms |
| 20-page multilingual interaction fixture compile | ${interaction.minimumMs.toFixed(2)} ms | ${interaction.medianMs.toFixed(2)} ms | ${interaction.p95Ms.toFixed(2)} ms |
| 30-page compile | ${thirty.minimumMs.toFixed(2)} ms | ${thirty.medianMs.toFixed(2)} ms | ${thirty.p95Ms.toFixed(2)} ms |
| 100-page compile | ${hundred.minimumMs.toFixed(2)} ms | ${hundred.medianMs.toFixed(2)} ms | ${hundred.p95Ms.toFixed(2)} ms |
| 1,000 incremental range calculations | ${spellcheck.minimumMs.toFixed(2)} ms | ${spellcheck.medianMs.toFixed(2)} ms | ${spellcheck.p95Ms.toFixed(2)} ms |

- First-process one-page compile: **${report.compile.firstProcessOnePageMs.toFixed(2)} ms**. This does not clear OS filesystem caches.
- Largest submitted incremental spellcheck range: **${maximumSubmittedRange} UTF-16 units** from a ${doc.length.toLocaleString("en-US")}-unit document.
- Built frontend \`dist/\` size: **${mib(report.artifacts.frontendDistBytes)}**. This is not installer size.

${thumbnailSection}
## Limitations

${report.limitations.map(item => `- ${item}`).join("\n")}

## Reproduce

From the repository root, with the recorded Typst and Tinymist tools available:

\`\`\`sh
bun install --frozen-lockfile
bun run build
bun run benchmark:performance
\`\`\`

Raw results are written to \`artifacts/performance/report.json\`.
`;

await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
await writeFile(join(output, "report.md"), markdown);
console.log(markdown);

if (doc.length < 100_000) throw new Error("Large-source fixture is too small.");
if (maximumSubmittedRange >= doc.length) throw new Error("Incremental spellcheck resent the full document.");
