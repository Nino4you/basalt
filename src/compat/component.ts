import { detachEvent, type EventRef } from "./events";

/** Resource ownership for synchronous render components. Async plugin activation is a separate layer. */
export class Component {
  private phase: "new" | "loaded" | "unloading" | "unloaded" = "new";
  private readonly children = new Set<Component>();
  private readonly cleanup: Array<() => unknown> = [];
  private parent: Component | null = null;
  private unloadTasks: Promise<unknown>[] = [];

  /** Legacy plugins assign this flag; only phase controls host resource ownership. */
  _loaded = false;

  onload(): void {}
  onunload(): void {}

  /** Host-only lifecycle entry, used when Plugin activation must await an async hook. */
  protected beginLifecycle(): boolean {
    if (this.phase === "loaded") return false;
    if (this.phase === "unloading")
      throw new Error("Cannot load a component while it is unloading");
    this.phase = "loaded";
    this._loaded = true;
    this.unloadTasks = [];
    return true;
  }

  load(): void {
    if (!this.beginLifecycle()) return;
    try {
      this.onload();
      for (const child of this.children) {
        if (this.phase !== "loaded") break;
        child.load();
      }
    } catch (error) {
      try {
        this.unload();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Component load and rollback failed",
        );
      }
      throw error;
    }
  }

  unload(): void {
    if (this.phase === "unloading" || this.phase === "unloaded") return;
    const wasLoaded = this.phase === "loaded";
    this.phase = "unloading";
    this._loaded = false;
    const errors: unknown[] = [];
    const attempt = (fn: () => unknown) => {
      try {
        const result = fn();
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          const task = Promise.resolve(result);
          void task.catch(() => {});
          this.unloadTasks.push(task);
        }
      } catch (error) {
        errors.push(error);
      }
    };
    if (wasLoaded) attempt(() => this.onunload());
    for (const child of [...this.children].reverse())
      attempt(() => child.unloadAsync());
    while (this.cleanup.length) attempt(this.cleanup.pop()!);
    this.phase = "unloaded";
    if (errors.length)
      throw new AggregateError(errors, "Component cleanup failed");
  }

  /** Host extension: resource cleanup starts synchronously, async shutdown hooks are then awaited. */
  async unloadAsync(): Promise<void> {
    const errors: unknown[] = [];
    try {
      this.unload();
    } catch (error) {
      errors.push(error);
    }
    const settled = await Promise.allSettled(this.unloadTasks);
    for (const result of settled)
      if (result.status === "rejected") errors.push(result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Asynchronous component cleanup failed");
  }

  addChild<T extends Component>(child: T): T {
    if (this.phase === "unloading" || this.phase === "unloaded")
      throw new Error(
        "Cannot attach children after cleanup; load the owner first",
      );
    if (this.children.has(child)) return child;
    for (
      let ancestor: Component | null = this;
      ancestor;
      ancestor = ancestor.parent
    ) {
      if (ancestor === child)
        throw new Error("Component ownership cannot contain cycles");
    }
    if (child.parent) throw new Error("A component can have only one parent");
    child.parent = this;
    this.children.add(child);
    if (this.phase === "loaded") {
      try {
        child.load();
      } catch (error) {
        this.children.delete(child);
        child.parent = null;
        throw error;
      }
    }
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    if (!this.children.delete(child)) return child;
    child.parent = null;
    child.unload();
    return child;
  }

  register(callback: () => unknown): void {
    if (this.phase === "unloading" || this.phase === "unloaded") callback();
    else this.cleanup.push(callback);
  }

  registerEvent(ref: EventRef): void {
    this.register(() => detachEvent(ref));
  }

  registerDomEvent<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    callback: (event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    callback: (event: DocumentEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    callback: (event: WindowEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent(
    target: EventTarget,
    type: string,
    callback: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    // Capture is the only option relevant to matching removeEventListener. Snapshot it now.
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    target.addEventListener(type, callback, options);
    this.register(() => target.removeEventListener(type, callback, capture));
  }

  registerInterval(id: number): number {
    this.register(() => window.clearInterval(id));
    return id;
  }
}
