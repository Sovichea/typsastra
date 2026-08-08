import type { EditorView } from "@codemirror/view";
import type { StateEffect } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import { editorFontCompartment } from "./extensions";
import {
  codeEditorFontStack,
  configuredUnicodeEditorFamilies,
  detectUnicodeEditorFonts,
  SAME_AS_CODE_FONT,
  textEditorFontStack,
  unicodeEditorFonts,
  type CodeEditorFontId,
  type TextEditorFontPreference,
  type UnicodeFontPreference
} from "./fontCatalog";
import { editorFontTheme } from "./themes";

type UnicodeFontCandidate = typeof unicodeEditorFonts[number];
type SystemFontCatalog = { all: string[]; monospace: string[] };
type InstalledFont = { family: string };

const declinedStorageKey = "typsastra-declined-unicode-fonts";

export class EditorFontManager {
  private codeFont: CodeEditorFontId = "Fira Mono";
  private textFont: TextEditorFontPreference = SAME_AS_CODE_FONT;
  private textFontScale = 1.08;
  private unicodePreference: UnicodeFontPreference = "auto";
  private unicodePreferences: Record<string, UnicodeFontPreference> = {};
  private documentText = "";
  private documentUpdateTimer: number | null = null;
  private activeCandidates: UnicodeFontCandidate[] = [];
  private appliedStack = "";
  private appliedView: EditorView | undefined;
  private showSettingsAction = false;
  private dismissDeclines = false;
  private readonly systemFamilies = new Set<string>();
  private readonly breadcrumb = document.getElementById("editor-font-breadcrumb")!;
  private readonly text = document.getElementById("editor-font-breadcrumb-text")!;
  private readonly download = document.getElementById("editor-font-download") as HTMLButtonElement;
  private readonly dismiss = document.getElementById("editor-font-dismiss") as HTMLButtonElement;

  constructor(private readonly getEditorView: () => EditorView | undefined) {}

  public initialize(): void {
    this.download.addEventListener("click", () => {
      if (this.showSettingsAction) {
        document.dispatchEvent(new CustomEvent("typsastra:open-settings", { detail: { panel: "editor" } }));
      } else if (this.activeCandidates.length > 0) {
        void this.installAndApply(this.activeCandidates);
      }
    });
    this.dismiss.addEventListener("click", () => {
      if (this.dismissDeclines && this.activeCandidates.length > 0) {
        this.activeCandidates.forEach(candidate => this.markDeclined(candidate.id));
        this.renderDeclined();
      } else {
        this.hide();
      }
    });
    void this.refreshSystemFonts();
  }

  public configure(
    codeFont: CodeEditorFontId,
    textFont: TextEditorFontPreference,
    textFontScale: number,
    unicodeFont: UnicodeFontPreference,
    unicodeFonts: Record<string, UnicodeFontPreference> = {}
  ): void {
    this.codeFont = codeFont;
    this.textFont = textFont;
    this.textFontScale = textFontScale;
    this.unicodePreference = unicodeFont;
    this.unicodePreferences = unicodeFonts;
    this.refresh();
  }

  public async ready(): Promise<void> {
    const families = [
      this.codeFont,
      ...(this.textFont === SAME_AS_CODE_FONT ? [] : [this.textFont]),
      ...this.configuredFamilies()
    ];
  
    await Promise.allSettled(
      families
        .filter(family => family !== "auto" && family !== "none")
        .map(family => document.fonts.load(`16px "${family}"`))
    );
  }

  public updateDocument(text: string): void {
    const effect = this.prepareDocument(text);
    if (effect) this.getEditorView()?.dispatch({ effects: effect });
  }

  public prepareDocument(text: string): StateEffect<unknown> | null {
    if (this.documentUpdateTimer !== null) {
      window.clearTimeout(this.documentUpdateTimer);
      this.documentUpdateTimer = null;
    }
    this.documentText = text;
    return this.refresh(false);
  }

  public scheduleDocumentUpdate(text: string, delay = 160): void {
    this.documentText = text;
    if (this.documentUpdateTimer !== null) window.clearTimeout(this.documentUpdateTimer);
    this.documentUpdateTimer = window.setTimeout(() => {
      this.documentUpdateTimer = null;
      this.refresh();
    }, delay);
  }

  private async refreshSystemFonts(): Promise<void> {
    try {
      const catalog = await invoke<SystemFontCatalog>("list_system_fonts");
      this.systemFamilies.clear();
      catalog.all.forEach(family => this.systemFamilies.add(family.toLocaleLowerCase()));
      this.refresh();
    } catch (error) {
      console.warn("Failed to enumerate system fonts.", error);
    }
  }

  private refresh(dispatchEffect = true): StateEffect<unknown> | null {
    const detected = detectUnicodeEditorFonts(this.documentText);
    const missing: UnicodeFontCandidate[] = [];
    for (const candidate of detected) {
      const preference = this.unicodePreferences[candidate.id] ?? this.unicodePreference;
      if (preference === "none") continue;
      const family = preference === "auto" ? candidate.fontFamily : preference;
      if (preference === "auto" && !candidate.bundled && !this.systemFamilies.has(family.toLocaleLowerCase())) {
        missing.push(candidate);
      }
    }
    const effect = this.applyStack(this.configuredFamilies(), dispatchEffect);
    this.activeCandidates = missing;
    if (missing.length === 0) {
      this.hide();
      return effect;
    }
    const declined = this.declinedIds();
    this.activeCandidates = missing.filter(candidate => !declined.has(candidate.id));
    if (this.activeCandidates.length === 0) {
      this.hide();
      return effect;
    }
    this.renderPrompt(this.activeCandidates);
    return effect;
  }

  private renderPrompt(candidates: UnicodeFontCandidate[]): void {
    this.showSettingsAction = false;
    this.dismissDeclines = true;
    const languages = candidates.map(candidate => candidate.language).join(", ");
    this.text.textContent = `${languages} text detected. Install ${candidates.length === 1 ? candidates[0].label : `${candidates.length} recommended fallback fonts`} for consistent Unicode rendering?`;
    this.download.textContent = candidates.length === 1 ? `Install ${candidates[0].label}` : "Install recommended fonts";
    this.download.disabled = false;
    this.download.classList.remove("hidden");
    this.dismiss.textContent = "Not now";
    this.dismiss.setAttribute("aria-label", "Do not suggest this font again");
    this.breadcrumb.classList.remove("hidden");
  }

  private renderDeclined(): void {
    this.showSettingsAction = true;
    this.dismissDeclines = false;
    this.text.textContent = "No font was downloaded. You can choose any installed Unicode fallback in Settings.";
    this.download.textContent = "Open Settings";
    this.download.disabled = false;
    this.download.classList.remove("hidden");
    this.dismiss.textContent = "Close";
    this.dismiss.setAttribute("aria-label", "Close font notice");
  }

  private renderDownloading(candidates: UnicodeFontCandidate[]): void {
    this.showSettingsAction = false;
    this.dismissDeclines = false;
    this.text.textContent = `Downloading and installing ${candidates.length === 1 ? candidates[0].label : `${candidates.length} fallback fonts`} for the current user...`;
    this.download.classList.add("hidden");
    this.dismiss.classList.add("hidden");
    this.breadcrumb.classList.remove("hidden");
  }

  private renderApplied(candidates: UnicodeFontCandidate[]): void {
    this.showSettingsAction = false;
    this.dismissDeclines = false;
    this.text.textContent = `${candidates.length === 1 ? candidates[0].label : `${candidates.length} fallback fonts`} ${candidates.length === 1 ? "was" : "were"} installed and selected automatically.`;
    this.download.classList.add("hidden");
    this.dismiss.textContent = "Close";
    this.dismiss.setAttribute("aria-label", "Close font notice");
    this.dismiss.classList.remove("hidden");
    this.breadcrumb.classList.remove("hidden");
  }

  private hide(): void {
    this.breadcrumb.classList.add("hidden");
    this.dismiss.classList.remove("hidden");
  }

  private declinedIds(): Set<string> {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(declinedStorageKey) || "[]");
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set();
    }
  }

  private markDeclined(id: string): void {
    const declined = this.declinedIds();
    declined.add(id);
    localStorage.setItem(declinedStorageKey, JSON.stringify([...declined]));
  }

  private async installAndApply(candidates: UnicodeFontCandidate[]): Promise<void> {
    if (candidates.some(candidate => !this.activeCandidates.some(active => active.id === candidate.id))) return;
    this.renderDownloading(candidates);
    try {
      for (const candidate of candidates) {
        const installed = await invoke<InstalledFont>("install_unicode_font", { fontId: candidate.id });
        this.systemFamilies.add(installed.family.toLocaleLowerCase());
        await document.fonts.load(`16px "${installed.family}"`);
      }
      if (candidates.some(candidate => !this.activeCandidates.some(active => active.id === candidate.id))) return;
      this.applyStack(this.configuredFamilies());
      this.renderApplied(candidates);
      document.dispatchEvent(new Event("typsastra:system-fonts-changed"));
    } catch (error) {
      this.showSettingsAction = false;
      this.dismissDeclines = false;
      this.text.textContent = `Could not install the recommended fallback fonts: ${String(error)}`;
      this.download.textContent = "Retry";
      this.download.disabled = false;
      this.download.classList.remove("hidden");
      this.dismiss.textContent = "Close";
      this.dismiss.classList.remove("hidden");
      this.breadcrumb.classList.remove("hidden");
    }
  }

  private applyStack(
    unicodeFamilies: readonly string[] = [],
    dispatchEffect = true
  ): StateEffect<unknown> | null {
    const stack = codeEditorFontStack(this.codeFont, unicodeFamilies);
    const textStack = textEditorFontStack(this.textFont, this.codeFont, unicodeFamilies);
    const effectiveTextScale = this.textFont === SAME_AS_CODE_FONT ? 1 : this.textFontScale;
    const stackKey = `${stack}\n${textStack}\n${effectiveTextScale}`;
    const uiStack = [...new Set(["MiSans Latin", ...unicodeFamilies])]
      .map(family => `"${family.replace(/"/g, '\\"')}"`)
      .join(", ");
    document.documentElement.style.setProperty("--ui-font", uiStack);
    document.documentElement.style.setProperty("--editor-code-font", stack);
    document.documentElement.style.setProperty("--editor-text-font", textStack);
    document.documentElement.style.setProperty("--editor-text-size", `${effectiveTextScale}em`);
    document.documentElement.style.setProperty("--editor-unicode-font", unicodeFamilies.length > 0 ? uiStack : "sans-serif");
    const view = this.getEditorView();
    // A caller requesting an effect is about to replace the complete
    // EditorState. The replacement reinstalls the compartment's default font,
    // even when the configured stack itself has not changed, so it must always
    // receive a fresh reconfiguration effect.
    if (dispatchEffect && this.appliedStack === stackKey && this.appliedView === view) return null;
    this.appliedStack = stackKey;
    const effect = editorFontCompartment.reconfigure(editorFontTheme(stack, textStack));
    if (dispatchEffect && view) {
      view.dispatch({ effects: effect });
      this.appliedView = view;
    }
    return effect;
  }

  private configuredFamilies(): string[] {
    return configuredUnicodeEditorFamilies(this.unicodePreference, this.unicodePreferences);
  }
}
