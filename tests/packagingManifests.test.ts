import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderPackagingFiles, type Release } from "../scripts/generate-packaging";

const root = resolve(import.meta.dir, "..");
const packagingRoot = join(root, "packaging");
const packageJson = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
  scripts?: Record<string, string>;
};
const chocolateyRoot = join(packagingRoot, "chocolatey");
const scoopRoot = join(packagingRoot, "scoop");
const aurRoot = join(packagingRoot, "aur");

const nuspecPath = join(chocolateyRoot, "typsastra.nuspec");
const installPath = join(chocolateyRoot, "tools", "chocolateyinstall.ps1");
const uninstallPath = join(chocolateyRoot, "tools", "chocolateyuninstall.ps1");
const verificationPath = join(chocolateyRoot, "tools", "VERIFICATION.txt");
const scoopPath = join(scoopRoot, "typsastra.json");
const pkgbuildPath = join(aurRoot, "PKGBUILD");
const srcinfoPath = join(aurRoot, ".SRCINFO");

const nuspec = readFileSync(nuspecPath, "utf8");
const version = /<version>([^<]+)<\/version>/u.exec(nuspec)?.[1] ?? "";
const tag = `v${version}`;
const installScript = readFileSync(installPath, "utf8");
const uninstallScript = readFileSync(uninstallPath, "utf8");
const verification = readFileSync(verificationPath, "utf8");
const scoop = (await Bun.file(scoopPath).json()) as {
  version: string;
  description: string;
  homepage: string;
  notes: string;
  license: { identifier: string; url: string };
  architecture: Record<string, { url: string; hash: string }>;
  installer: { script: string[] };
  bin: string;
  shortcuts: string[][];
  checkver: { github: string };
  autoupdate: {
    architecture: Record<string, { url: string; hash: { url: string; jsonpath: string } }>;
  };
};
const pkgbuild = readFileSync(pkgbuildPath, "utf8");
const srcinfo = readFileSync(srcinfoPath, "utf8");

function xmlValue(source: string, tagName: string): string | undefined {
  return new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "u").exec(source)?.[1];
}

function bashValue(source: string, name: string): string | undefined {
  const match = new RegExp(`^${name}=(.*)$`, "mu").exec(source);
  return match?.[1].trim().replace(/^['"]|['"]$/gu, "");
}

function bashArray(source: string, name: string): string[] {
  const match = new RegExp(`^${name}=\\(([^)]*)\\)$`, "mu").exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]*)['"]/gu)].map(item => item[1]);
}

function parseSrcinfo(source: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const rawLine of source.split(/\r?\n/u)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/u.exec(rawLine);
    if (!match) continue;
    const [, key, value] = match;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}

const srcinfoValues = parseSrcinfo(srcinfo);
const msiX64 = `Typsastra_${version}_x64_en-US.msi`;
const msiArm64 = `Typsastra_${version}_arm64_en-US.msi`;
const debAmd64 = `Typsastra_${version}_amd64.deb`;
const debArm64 = `Typsastra_${version}_arm64.deb`;
const x64Url = `https://github.com/Sovichea/typsastra/releases/download/${tag}/${msiX64}`;
const arm64Url = `https://github.com/Sovichea/typsastra/releases/download/${tag}/${msiArm64}`;
const debAmd64Url = `https://github.com/Sovichea/typsastra/releases/download/${tag}/${debAmd64}`;
const debArm64Url = `https://github.com/Sovichea/typsastra/releases/download/${tag}/${debArm64}`;

const checksumMatch = /if \(\$isArm64\) \{ '([0-9a-f]{64})' \} else \{ '([0-9a-f]{64})' \}/u.exec(
  installScript,
);
const arm64Hash = checksumMatch?.[1] ?? "";
const x64Hash = checksumMatch?.[2] ?? "";
const installHashes = [x64Hash, arm64Hash];
const scoopHashes = [scoop.architecture["64bit"].hash, scoop.architecture.arm64.hash];
const aurHashes = [
  ...bashArray(pkgbuild, "sha256sums_x86_64"),
  ...bashArray(pkgbuild, "sha256sums_aarch64"),
];

describe("packaging metadata", () => {
  test("ships Chocolatey, Scoop, and AUR files for the checked-in version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    for (const path of [
      nuspecPath,
      installPath,
      uninstallPath,
      verificationPath,
      scoopPath,
      pkgbuildPath,
      srcinfoPath,
    ]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
    expect(nuspec).toContain(`<version>${version}</version>`);
    expect(scoop.version).toBe(version);
    expect(bashValue(pkgbuild, "pkgver")).toBe(version);
    expect(srcinfoValues.get("pkgver")).toEqual([version]);
    expect(packageJson.scripts?.["generate:packaging"]).toBe("bun scripts/generate-packaging.ts");
  });

  test("Chocolatey nuspec declares the package identity and release links", () => {
    expect(xmlValue(nuspec, "id")).toBe("typsastra");
    expect(xmlValue(nuspec, "title")).toBe("Typsastra");
    expect(xmlValue(nuspec, "authors")).toBe("Typsastra");
    expect(xmlValue(nuspec, "projectUrl")).toBe("https://github.com/Sovichea/typsastra");
    expect(xmlValue(nuspec, "packageSourceUrl")).toContain("/packaging/chocolatey");
    expect(xmlValue(nuspec, "docsUrl")).toBe("https://docs.typsastra.com/");
    expect(xmlValue(nuspec, "licenseUrl")).toContain(`/blob/${tag}/LICENSE`);
    expect(xmlValue(nuspec, "licenseUrl")).not.toContain("/main/");
    expect(xmlValue(nuspec, "iconUrl")).toContain(`/${tag}/src-tauri/icons/128x128.png`);
    expect(xmlValue(nuspec, "tags")).toBe("typst editor typesetting latex preview tinymist");
    expect(nuspec).toContain('<file src="tools\\**" target="tools" />');
    expect(nuspec.endsWith("\n")).toBe(true);
  });

  test("Chocolatey install script selects the native MSI and verifies its hash", () => {
    expect(installScript).toContain("Is64BitOperatingSystem");
    expect(installScript).toContain("PROCESSOR_ARCHITECTURE");
    expect(installScript).toContain("PROCESSOR_ARCHITEW6432");
    expect(installScript).toContain(x64Url);
    expect(installScript).toContain(arm64Url);
    expect(installScript).toContain("fileType       = 'msi'");
    expect(installScript).toContain("url64bit       = $url");
    expect(installScript).toContain("checksumType64 = 'sha256'");
    expect(installScript).toContain("silentArgs     = '/quiet /norestart'");
    expect(installScript).toContain("validExitCodes = @(0, 3010, 1641)");
    expect(installScript).toContain("softwareName   = 'Typsastra'");
    expect(installScript).toContain("Install-ChocolateyPackage @packageArgs");
    expect(installHashes).toHaveLength(2);
    for (const hash of installHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("Chocolatey uninstall script removes the registered MSI product", () => {
    expect(uninstallScript).toContain("Get-UninstallRegistryKey -SoftwareName 'Typsastra'");
    expect(uninstallScript).toContain("PSChildName");
    expect(uninstallScript).toContain("msiexec.exe");
    expect(uninstallScript).toContain("'/x', $productCode, '/qn', '/norestart'");
    expect(uninstallScript).toContain("@(0, 3010, 1641)");
  });

  test("Chocolatey verification file records both official installers", () => {
    expect(verification).toContain("VERIFICATION");
    expect(verification).toContain(x64Url);
    expect(verification).toContain(arm64Url);
    expect(verification).toContain(installHashes[0]);
    expect(verification).toContain(installHashes[1]);
  });

  test("Scoop manifest extracts the MSI and tracks future releases", () => {
    expect(scoop.description).toContain("Typst editor");
    expect(scoop.homepage).toBe("https://github.com/Sovichea/typsastra");
    expect(scoop.notes).toContain("WebView2");
    expect(scoop.license.identifier).toBe("MIT");
    expect(scoop.license.url).toContain(`/blob/${tag}/LICENSE`);
    expect(scoop.architecture["64bit"]).toEqual({ url: x64Url, hash: installHashes[0] });
    expect(scoop.architecture.arm64).toEqual({ url: arm64Url, hash: installHashes[1] });
    expect(scoop.installer.script.join("\n")).toContain("Expand-MsiArchive");
    expect(scoop.installer.script.join("\n")).toContain("-ExtractDir 'PFiles\\Typsastra'");
    expect(scoop.installer.script.join("\n")).toContain('Remove-Item "$dir\\$fname" -Force');
    expect(scoop.bin).toBe("typsastra.exe");
    expect(scoop.shortcuts).toEqual([["typsastra.exe", "Typsastra"]]);
    expect(scoop.checkver.github).toBe("https://github.com/Sovichea/typsastra");
    expect(scoop.autoupdate.architecture["64bit"].url).toBe(
      "https://github.com/Sovichea/typsastra/releases/download/v$version/Typsastra_$version_x64_en-US.msi",
    );
    expect(scoop.autoupdate.architecture.arm64.url).toBe(
      "https://github.com/Sovichea/typsastra/releases/download/v$version/Typsastra_$version_arm64_en-US.msi",
    );
    expect(scoop.autoupdate.architecture["64bit"].hash.jsonpath).toContain(
      "Typsastra_$version_x64_en-US.msi",
    );
    expect(scoop.autoupdate.architecture["64bit"].hash.jsonpath).toContain(".digest");
  });

  test("AUR PKGBUILD packages the Debian assets for both architectures", () => {
    expect(pkgbuild.endsWith("\n")).toBe(true);
    expect(bashValue(pkgbuild, "pkgname")).toBe("typsastra-bin");
    expect(bashValue(pkgbuild, "pkgrel")).toBe("1");
    expect(bashValue(pkgbuild, "pkgdesc")).toContain("Typst editor");
    expect(bashValue(pkgbuild, "pkgdesc")).not.toEndWith(".");
    expect(bashValue(pkgbuild, "url")).toBe("https://github.com/Sovichea/typsastra");
    expect(bashArray(pkgbuild, "arch")).toEqual(["x86_64", "aarch64"]);
    expect(bashArray(pkgbuild, "license")).toEqual(["MIT"]);
    expect(bashArray(pkgbuild, "depends")).toEqual(["gtk3", "webkit2gtk-4.1", "xdg-utils"]);
    expect(bashArray(pkgbuild, "provides")).toEqual(["typsastra"]);
    expect(bashArray(pkgbuild, "conflicts")).toEqual(["typsastra"]);
    expect(bashArray(pkgbuild, "options")).toEqual(["!strip", "!debug"]);
    expect(bashArray(pkgbuild, "source_x86_64")).toEqual([debAmd64Url]);
    expect(bashArray(pkgbuild, "source_aarch64")).toEqual([debArm64Url]);
    expect(bashArray(pkgbuild, "noextract")).toEqual([debAmd64, debArm64]);
    expect(aurHashes).toHaveLength(2);
    for (const hash of aurHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(pkgbuild).toContain('case "$CARCH" in');
    expect(pkgbuild).toContain("x86_64) deb=");
    expect(pkgbuild).toContain("aarch64) deb=");
    expect(pkgbuild).toContain('bsdtar -xOf "$srcdir/$deb" data.tar.*');
    expect(pkgbuild).toContain('bsdtar -xf - -C "$pkgdir"');
  });

  test("AUR .SRCINFO mirrors the PKGBUILD metadata", () => {
    expect(srcinfo.startsWith("pkgbase = typsastra-bin\n\tpkgdesc = ")).toBe(true);
    expect(srcinfo.endsWith("\n")).toBe(true);
    expect(srcinfoValues.get("pkgbase")).toEqual(["typsastra-bin"]);
    expect(srcinfoValues.get("pkgdesc")).toEqual([bashValue(pkgbuild, "pkgdesc")]);
    expect(srcinfoValues.get("pkgrel")).toEqual(["1"]);
    expect(srcinfoValues.get("url")).toEqual([bashValue(pkgbuild, "url")]);
    expect(srcinfoValues.get("arch")).toEqual(bashArray(pkgbuild, "arch"));
    expect(srcinfoValues.get("license")).toEqual(bashArray(pkgbuild, "license"));
    expect(srcinfoValues.get("depends")).toEqual(bashArray(pkgbuild, "depends"));
    expect(srcinfoValues.get("provides")).toEqual(bashArray(pkgbuild, "provides"));
    expect(srcinfoValues.get("conflicts")).toEqual(bashArray(pkgbuild, "conflicts"));
    expect(srcinfoValues.get("options")).toEqual(bashArray(pkgbuild, "options"));
    expect(srcinfoValues.get("source_x86_64")).toEqual(bashArray(pkgbuild, "source_x86_64"));
    expect(srcinfoValues.get("source_aarch64")).toEqual(bashArray(pkgbuild, "source_aarch64"));
    expect(srcinfoValues.get("noextract")).toEqual(bashArray(pkgbuild, "noextract"));
    expect(srcinfoValues.get("sha256sums_x86_64")).toEqual(
      bashArray(pkgbuild, "sha256sums_x86_64"),
    );
    expect(srcinfoValues.get("sha256sums_aarch64")).toEqual(
      bashArray(pkgbuild, "sha256sums_aarch64"),
    );
    expect(srcinfoValues.get("pkgname")).toEqual(["typsastra-bin"]);
  });

  test("all package URLs are pinned to the release tag", () => {
    const urls = [
      ...installScript.matchAll(/'(https:\/\/[^']+)'/gu),
      ...pkgbuild.matchAll(/'?(https:\/\/[^'\s)]+)'?/gu),
      scoop.architecture["64bit"].url,
      scoop.architecture.arm64.url,
      scoop.license.url,
    ]
      .map(match => (typeof match === "string" ? match : match[1]))
      .filter((url): url is string => typeof url === "string" && url.startsWith("https://"));
    for (const url of urls) {
      expect(url).not.toContain("/releases/latest/");
      expect(url).not.toContain("/blob/main/");
    }
    for (const url of [x64Url, arm64Url, debAmd64Url, debArm64Url]) {
      expect(url).toContain(`/download/${tag}/`);
    }
  });

  test("Scoop and AUR checksums agree with the Chocolatey MSI hashes", () => {
    expect(scoopHashes).toEqual(installHashes);
    expect(new Set(aurHashes).size).toBe(2);
    for (const hash of aurHashes) expect(installHashes).not.toContain(hash);
  });

  test("the generator renders a complete set of files for a synthetic release", () => {
    const syntheticVersion = "9.8.7";
    const names = [
      `Typsastra_${syntheticVersion}_x64_en-US.msi`,
      `Typsastra_${syntheticVersion}_arm64_en-US.msi`,
      `Typsastra_${syntheticVersion}_amd64.deb`,
      `Typsastra_${syntheticVersion}_arm64.deb`,
    ];
    const release: Release = {
      version: syntheticVersion,
      tag: `v${syntheticVersion}`,
      assets: new Map(
        names.map((name, index) => [
          name,
          {
            name,
            url: `https://example.test/${name}`,
            digest: `sha256:${String(index + 1)
              .repeat(64)
              .slice(0, 64)}`,
          },
        ]),
      ),
    };
    const files = renderPackagingFiles(release);
    expect(files).toHaveLength(7);
    for (const file of files) {
      expect(file.path.startsWith(packagingRoot)).toBe(true);
      if (!file.path.endsWith("chocolateyuninstall.ps1")) {
        expect(file.contents).toContain(syntheticVersion);
      }
      expect(file.contents).not.toContain("undefined");
      expect(file.contents).not.toContain("{{");
    }
    expect(files.some(file => file.path.endsWith(".SRCINFO"))).toBe(true);
    expect(files.some(file => file.path.endsWith("VERIFICATION.txt"))).toBe(true);
  });

  test("the generator rejects a release without a SHA-256 digest", () => {
    const release: Release = {
      version: "1.2.3",
      tag: "v1.2.3",
      assets: new Map([
        [
          "Typsastra_1.2.3_x64_en-US.msi",
          { name: "Typsastra_1.2.3_x64_en-US.msi", url: "https://example.test/x64.msi", digest: "" },
        ],
      ]),
    };
    expect(() => renderPackagingFiles(release)).toThrow("missing");
  });

  test("Chocolatey packs the nuspec when choco is available", () => {
    if (!Bun.which("choco")) return;
    const output = mkdtempSync(join(tmpdir(), "typsastra-choco-"));
    try {
      const result = Bun.spawnSync({
        cmd: ["choco", "pack", nuspecPath, "--output-directory", output],
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(output, `typsastra.${version}.nupkg`))).toBe(true);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("Chocolatey PowerShell scripts parse when Windows PowerShell is available", () => {
    if (process.platform !== "win32") return;
    const powershell = Bun.which("powershell.exe") ?? Bun.which("powershell");
    if (!powershell) return;
    for (const path of [installPath, uninstallPath]) {
      const escaped = path.replace(/'/gu, "''");
      const command =
        `$tokens = $null; $errors = $null; ` +
        `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null; ` +
        `if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`;
      const result = Bun.spawnSync({
        cmd: [powershell, "-NoProfile", "-NonInteractive", "-Command", command],
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      expect(result.exitCode).toBe(0);
    }
  });

  test("the AUR PKGBUILD parses as Bash", () => {
    if (process.platform === "win32") return;
    const bash = Bun.which("bash");
    if (!bash) return;
    const result = Bun.spawnSync({
      cmd: [bash, "-n", pkgbuildPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  });
});
