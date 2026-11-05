import { getVersion } from "@tauri-apps/api/app";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { releaseSummaryForVersion, shouldShowReleaseSummary } from "../releaseNotes";
import { t } from "../i18n";

const RELEASE_SUMMARY_SEEN_KEY_PREFIX = "typsastra:release-summary-seen";
const RELEASE_SUMMARY_INSTALLED_KEY = "typsastra:release-summary-installed";

function hasStoredReleaseSummarySeenKey(): boolean {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${RELEASE_SUMMARY_SEEN_KEY_PREFIX}:`)) return true;
    }
  } catch {
    // Restricted WebView storage is treated as a fresh install.
  }
  return false;
}

export class ReleaseSummaryController {
  async showIfNeeded(): Promise<void> {
    const version = await getVersion().catch(() => null);
    if (!version) return;
    const seenKey = `${RELEASE_SUMMARY_SEEN_KEY_PREFIX}:${version}`;
    let previouslyInstalled = false;
    let lastSeenVersion: string | null = null;
    try {
      previouslyInstalled = window.localStorage.getItem(RELEASE_SUMMARY_INSTALLED_KEY) === "1"
        || hasStoredReleaseSummarySeenKey();
      lastSeenVersion = window.localStorage.getItem(seenKey) === "1" ? version : null;
    } catch {
      // A restricted WebView storage policy should not prevent application startup.
    }
    if (!shouldShowReleaseSummary(version, lastSeenVersion, previouslyInstalled)) {
      // A fresh install should start quietly. Remember both the application and
      // the current version so a later update can still show its summary.
      try {
        window.localStorage.setItem(RELEASE_SUMMARY_INSTALLED_KEY, "1");
        window.localStorage.setItem(seenKey, "1");
      } catch {
        // A restricted WebView storage policy should not prevent application startup.
      }
      return;
    }
    const summary = releaseSummaryForVersion(version);
    const overlay = document.getElementById("release-summary-overlay");
    const title = document.getElementById("release-summary-title");
    const subtitle = document.getElementById("release-summary-subtitle");
    const highlights = document.getElementById("release-summary-highlights");
    const closeButton = document.getElementById("release-summary-close") as HTMLButtonElement | null;
    const doneButton = document.getElementById("release-summary-done") as HTMLButtonElement | null;
    const detailsButton = document.getElementById("release-summary-details") as HTMLButtonElement | null;
    if (!summary || !overlay || !title || !subtitle || !highlights || !closeButton || !doneButton || !detailsButton) return;

    title.textContent = t`What's new in Typsastra ${summary.version}`;
    subtitle.textContent = summary.title;
    highlights.replaceChildren(...summary.highlights.map(highlight => {
      const item = document.createElement("li");
      item.textContent = highlight;
      return item;
    }));
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = () => {
      overlay.classList.add("hidden");
      document.removeEventListener("keydown", onKeydown);
      previouslyFocused?.focus();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
    };
    closeButton.onclick = close;
    doneButton.onclick = close;
    detailsButton.onclick = () => {
      void openUrl(summary.detailsUrl);
      close();
    };
    overlay.onmousedown = event => {
      if (event.target === overlay) close();
    };
    document.addEventListener("keydown", onKeydown);
    overlay.classList.remove("hidden");
    try {
      window.localStorage.setItem(RELEASE_SUMMARY_INSTALLED_KEY, "1");
      window.localStorage.setItem(seenKey, "1");
    } catch {
      // The summary may repeat when persistent WebView storage is unavailable.
    }
    doneButton.focus();
  }
}
