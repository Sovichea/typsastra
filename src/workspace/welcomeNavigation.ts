export type WelcomeNavigationKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function welcomeNavigationIndex(
  currentIndex: number,
  itemCount: number,
  key: WelcomeNavigationKey
): number | null {
  if (itemCount <= 0) return null;
  const current = Math.max(0, Math.min(currentIndex, itemCount - 1));
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(current + 1, itemCount - 1);
  return Math.max(current - 1, 0);
}

export function installWelcomeKeyboardNavigation(container: HTMLElement): void {
  container.addEventListener("keydown", event => {
    if (!(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
    const focusedItem = (event.target as HTMLElement).closest<HTMLButtonElement>("button.welcome-item");
    if (!focusedItem) return;
    const items = [...container.querySelectorAll<HTMLButtonElement>("button.welcome-item:not(:disabled)")]
      .filter(item => item.getClientRects().length > 0);
    const currentIndex = items.indexOf(focusedItem);
    if (currentIndex < 0) return;
    const destination = welcomeNavigationIndex(currentIndex, items.length, event.key as WelcomeNavigationKey);
    if (destination === null) return;
    event.preventDefault();
    items[destination].focus();
  });
}
