import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifestRoot = join(root, "winget", "manifests", "t", "Typsastra", "Typsastra");

/**
 * Minimal YAML reader for the flat and one-level-list winget manifests.
 * Values are unquoted so GUIDs compare without their YAML quoting.
 */
function parseManifest(source: string): Map<string, string> {
  const unquote = (value: string) => value.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  const entries = new Map<string, string>();
  let listKey: string | null = null;
  let listItemKey: string | null = null;
  let listIndex = -1;
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (indent === 0) {
      listKey = null;
      listItemKey = null;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (value) entries.set(key, unquote(value));
      else listKey = key;
      continue;
    }
    if (listKey && line.startsWith("- ")) {
      listIndex += 1;
      listItemKey = `${listKey}.${listIndex}`;
      const item = line.slice(2).trim();
      const itemSeparator = item.indexOf(":");
      // A list item is usually the first field of a mapping, e.g. "- Key: value".
      if (itemSeparator > 0) {
        entries.set(`${listItemKey}.${item.slice(0, itemSeparator).trim()}`, unquote(item.slice(itemSeparator + 1).trim()));
      } else {
        entries.set(listItemKey, unquote(item));
      }
      continue;
    }
    // A nested mapping under a key, e.g. InstallerSwitches: { Silent: /quiet }.
    const scope = listItemKey ?? listKey;
    if (scope) {
      entries.set(`${scope}.${line.slice(0, separator).trim()}`, unquote(line.slice(separator + 1).trim()));
    }
  }
  return entries;
}

function manifestVersions(): string[] {
  return readdirSync(manifestRoot)
    .filter(entry => statSync(join(manifestRoot, entry)).isDirectory())
    .sort();
}

const versions = manifestVersions();

describe("winget manifests", () => {
  test("declares at least one published version", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  for (const version of versions) {
    describe(`${version}`, () => {
      const directory = join(manifestRoot, version);
      const versionFile = join(directory, "Typsastra.yaml");
      const localeFile = join(directory, "Typsastra.locale.en-US.yaml");
      const installerFile = join(directory, "Typsastra.installer.yaml");

      const versionManifest = parseManifest(readFileSync(versionFile, "utf8"));
      const localeManifest = parseManifest(readFileSync(localeFile, "utf8"));
      const installerManifest = parseManifest(readFileSync(installerFile, "utf8"));

      test("uses a manifest layout winget-pkgs accepts", () => {
        expect(versionManifest.get("PackageIdentifier")).toBe("Typsastra.Typsastra");
        expect(versionManifest.get("PackageVersion")).toBe(version);
        expect(versionManifest.get("DefaultLocale")).toBe("en-US");
        expect(versionManifest.get("ManifestType")).toBe("version");
        expect(localeManifest.get("PackageIdentifier")).toBe("Typsastra.Typsastra");
        expect(localeManifest.get("PackageLocale")).toBe("en-US");
        expect(localeManifest.get("ManifestType")).toBe("defaultLocale");
        expect(installerManifest.get("ManifestType")).toBe("installer");
        for (const manifest of [versionManifest, localeManifest, installerManifest]) {
          expect(manifest.get("PackageIdentifier")).toBe("Typsastra.Typsastra");
          expect(manifest.get("PackageVersion")).toBe(version);
          expect(manifest.get("ManifestVersion")).toMatch(/^\d+\.\d+\.\d+$/);
        }
      });

      test("path segments match the package identifier", () => {
        const segments = directory.split(/[\\/]/).filter(Boolean);
        // winget-pkgs stores manifests under manifests/<partition>/<identifier>/
        expect(segments).toContain("t");
        expect(segments).toContain("Typsastra");
        expect(segments[segments.length - 2]).toBe("Typsastra.Typsastra".split(".")[1]);
        expect(segments[segments.length - 3]).toBe("Typsastra.Typsastra".split(".")[0]);
      });

      test("declares the metadata winget requires", () => {
        expect(localeManifest.get("Publisher")).toBeTruthy();
        expect(localeManifest.get("PackageName")).toBeTruthy();
        expect(localeManifest.get("License")).toBeTruthy();
        const description = localeManifest.get("ShortDescription") ?? "";
        expect(description.length).toBeGreaterThanOrEqual(3);
        expect(description.length).toBeLessThanOrEqual(256);
        expect(description.toLocaleLowerCase()).not.toContain("installer");
      });

      test("links docs and license to the released tag rather than main", () => {
        for (const key of ["LicenseUrl", "ReleaseNotesUrl"]) {
          const value = localeManifest.get(key) ?? "";
          expect(value).toContain(`/v${version}`);
          expect(value).not.toContain("/main/");
        }
      });

      test("publishes x64 and arm64 installers from the official release", () => {
        expect(installerManifest.get("InstallerType")).toBe("wix");
        const architectures = ["x64", "arm64"];
        architectures.forEach((architecture, index) => {
          const prefix = `Installers.${index}`;
          expect(installerManifest.get(`${prefix}.Architecture`)).toBe(architecture);
          const url = installerManifest.get(`${prefix}.InstallerUrl`) ?? "";
          const hash = installerManifest.get(`${prefix}.InstallerSha256`) ?? "";
          expect(url).toBe(
            `https://github.com/Sovichea/typsastra/releases/download/v${version}/Typsastra_${version}_${architecture}_en-US.msi`,
          );
          expect(url).not.toContain("/releases/latest/");
          expect(hash).toMatch(/^[0-9a-f]{64}$/);
        });
        // winget requires silent and silent-with-progress support.
        expect(installerManifest.get("InstallerSwitches.Silent")).toBe("/quiet");
        expect(installerManifest.get("InstallerSwitches.SilentWithProgress")).toBe("/passive");
        // The MSI sets ALLUSERS=1, so winget validation needs elevation declared.
        expect(installerManifest.get("ElevationRequirement")).toBe("elevationRequired");
        expect(installerManifest.get("ReleaseDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      test("uses one UpgradeCode across architectures so upgrades switch arch", () => {
        const codes = ["Installers.0.UpgradeCode", "Installers.1.UpgradeCode"].map(
          key => installerManifest.get(key),
        );
        expect(codes[0]).toMatch(/^\{[0-9A-F-]{36}\}$/);
        expect(codes[1]).toBe(codes[0]);
        // ProductCode is per architecture and per build.
        const products = ["Installers.0.ProductCode", "Installers.1.ProductCode"].map(
          key => installerManifest.get(key),
        );
        for (const code of products) expect(code).toMatch(/^\{[0-9A-F-]{36}\}$/);
        expect(products[0]).not.toBe(products[1]);
      });

      test("ships a square package icon", () => {
        const icon = join(directory, "Typsastra.png");
        expect(existsSync(icon)).toBe(true);
        const header = readFileSync(icon).subarray(0, 24);
        expect(header.subarray(1, 4).toString()).toBe("PNG");
        expect(header.readUInt32BE(16)).toBe(header.readUInt32BE(20));
        expect(header.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
      });

      test("documents the required manifest maintenance", () => {
        const readme = readFileSync(join(directory, "README.md"), "utf8");
        expect(readme).toContain("winget-pkgs");
        expect(readme).toContain("InstallerSha256");
      });
    });
  }
});