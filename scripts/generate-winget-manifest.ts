/**
 * Regenerate the winget manifest directory for a published Typsastra release.
 *
 * Usage:
 *   bun scripts/generate-winget-manifest.ts <version> [--dry-run] [--release-date YYYY-MM-DD]
 *
 * The script downloads the published MSIs, hashes them, reads the MSI Property
 * table for the installer identity, and rewrites the manifest files. Values that
 * a human would otherwise have to look up by hand (SHA-256, ProductCode,
 * ReleaseDate) come from the published assets; UpgradeCode is checked against
 * both architectures and the most recent checked-in version.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_IDENTIFIER = "Typsastra.Typsastra";
const MANIFEST_ROOT = resolve(import.meta.dir, "..", "winget", "manifests", "t", "Typsastra", "Typsastra");
const ICON_SOURCE = resolve(import.meta.dir, "..", "src-tauri", "icons", "128x128.png");
const MANIFEST_VERSION = "1.28.0";
/** Kept in step with the release matrix in .github/workflows/release.yml. */
const ARCHITECTURES = ["x64", "arm64"] as const;

const REPOSITORY = "Sovichea/typsastra";
const HOMEPAGE = "https://github.com/Sovichea/typsastra";

/**
 * Locale metadata. ShortDescription and Tags are reviewed prose rather than
 * build output, so they live here instead of being scraped from the previous
 * manifest; checkManifestDrift warns when an existing manifest disagrees.
 */
const LOCALE_METADATA = {
  publisher: "Typsastra",
  publisherUrl: HOMEPAGE,
  publisherSupportUrl: `${HOMEPAGE}/issues`,
  packageName: "Typsastra",
  packageUrl: HOMEPAGE,
  license: "MIT",
  shortDescription:
    "Typst editor with live preview, autocomplete, outline, diagnostics, and project navigation.",
  moniker: "typsastra",
  tags: ["typst", "editor", "typesetting", "latex", "preview", "tinymist"],
  documentations: [
    { label: "Installation guide", path: "docs/INSTALL.md" },
    { label: "Troubleshooting", path: "docs/TROUBLESHOOTING.md" },
  ],
} as const;

interface MsiProperties {
  ProductName?: string;
  ProductVersion?: string;
  Manufacturer?: string;
  ProductCode?: string;
  UpgradeCode?: string;
  ALLUSERS?: string;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireTool(tool: string, hint: string): string {
  const path = Bun.which(tool);
  if (!path) fail(`${tool} was not found. ${hint}`);
  return path;
}

function parseArguments(argv: string[]): { version: string; dryRun: boolean; releaseDate?: string } {
  const positional: string[] = [];
  let dryRun = false;
  let releaseDate: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--release-date") releaseDate = argv[++index];
    else if (argument?.startsWith("--")) fail(`Unknown option ${argument}.`);
    else if (argument) positional.push(argument);
  }
  if (positional.length !== 1) fail("Expected exactly one version, for example 0.10.0.");
  const version = positional[0].replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) fail(`Invalid version ${JSON.stringify(version)}.`);
  if (releaseDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(releaseDate)) {
    fail(`Invalid --release-date ${JSON.stringify(releaseDate)}.`);
  }
  return { version, dryRun, releaseDate };
}

/**
 * Read the MSI Property table through the Windows Installer COM API.
 * Reflection-based late binding corrupts Record.StringData, so call the methods
 * directly and read the 1-indexed string rather than casting it.
 *
 * Paths arrive as one newline-delimited argument: `powershell -File` binds extra
 * arguments positionally, so a `[string[]]` parameter silently receives only the
 * first path and the rest of the installers go unread.
 */
function readMsiProperties(paths: string[]): Map<string, MsiProperties> {
  const script = `
param([string]$PathList)
$installer = New-Object -ComObject WindowsInstaller.Installer
$results = @()
foreach ($path in ($PathList -split "\`n")) {
  if ([string]::IsNullOrWhiteSpace($path)) { continue }
  $values = @{}
  $database = $installer.OpenDatabase($path, 0)
  $view = $database.OpenView("SELECT \`\`Property\`\`,\`\`Value\`\` FROM \`\`Property\`\`")
  $view.Execute()
  while ($true) {
    $record = $view.Fetch()
    if ($null -eq $record) { break }
    $values[$record.StringData(1)] = $record.StringData(2)
  }
  $results += ,@{ path = $path; values = $values }
}
$results | ConvertTo-Json -Depth 4 -Compress
`;
  const directory = mkdtempSync(join(tmpdir(), "typsastra-msi-"));
  const scriptPath = join(directory, "read-msi-properties.ps1");
  try {
    writeFileSync(scriptPath, script, "utf8");
    const result = Bun.spawnSync(
      {
        cmd: [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          paths.join("\n"),
        ],
        stdout: "pipe",
        stderr: "pipe",
      },
      { windowsHide: true },
    );
    if (result.exitCode !== 0) {
      fail(`Reading MSI properties failed: ${new TextDecoder().decode(result.stderr).trim()}`);
    }
    const rows = JSON.parse(new TextDecoder().decode(result.stdout).trim()) as
      | { path: string; values: MsiProperties }[]
      | { path: string; values: MsiProperties };
    const list = Array.isArray(rows) ? rows : [rows];
    if (list.length !== paths.length) {
      fail(`Read properties for ${list.length} of ${paths.length} installers.`);
    }
    return new Map(list.map(row => [row.path, row.values]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function downloadReleaseAssets(tag: string, destination: string): Promise<Map<string, string>> {
  requireTool("gh", "Install the GitHub CLI to download published release assets.");
  const patterns = ARCHITECTURES.map(
    architecture => `Typsastra_${tag.replace(/^v/u, "")}_${architecture}_en-US.msi`,
  );
  const result = Bun.spawnSync(
    {
      cmd: [
        "gh",
        "release",
        "download",
        tag,
        ...patterns.flatMap(pattern => ["--pattern", pattern]),
        "--dir",
        destination,
        "--repo",
        REPOSITORY,
        "--clobber",
      ],
      stdout: "pipe",
      stderr: "pipe",
    },
    { windowsHide: true },
  );
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    fail(
      `Could not download ${patterns.join(", ")} from release ${tag}. ` +
        `Publish the release first. ${detail}`,
    );
  }
  const downloaded = new Map<string, string>();
  for (const pattern of patterns) {
    const path = join(destination, pattern);
    if (!existsSync(path)) fail(`Expected ${pattern} after download but it is missing.`);
    downloaded.set(pattern, path);
  }
  return downloaded;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function publishedDate(tag: string): string {
  requireTool("gh", "Install the GitHub CLI to read the release date.");
  const result = Bun.spawnSync(
    { cmd: ["gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "publishedAt", "-q", ".publishedAt"] },
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    fail(`Could not read the publication date for ${tag}; pass --release-date explicitly.`);
  }
  const value = new TextDecoder().decode(result.stdout).trim();
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value);
  if (!match) fail(`Could not parse a release date from ${JSON.stringify(value)}.`);
  return match[1];
}

function existingVersions(): string[] {
  if (!existsSync(MANIFEST_ROOT)) return [];
  return readdirSync(MANIFEST_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/u.test(entry.name))
    .map(entry => entry.name)
    .sort(compareVersions);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

interface InstallerEntry {
  architecture: string;
  fileName: string;
  url: string;
  sha256: string;
  productCode: string;
  upgradeCode: string;
}

function installerYaml(entries: InstallerEntry[], releaseDate: string): string {
  const lines = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${MANIFEST_VERSION}.schema.json`,
    "",
    `PackageIdentifier: ${PACKAGE_IDENTIFIER}`,
    `PackageVersion: ${VERSION}`,
    "Platform:",
    "  - Windows.Desktop",
    "InstallerType: wix",
    "Installers:",
  ];
  for (const entry of entries) {
    lines.push(
      `  - Architecture: ${entry.architecture}`,
      `    InstallerUrl: ${entry.url}`,
      `    InstallerSha256: ${entry.sha256}`,
      `    ProductCode: '${entry.productCode}'`,
      "    AppsAndFeaturesEntries:",
      `      - ProductCode: '${entry.productCode}'`,
      `        UpgradeCode: '${entry.upgradeCode}'`,
    );
  }
  lines.push(
    "InstallerSwitches:",
    "  Silent: /quiet",
    "  SilentWithProgress: /passive",
    // The MSI sets ALLUSERS=1, so winget validation needs elevation declared.
    "ElevationRequirement: elevationRequired",
    `ReleaseDate: ${releaseDate}`,
    "ManifestType: installer",
    `ManifestVersion: ${MANIFEST_VERSION}`,
    "",
  );
  return lines.join("\n");
}

function localeYaml(tag: string): string {
  const lines = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${MANIFEST_VERSION}.schema.json`,
    "",
    `PackageIdentifier: ${PACKAGE_IDENTIFIER}`,
    `PackageVersion: ${VERSION}`,
    "PackageLocale: en-US",
    `Publisher: ${LOCALE_METADATA.publisher}`,
    `PublisherUrl: ${LOCALE_METADATA.publisherUrl}`,
    `PublisherSupportUrl: ${LOCALE_METADATA.publisherSupportUrl}`,
    `PackageName: ${LOCALE_METADATA.packageName}`,
    `PackageUrl: ${LOCALE_METADATA.packageUrl}`,
    `License: ${LOCALE_METADATA.license}`,
    // Tag-pinned so the manifest resolves to the code that shipped.
    `LicenseUrl: ${HOMEPAGE}/blob/${tag}/LICENSE`,
    `ShortDescription: ${LOCALE_METADATA.shortDescription}`,
    `Moniker: ${LOCALE_METADATA.moniker}`,
    "Tags:",
    ...LOCALE_METADATA.tags.map(tagName => `  - ${tagName}`),
    `ReleaseNotesUrl: ${HOMEPAGE}/releases/tag/${tag}`,
    "Documentations:",
    ...LOCALE_METADATA.documentations.flatMap(entry => [
      `  - DocumentLabel: ${entry.label}`,
      `    DocumentUrl: ${HOMEPAGE}/blob/${tag}/${entry.path}`,
    ]),
    "ManifestType: defaultLocale",
    `ManifestVersion: ${MANIFEST_VERSION}`,
    "",
  ];
  return lines.join("\n");
}

function versionYaml(): string {
  return [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${MANIFEST_VERSION}.schema.json`,
    "",
    `PackageIdentifier: ${PACKAGE_IDENTIFIER}`,
    `PackageVersion: ${VERSION}`,
    "DefaultLocale: en-US",
    "ManifestType: version",
    `ManifestVersion: ${MANIFEST_VERSION}`,
    "",
  ].join("\n");
}

const readmeText = (tag: string) => `# Typsastra v${VERSION} winget manifest

Generated from published assets for ${tag} by
\`bun run generate:winget-manifest ${VERSION}\`. Do not copy metadata from a
previous release; regenerate it. SHA-256, ProductCode, and ReleaseDate come
from the published release. UpgradeCode is checked against both architectures
and the preceding checked-in version.

To submit, copy **only the three YAML files** to
\`manifests/t/Typsastra/Typsastra/${VERSION}/\` in winget-pkgs. Do not copy
this README or the PNG; icon metadata is populated during validation.
`;

let VERSION = "";

function checkManifestDrift(): void {
  const previous = existingVersions().filter(candidate => compareVersions(candidate, VERSION) < 0).pop();
  if (!previous) return;
  const localePath = join(MANIFEST_ROOT, previous, `${PACKAGE_IDENTIFIER}.locale.en-US.yaml`);
  if (!existsSync(localePath)) return;
  const previousLocale = readFileSync(localePath, "utf8");
  if (!previousLocale.includes(`ShortDescription: ${LOCALE_METADATA.shortDescription}`)) {
    console.warn(
      `warning: the ShortDescription in ${previous} differs from this script. ` +
        `Update LOCALE_METADATA if the change was intentional.`,
    );
  }
}

function checkPreviousUpgradeCode(upgradeCode: string): void {
  const previous = existingVersions().filter(candidate => compareVersions(candidate, VERSION) < 0).pop();
  if (!previous) return;
  const installerPath = join(MANIFEST_ROOT, previous, `${PACKAGE_IDENTIFIER}.installer.yaml`);
  if (!existsSync(installerPath)) fail(`Missing previous installer manifest: ${installerPath}`);
  const codes = [...readFileSync(installerPath, "utf8").matchAll(/^\s+UpgradeCode:\s*['"]?(\{[\dA-Fa-f-]+\})/gmu)]
    .map(match => match[1].toUpperCase());
  if (codes.length !== ARCHITECTURES.length || codes.some(code => code !== upgradeCode)) {
    fail(`UpgradeCode ${upgradeCode} does not match the ${previous} manifest. Investigate the MSI identity before submitting.`);
  }
}

function validateWithWinget(generated: { name: string; contents: string }[]): void {
  // Bun.which does not resolve Windows app-execution aliases consistently.
  // cmd.exe uses the same PATH lookup as a user running winget in a terminal.
  const available = Bun.spawnSync({ cmd: ["cmd.exe", "/d", "/c", "where winget"] });
  if (available.exitCode !== 0) {
    console.warn("warning: winget was not found; skipping manifest validation.");
    return;
  }
  // validate parses every file in the directory, so stage only the YAML files.
  const staging = mkdtempSync(join(tmpdir(), "typsastra-winget-validate-"));
  try {
    for (const file of generated) {
      writeFileSync(join(staging, file.name), file.contents, "utf8");
    }
    const result = Bun.spawnSync(
      { cmd: ["cmd.exe", "/d", "/c", "winget", "validate", "--manifest", staging] },
      { stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
    if (result.exitCode !== 0) {
      console.error(output.trim());
      fail("winget validate rejected the generated manifest.");
    }
    console.log("winget validate: Manifest validation succeeded.");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const options = parseArguments(process.argv.slice(2));
VERSION = options.version;
const tag = `v${VERSION}`;

if (process.platform !== "win32") {
  // The Property table is read through Windows Installer COM.
  fail("MSI property inspection requires Windows.");
}
const packageVersion = (JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8")) as {
  version: string;
}).version;
if (packageVersion !== VERSION) {
  console.warn(
    `warning: package.json is at ${packageVersion} but generating a manifest for ${VERSION}. ` +
      `Bump the version before tagging a release.`,
  );
}

const downloadDirectory = mkdtempSync(join(tmpdir(), "typsastra-winget-msi-"));
const outputDirectory = join(MANIFEST_ROOT, VERSION);

try {
  console.log(`Downloading ${tag} installers...`);
  const assets = await downloadReleaseAssets(tag, downloadDirectory);
  const paths = [...assets.values()];
  const properties = readMsiProperties(paths);
  const releaseDate = options.releaseDate ?? publishedDate(tag);

  const entries: InstallerEntry[] = [];
  for (const architecture of ARCHITECTURES) {
    const fileName = `Typsastra_${VERSION}_${architecture}_en-US.msi`;
    const path = assets.get(fileName);
    if (!path) continue;
    const msi = properties.get(path) ?? {};
    const productCode = msi.ProductCode?.toUpperCase();
    const upgradeCode = msi.UpgradeCode?.toUpperCase();
    if (!productCode || !upgradeCode) {
      fail(`${fileName} is missing ProductCode or UpgradeCode in its Property table.`);
    }
    if (msi.ProductName !== "Typsastra" || msi.Manufacturer?.toLowerCase() !== "typsastra") {
      fail(`${fileName} has an unexpected ProductName or Manufacturer.`);
    }
    if (msi.ProductVersion !== VERSION) {
      fail(`${fileName} reports ProductVersion ${msi.ProductVersion}, expected ${VERSION}.`);
    }
    if (msi.ALLUSERS !== "1") {
      fail(`${fileName} sets ALLUSERS=${msi.ALLUSERS ?? "<unset>"}; the manifest requires a per-machine MSI.`);
    }
    entries.push({
      architecture,
      fileName,
      url: `${HOMEPAGE}/releases/download/${tag}/${fileName}`,
      sha256: sha256(path),
      productCode,
      upgradeCode,
    });
  }

  // Both architectures must agree, or upgrades will not carry across them.
  const [reference, ...rest] = entries;
  for (const entry of rest) {
    if (entry.upgradeCode !== reference.upgradeCode) {
      fail(
        `UpgradeCode differs between ${reference.architecture} (${reference.upgradeCode}) and ` +
          `${entry.architecture} (${entry.upgradeCode}). Investigate before submitting.`,
      );
    }
  }
  checkPreviousUpgradeCode(reference.upgradeCode);

  checkManifestDrift();

  const generated = [
    { name: `${PACKAGE_IDENTIFIER}.yaml`, contents: versionYaml() },
    { name: `${PACKAGE_IDENTIFIER}.locale.en-US.yaml`, contents: localeYaml(tag) },
    { name: `${PACKAGE_IDENTIFIER}.installer.yaml`, contents: installerYaml(entries, releaseDate) },
  ];
  // Validate before modifying a checked-in version directory.
  validateWithWinget(generated);

  if (options.dryRun) {
    console.log("Would write:");
    for (const file of generated) {
      const existing = join(outputDirectory, file.name);
      const status = !existsSync(existing)
        ? "new"
        : readFileSync(existing, "utf8") === file.contents
          ? "unchanged"
          : "CHANGED";
      console.log(`  ${status.padEnd(9)} ${file.name}`);
    }
    console.log(`  ${existsSync(join(outputDirectory, `${PACKAGE_IDENTIFIER}.png`)) ? "unchanged" : "new"} ${PACKAGE_IDENTIFIER}.png`);
    console.log("\n--dry-run: nothing written.");
  } else {
    mkdirSync(outputDirectory, { recursive: true });
    for (const file of generated) writeFileSync(join(outputDirectory, file.name), file.contents, "utf8");
    writeFileSync(join(outputDirectory, `${PACKAGE_IDENTIFIER}.png`), readFileSync(ICON_SOURCE));
    writeFileSync(join(outputDirectory, "README.md"), readmeText(tag), "utf8");
  }

  console.log(`\n${VERSION}:`);
  for (const entry of entries) {
    console.log(`  ${entry.architecture.padEnd(6)} ${entry.sha256}  ${entry.productCode}`);
  }
  console.log(`  UpgradeCode ${reference.upgradeCode}`);
  console.log(`  ReleaseDate ${releaseDate}`);

} finally {
  rmSync(downloadDirectory, { recursive: true, force: true });
}
