type TauriMode = "dev" | "build";

type ProcessResult = {
  exitCode: number;
  output: string;
};

const MAX_CAPTURED_OUTPUT = 128 * 1024;
const INTERRUPTED_EXIT_CODES = new Set([130, 143]);
const NATIVE_CRASH_EXIT_CODES = new Set([132, 134, 135, 136, 139]);

function usage(): never {
  console.error("Usage: bun scripts/run-tauri-with-fallback.ts <dev|build> [--fresh] [...tauri arguments]");
  process.exit(2);
}

export function tauriArgumentsFor(mode: TauriMode, rawArguments: readonly string[]): string[] {
  const argumentsForTauri = [mode, ...rawArguments.filter(argument => argument !== "--fresh")];
  if (rawArguments.includes("--fresh")) {
    argumentsForTauri.push("--config", "src-tauri/tauri.fresh.conf.json");
  }
  return argumentsForTauri;
}

function appendCaptured(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_CAPTURED_OUTPUT
    ? combined
    : combined.slice(combined.length - MAX_CAPTURED_OUTPUT);
}

async function runProcess(
  command: string[],
  options: { mirrorOutput: boolean },
): Promise<ProcessResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      exitCode: 127,
      output: error instanceof Error ? error.message : String(error),
    };
  }

  let output = "";
  const copyStream = async (
    stream: ReadableStream<Uint8Array>,
    destination: NodeJS.WriteStream,
  ): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (options.mirrorOutput) destination.write(value);
      output = appendCaptured(output, decoder.decode(value, { stream: true }));
    }
    output = appendCaptured(output, decoder.decode());
  };

  const stdout = copyStream(child.stdout, process.stdout);
  const stderr = copyStream(child.stderr, process.stderr);
  const exitCode = await child.exited;
  await Promise.all([stdout, stderr]);
  return { exitCode, output };
}

async function resolvedTauriCli(): Promise<{ script: string; version: string } | null> {
  const packagePath = `${process.cwd()}/node_modules/@tauri-apps/cli/package.json`;
  const script = `${process.cwd()}/node_modules/@tauri-apps/cli/tauri.js`;
  if (!(await Bun.file(packagePath).exists()) || !(await Bun.file(script).exists())) return null;
  try {
    const packageJson = await Bun.file(packagePath).json() as { version?: unknown };
    if (typeof packageJson.version !== "string" || packageJson.version.length === 0) return null;
    return { script, version: packageJson.version };
  } catch {
    return null;
  }
}

export function isBundledCliFailure(result: ProcessResult): boolean {
  if (NATIVE_CRASH_EXIT_CODES.has(result.exitCode)) return true;
  const output = result.output.toLowerCase();
  return [
    "segmentation fault",
    "sigsegv",
    "illegal instruction",
    "bus error",
    "exec format error",
    "error while loading shared libraries",
    "failed to load @tauri-apps/cli",
    "cannot find module '@tauri-apps/cli",
    "could not load the tauri cli",
  ].some((marker) => output.includes(marker));
}

export function installedCargoTauriVersion(output: string): string | null {
  return output.match(/tauri-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)/iu)?.[1] ?? null;
}

async function ensureCargoTauri(expectedVersion: string): Promise<boolean> {
  const cargo = Bun.which("cargo");
  if (!cargo) {
    console.error(
      "The bundled Tauri CLI failed, and Cargo is unavailable. Install Rust/Cargo before retrying.",
    );
    return false;
  }

  const current = await runProcess([cargo, "tauri", "--version"], { mirrorOutput: false });
  if (
    current.exitCode === 0
    && installedCargoTauriVersion(current.output) === expectedVersion
  ) {
    return true;
  }

  const installedVersion = installedCargoTauriVersion(current.output);
  console.warn(
    installedVersion
      ? `Installing tauri-cli ${expectedVersion} because Cargo currently provides ${installedVersion}...`
      : `Installing tauri-cli ${expectedVersion} for the fallback build path...`,
  );
  const installation = await runProcess([
    cargo,
    "install",
    "tauri-cli",
    "--version",
    expectedVersion,
    "--locked",
    "--force",
  ], { mirrorOutput: true });
  if (installation.exitCode !== 0) {
    console.error(`Failed to install tauri-cli ${expectedVersion}.`);
    return false;
  }
  return true;
}

async function lockedTauriCliVersion(): Promise<string | null> {
  try {
    const lock = await Bun.file(`${process.cwd()}/bun.lock`).text();
    return lock.match(/"@tauri-apps\/cli":\s*\["@tauri-apps\/cli@(\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)/iu)?.[1]
      ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const mode = Bun.argv[2] as TauriMode | undefined;
  if (mode !== "dev" && mode !== "build") usage();
  const rawArguments = Bun.argv.slice(3);
  const fresh = rawArguments.includes("--fresh");
  if (fresh && mode !== "dev") {
    console.error("--fresh is only supported for dev.");
    process.exit(2);
  }
  const tauriArguments = tauriArgumentsFor(mode, rawArguments);
  if (fresh) {
    process.env.TYPSASTRA_DEV_LOG_API_ADDR ??= "127.0.0.1:17343";
  }
  const bundledCli = await resolvedTauriCli();

  if (bundledCli) {
    const bundledResult = await runProcess(
      [process.execPath, bundledCli.script, ...tauriArguments],
      { mirrorOutput: true },
    );
    if (bundledResult.exitCode === 0) return 0;
    if (INTERRUPTED_EXIT_CODES.has(bundledResult.exitCode)) return bundledResult.exitCode;
    if (!isBundledCliFailure(bundledResult)) return bundledResult.exitCode;

    console.warn(
      `The bundled Tauri CLI failed at the native runtime level (exit ${bundledResult.exitCode}). `
        + "Retrying with the Rust-installed Cargo CLI...",
    );
  } else {
    console.warn(
      "The bundled @tauri-apps/cli installation is unavailable. Trying the Rust-installed Cargo CLI...",
    );
  }

  const expectedVersion = bundledCli?.version ?? await lockedTauriCliVersion();
  if (!expectedVersion) {
    console.error("Unable to determine the Tauri CLI version from node_modules or bun.lock.");
    return 1;
  }
  if (!(await ensureCargoTauri(expectedVersion))) return 1;
  const cargo = Bun.which("cargo");
  if (!cargo) return 1;
  const fallbackResult = await runProcess([cargo, "tauri", ...tauriArguments], {
    mirrorOutput: true,
  });
  return fallbackResult.exitCode;
}

if (import.meta.main) process.exit(await main());
