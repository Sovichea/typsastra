import "./style.css";
import { TypsastraWorkspaceController } from "./appController";
import { applyRuntimeTitlebarClasses, resolveRuntimeTitlebar } from "./platform/runtimeTitlebar";
import { initializeLucideIcons } from "./ui/icons";

const viteEnvironment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
applyRuntimeTitlebarClasses(resolveRuntimeTitlebar({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  search: window.location.search,
  dev: viteEnvironment?.DEV === true,
}));

document.addEventListener("DOMContentLoaded", () => {
  initializeLucideIcons();
  void new TypsastraWorkspaceController().bootstrap();
});
