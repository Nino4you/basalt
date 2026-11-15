/** Imperative settings sub-page; the containing settings host owns navigation. */
export abstract class SettingPage {
  readonly rootEl = document.createElement("div");
  readonly titlebarEl = document.createElement("h2");
  readonly containerEl = document.createElement("div");

  constructor() {
    this.rootEl.className = "setting-page";
    this.titlebarEl.className = "setting-page-titlebar";
    this.containerEl.className = "setting-page-content";
    this.rootEl.append(this.titlebarEl, this.containerEl);
  }

  get title(): string { return this.titlebarEl.textContent ?? ""; }
  set title(value: string) { this.titlebarEl.textContent = value; }

  abstract display(): void;

  hide(): void {
    this.containerEl.replaceChildren();
  }
}
