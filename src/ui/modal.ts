import { t } from "../i18n";
import { h, icon } from "./dom";

const stack: Modal[] = [];

export function topModal(): Modal | null {
  return stack[stack.length - 1] ?? null;
}

/** Uses the same DOM vocabulary as the plugin `Modal`, so both share one stylesheet. */
export class Modal {
  readonly containerEl: HTMLElement;
  readonly bgEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly closeButton: HTMLButtonElement;
  onClose: (() => void) | null = null;
  private previousFocus: HTMLElement | null = null;
  private opened = false;

  constructor(extraClass = "") {
    this.bgEl = h("div", "modal-bg");
    this.closeButton = h(
      "button",
      {
        class: "modal-close-button",
        label: t("Schließen"),
        attrs: { type: "button" },
      },
      icon("x", 16),
    );
    this.titleEl = h("div", "modal-title");
    this.contentEl = h("div", "modal-content");
    this.modalEl = h(
      "div",
      {
        class: `modal${extraClass ? ` ${extraClass}` : ""}`,
        attrs: { role: "dialog", "aria-modal": "true" },
      },
      this.closeButton,
      this.titleEl,
      this.contentEl,
    );
    this.containerEl = h("div", "modal-container", this.bgEl, this.modalEl);
    this.bgEl.addEventListener("click", () => this.close());
    this.closeButton.addEventListener("click", () => this.close());
    this.containerEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === "Tab") this.trapFocus(event);
    });
  }

  get isOpen(): boolean {
    return this.opened;
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    this.modalEl.setAttribute("aria-label", title);
    return this;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.previousFocus = document.activeElement as HTMLElement | null;
    document.body.append(this.containerEl);
    stack.push(this);
    const focusTarget =
      this.modalEl.querySelector<HTMLElement>("[autofocus]") ??
      this.modalEl.querySelector<HTMLElement>(
        "input, textarea, select, .modal-content button",
      ) ??
      this.closeButton;
    focusTarget.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    const index = stack.indexOf(this);
    if (index >= 0) stack.splice(index, 1);
    // Hand focus back only if it is still ours; the action that closed the
    // modal may already have moved it (e.g. into the editor).
    const owned =
      this.containerEl.contains(document.activeElement) ||
      document.activeElement === document.body;
    this.containerEl.remove();
    this.onClose?.();
    if (owned && this.previousFocus?.isConnected) this.previousFocus.focus();
  }

  private trapFocus(event: KeyboardEvent): void {
    const focusable = [
      ...this.modalEl.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (element) =>
        !(element as HTMLButtonElement).disabled && element.offsetParent,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

export interface Suggestion {
  /** Rendered into `.suggestion-content`. */
  render(parent: HTMLElement): void;
  run(event: { newTab: boolean }): void;
}

/**
 * Prompt with a filter input and a keyboard-driven result list; the base of the
 * quick switcher and the command palette.
 */
export class SuggestModal extends Modal {
  readonly inputEl: HTMLInputElement;
  readonly resultsEl: HTMLElement;
  private items: Suggestion[] = [];
  private selected = 0;
  private rendered = 0;
  private static readonly PAGE = 60;

  constructor(
    placeholder: string,
    label: string,
    private readonly source: (query: string) => Suggestion[],
    instructions: Array<[string, string]> = [],
    private readonly emptyText = t("Keine Treffer."),
  ) {
    super("prompt");
    this.modalEl.setAttribute("aria-label", label);
    this.inputEl = h("input", {
      class: "prompt-input",
      label,
      attrs: {
        type: "text",
        placeholder,
        autocomplete: "off",
        spellcheck: "false",
        enterkeyhint: "go",
      },
    });
    this.resultsEl = h("div", {
      class: "prompt-results",
      attrs: { role: "listbox" },
    });
    this.modalEl.replaceChildren(
      h("div", "prompt-input-container", this.inputEl),
      this.resultsEl,
    );
    if (instructions.length)
      this.modalEl.append(
        h(
          "div",
          "prompt-instructions",
          ...instructions.map(([key, text]) =>
            h(
              "div",
              "prompt-instruction",
              h("span", { class: "prompt-instruction-command", text: key }),
              h("span", { text }),
            ),
          ),
        ),
      );
    this.inputEl.addEventListener("input", () => this.update());
    this.inputEl.addEventListener("keydown", (event) => this.onKey(event));
    this.resultsEl.addEventListener("click", (event) => {
      const item = (event.target as Element).closest<HTMLElement>(
        ".suggestion-item",
      );
      if (item?.dataset.index)
        this.choose(Number(item.dataset.index), event.ctrlKey || event.metaKey);
    });
    this.resultsEl.addEventListener("mousemove", (event) => {
      const item = (event.target as Element).closest<HTMLElement>(
        ".suggestion-item",
      );
      if (item?.dataset.index) this.select(Number(item.dataset.index), false);
    });
    this.resultsEl.addEventListener("scroll", () => {
      if (
        this.rendered < this.items.length &&
        this.resultsEl.scrollTop + this.resultsEl.clientHeight >
          this.resultsEl.scrollHeight - 200
      )
        this.renderMore();
    });
  }

  override open(): void {
    this.inputEl.value = "";
    this.update();
    super.open();
    this.inputEl.focus();
  }

  private update(): void {
    this.items = this.source(this.inputEl.value);
    this.selected = 0;
    this.rendered = 0;
    this.resultsEl.replaceChildren();
    this.resultsEl.scrollTop = 0;
    if (!this.items.length) {
      this.resultsEl.append(
        h("div", { class: "suggestion-empty", text: this.emptyText }),
      );
      return;
    }
    this.renderMore();
  }

  /** Long lists are rendered in pages while scrolling. */
  private renderMore(): void {
    const end = Math.min(this.items.length, this.rendered + SuggestModal.PAGE);
    const fragment = document.createDocumentFragment();
    for (let i = this.rendered; i < end; i++) {
      const row = h("div", {
        class: `suggestion-item${i === this.selected ? " is-selected" : ""}`,
        attrs: { role: "option" },
        data: { index: String(i) },
      });
      this.items[i].render(row);
      fragment.append(row);
    }
    this.rendered = end;
    this.resultsEl.append(fragment);
  }

  private select(index: number, scroll: boolean): void {
    if (index === this.selected || !this.items.length) return;
    while (index >= this.rendered && this.rendered < this.items.length)
      this.renderMore();
    this.resultsEl.children[this.selected]?.classList.remove("is-selected");
    this.selected = index;
    const row = this.resultsEl.children[index];
    row?.classList.add("is-selected");
    if (scroll) row?.scrollIntoView({ block: "nearest" });
  }

  private choose(index: number, newTab: boolean): void {
    const item = this.items[index];
    if (!item) return;
    this.close();
    item.run({ newTab });
  }

  private onKey(event: KeyboardEvent): void {
    const count = this.items.length;
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      if (count) this.select((this.selected + 1) % count, true);
    } else if (
      event.key === "ArrowUp" ||
      (event.ctrlKey && event.key === "p")
    ) {
      event.preventDefault();
      if (count) this.select((this.selected - 1 + count) % count, true);
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      this.choose(this.selected, event.ctrlKey || event.metaKey);
    }
  }
}
