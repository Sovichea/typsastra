export interface AppDialogAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface AppDialogOptions {
  title: string;
  subtitle?: string;
  description: string;
  actions: readonly AppDialogAction[];
  cancelAction: string;
}

export class AppDialogController {
  private readonly overlay = document.getElementById("app-dialog-overlay");
  private readonly title = document.getElementById("app-dialog-title");
  private readonly subtitle = document.getElementById("app-dialog-subtitle");
  private readonly description = document.getElementById("app-dialog-description");
  private readonly buttons = [
    document.getElementById("app-dialog-action-start") as HTMLButtonElement | null,
    document.getElementById("app-dialog-action-middle") as HTMLButtonElement | null,
    document.getElementById("app-dialog-action-end") as HTMLButtonElement | null
  ];
  private active = false;

  public show(options: AppDialogOptions): Promise<string> {
    if (!this.overlay || !this.title || !this.subtitle || !this.description || this.buttons.some(button => !button)) {
      return Promise.resolve(options.cancelAction);
    }
    if (this.active) return Promise.resolve(options.cancelAction);
    if (options.actions.length < 1 || options.actions.length > this.buttons.length) {
      throw new Error("Typsastra dialogs require between one and three actions.");
    }

    this.active = true;
    this.title.textContent = options.title;
    this.subtitle.textContent = options.subtitle ?? "";
    this.subtitle.hidden = !options.subtitle;
    this.description.textContent = options.description;

    const slots = dialogActionSlots(options.actions.length);
    for (let index = 0; index < this.buttons.length; index += 1) {
      const button = this.buttons[index]!;
      const actionIndex = slots.indexOf(index);
      const action = actionIndex >= 0 ? options.actions[actionIndex] : null;
      button.hidden = !action;
      button.textContent = action?.label ?? "";
      button.classList.toggle("settings-primary", Boolean(action?.primary));
      button.dataset.actionId = action?.id ?? "";
    }

    this.overlay.classList.remove("hidden");
    const primary = options.actions.find(action => action.primary) ?? options.actions[options.actions.length - 1]!;
    this.buttons.find(button => button?.dataset.actionId === primary.id)?.focus();

    return new Promise(resolve => {
      const finish = (action: string): void => {
        this.active = false;
        this.overlay!.classList.add("hidden");
        for (const button of this.buttons) button!.removeEventListener("click", click);
        this.overlay!.removeEventListener("click", backdrop);
        document.removeEventListener("keydown", keydown, true);
        resolve(action);
      };
      const click = (event: Event) => {
        const button = event.currentTarget as HTMLButtonElement;
        if (button.dataset.actionId) finish(button.dataset.actionId);
      };
      const backdrop = (event: Event) => {
        if (event.target === this.overlay) finish(options.cancelAction);
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        finish(options.cancelAction);
      };
      for (const button of this.buttons) button!.addEventListener("click", click);
      this.overlay!.addEventListener("click", backdrop);
      document.addEventListener("keydown", keydown, true);
    });
  }
}

export function dialogActionSlots(actionCount: number): number[] {
  if (actionCount <= 1) return [2];
  if (actionCount === 2) return [0, 2];
  return [0, 1, 2];
}
