import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";

const COPY_FALLBACK_PREFIX = "TYPSASTRA_LARGE_ASSET_COPY_FALLBACK:";
const approvedCaches = new Set<string>();

type CopyFallbackNotice = {
  bytes: number;
  files: number;
  thresholdBytes: number;
};

type RenderPreparationOptions = Record<string, unknown> & {
  cacheRoot: string;
  allowLargeCopyFallback?: boolean;
};

export class RenderCacheCopyCancelled extends Error {
  constructor() {
    super("Preview cache copy was cancelled by the user.");
    this.name = "RenderCacheCopyCancelled";
  }
}

export async function prepareRenderProjectWithCopyGuard<T>(
  options: RenderPreparationOptions,
): Promise<T> {
  const cacheKey = options.cacheRoot.toLocaleLowerCase();
  const approved = approvedCaches.has(cacheKey);
  try {
    const result = await invoke<T>("prepare_render_project", {
      options: { ...options, allowLargeCopyFallback: approved },
    });
    notifyStorageUpdated();
    return result;
  } catch (error) {
    const notice = parseCopyFallbackNotice(error);
    if (!notice || approved) throw error;
    const accepted = await confirm(
      t`Typsastra cannot create hard links for ${notice.files.toLocaleString()} asset file${notice.files === 1 ? "" : "s"} (${formatBytes(notice.bytes)}). This usually means the project and Typsastra's machine-local cache are on different filesystems.\n\nContinuing will create real copies in the private application cache and consume additional disk space.`,
      {
        title: t("Copy Assets Into Preview Cache?"),
        kind: "warning",
        okLabel: t("Continue and Copy"),
        cancelLabel: t("Cancel"),
      },
    );
    if (!accepted) {
      throw new RenderCacheCopyCancelled();
    }
    approvedCaches.add(cacheKey);
    try {
      const result = await invoke<T>("prepare_render_project", {
        options: { ...options, allowLargeCopyFallback: true },
      });
      notifyStorageUpdated();
      return result;
    } finally {
      approvedCaches.delete(cacheKey);
    }
  }
}

function notifyStorageUpdated(): void {
  document.dispatchEvent(new CustomEvent("typsastra:render-cache-storage-updated"));
}

function parseCopyFallbackNotice(error: unknown): CopyFallbackNotice | null {
  const message = error instanceof Error ? error.message : String(error);
  const offset = message.indexOf(COPY_FALLBACK_PREFIX);
  if (offset < 0) return null;
  try {
    const value = JSON.parse(message.slice(offset + COPY_FALLBACK_PREFIX.length)) as Partial<CopyFallbackNotice>;
    if (!Number.isFinite(value.bytes) || !Number.isFinite(value.files)) return null;
    return {
      bytes: Number(value.bytes),
      files: Number(value.files),
      thresholdBytes: Number(value.thresholdBytes ?? 0),
    };
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
