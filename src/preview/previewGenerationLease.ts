import { invoke } from "@tauri-apps/api/core";

let sessionReady: Promise<void> | null = null;
export function initializePreviewGenerationSession(): Promise<void> {
  return sessionReady ??= invoke<void>("reset_preview_generation_readers");
}

export async function retainPreviewGeneration(path: string, handoff = false): Promise<number | null> {
  if (!/[\\/]preview[\\/]generations[\\/][^\\/]+\.pdf$/i.test(path)) return null;
  await initializePreviewGenerationSession();
  return invoke<number | null>("retain_preview_generation", { path, handoff });
}

export async function releasePreviewGeneration(leaseId: number | null | undefined): Promise<void> {
  if (leaseId == null) return;
  await invoke("release_preview_generation", { leaseId });
}

/** Retain before emitting: the receiving window may process the event later. */
export async function publishPdfUpdate<T extends { path: string }>(update: T): Promise<void> {
  const lease = await retainPreviewGeneration(update.path, true);
  // Managed generations return no handoff lease when the preview window is closed.
  if (lease == null && /[\\/]preview[\\/]generations[\\/]/i.test(update.path)) return;
  try {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("preview", "pdf-update", { ...update, generationLease: lease });
  } catch (error) {
    await releasePreviewGeneration(lease);
    throw error;
  }
}
