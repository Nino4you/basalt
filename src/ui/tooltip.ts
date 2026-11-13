import { h } from "./dom";

/**
 * One delegated tooltip for every element carrying `aria-label` plus a
 * tooltip-enabled class. Avoids per-element listeners and native `title` lag.
 */
export function installTooltips(): void {
  if (matchMedia("(hover: none)").matches) return;
  const tip = h("div", { class: "tooltip", attrs: { role: "tooltip" } });
  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warm = false;
  let cool: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    clearTimeout(timer);
    if (tip.isConnected) {
      tip.remove();
      // Moving between neighbouring icons shows the next tooltip immediately.
      warm = true;
      clearTimeout(cool);
      cool = setTimeout(() => (warm = false), 400);
    }
    target = null;
  };

  const show = (element: HTMLElement) => {
    const label = element.getAttribute("aria-label");
    if (!label || !element.isConnected) return;
    tip.textContent = label;
    const hotkey = element.dataset.hotkey;
    if (hotkey)
      tip.append(h("span", { class: "tooltip-hotkey", text: hotkey }));
    document.body.append(tip);
    const rect = element.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const side = element.dataset.tooltipPosition ?? "bottom";
    let left = rect.left + rect.width / 2 - box.width / 2;
    let top = rect.bottom + 8;
    if (side === "right") {
      left = rect.right + 8;
      top = rect.top + rect.height / 2 - box.height / 2;
    } else if (side === "top" || top + box.height > innerHeight - 4) {
      top = rect.top - box.height - 8;
    }
    tip.style.left = `${Math.max(6, Math.min(left, innerWidth - box.width - 6))}px`;
    tip.style.top = `${Math.max(6, top)}px`;
  };

  document.addEventListener("mouseover", (event) => {
    const element = (event.target as Element | null)?.closest<HTMLElement>(
      ".clickable-icon[aria-label], [data-tooltip][aria-label]",
    );
    if (element === target) return;
    hide();
    if (!element) return;
    target = element;
    timer = setTimeout(() => show(element), warm ? 0 : 450);
  });
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}
