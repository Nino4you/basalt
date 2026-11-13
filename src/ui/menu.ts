import { h, icon } from "./dom";

export interface MenuItem {
  title: string;
  icon?: string;
  hotkey?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick(): void;
}
export type MenuEntry = MenuItem | "separator" | null | undefined | false;

let openMenu: { close(): void } | null = null;

export function closeMenu(): void {
  openMenu?.close();
}

/** Context/dropdown menu, positioned at a point or below an anchor element. */
export function showMenu(
  entries: MenuEntry[],
  at: { x: number; y: number } | HTMLElement,
  options: { menuEl?: HTMLElement; onClose?(): void } = {},
): () => void {
  closeMenu();
  const previous = document.activeElement as HTMLElement | null;
  const menu = options.menuEl ?? h("div", "menu");
  const additions = [...menu.children];
  menu.setAttribute("role", "menu");
  menu.hidden = false;
  const scroller = h("div", "menu-scroll");
  menu.replaceChildren(scroller);
  const buttons: HTMLButtonElement[] = [];
  let lastWasSeparator = true;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "separator") {
      if (!lastWasSeparator) scroller.append(h("div", "menu-separator"));
      lastWasSeparator = true;
      continue;
    }
    lastWasSeparator = false;
    const button = h(
      "button",
      {
        class: `menu-item${entry.danger ? " is-warning" : ""}${entry.checked ? " is-checked" : ""}`,
        attrs: { type: "button", role: "menuitem", disabled: entry.disabled },
      },
      h("span", "menu-item-icon", entry.icon ? icon(entry.icon, 16) : null),
      h("span", { class: "menu-item-title", text: entry.title }),
      entry.hotkey
        ? h("span", { class: "menu-item-hotkey", text: entry.hotkey })
        : null,
      entry.checked ? h("span", "menu-item-check", icon("check", 16)) : null,
    );
    button.addEventListener("click", () => {
      close(false);
      entry.onClick();
    });
    buttons.push(button);
    scroller.append(button);
  }
  if (scroller.lastElementChild?.classList.contains("menu-separator"))
    scroller.lastElementChild.remove();
  if (additions.length) {
    if (buttons.length) scroller.append(h("div", "menu-separator"));
    for (const child of additions) {
      if (child instanceof HTMLButtonElement) {
        child.setAttribute("role", "menuitem");
        buttons.push(child);
      }
      scroller.append(child);
    }
  }
  if (scroller.lastElementChild?.classList.contains("menu-separator"))
    scroller.lastElementChild.remove();
  if (!buttons.length) {
    options.onClose?.();
    return () => {};
  }
  document.body.append(menu);

  const box = menu.getBoundingClientRect();
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const rect = at.getBoundingClientRect();
    x = rect.left;
    y = rect.bottom + 4;
    if (y + box.height > innerHeight - 8) y = rect.top - box.height - 4;
  } else {
    x = at.x;
    y = at.y;
    if (y + box.height > innerHeight - 8) y = y - box.height;
  }
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;

  const enabled = () => buttons.filter((button) => !button.disabled);
  const onKey = (event: KeyboardEvent) => {
    const list = enabled();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") close(true);
    else if (event.key === "ArrowDown")
      list[(index + 1) % list.length]?.focus();
    else if (event.key === "ArrowUp")
      list[(index - 1 + list.length) % list.length]?.focus();
    else if (event.key === "Tab") close(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointer = (event: Event) => {
    if (!menu.contains(event.target as Node)) close(false);
  };
  const onBlur = () => close(false);
  function close(restoreFocus: boolean) {
    if (openMenu !== handle) return;
    openMenu = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("contextmenu", onPointer, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onBlur);
    menu.remove();
    if (restoreFocus) previous?.focus?.();
    options.onClose?.();
  }
  const handle = { close: () => close(false) };
  openMenu = handle;
  document.addEventListener("keydown", onKey, true);
  // Deferred so the event that opened the menu cannot close it again.
  setTimeout(() => {
    if (openMenu !== handle) return;
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("contextmenu", onPointer, true);
  });
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onBlur);
  return handle.close;
}
