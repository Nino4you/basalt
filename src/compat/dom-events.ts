type Root = HTMLElement | Document;
type Options = boolean | AddEventListenerOptions;
type Listener = (this: Root, event: Event, delegateTarget: HTMLElement) => unknown;
interface Registration {
  type: string; selector: string; listener: Listener; callback: EventListener; capture: boolean;
  remove: () => void;
}
const registrations = new WeakMap<Root, Set<Registration>>();
const capture = (options?: Options) => typeof options === "boolean" ? options : !!options?.capture;

function on(this: Root, type: string, selector: string | EventListener,
  listenerOrOptions?: Listener | Options, options?: Options): void {
  if (typeof selector !== "string") {
    this.addEventListener(type, selector, listenerOrOptions as Options);
    return;
  }
  const listener = listenerOrOptions as Listener;
  const settings = typeof options === "object" ? options : undefined;
  if (settings?.signal?.aborted) return;
  let entries = registrations.get(this);
  if (!entries) registrations.set(this, entries = new Set());
  const capturing = capture(options);
  for (const entry of entries)
    if (entry.type === type && entry.selector === selector && entry.listener === listener && entry.capture === capturing) return;
  const entry: Registration = { type, selector, listener, capture: capturing, remove: () => {
    this.removeEventListener(type, entry.callback, capturing);
    settings?.signal?.removeEventListener("abort", entry.remove);
    entries.delete(entry);
  }, callback: event => {
    const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
    const matched = target?.closest<HTMLElement>(selector);
    if (!matched || !this.contains(matched)) return;
    if (settings?.once) entry.remove();
    listener.call(this, event, matched);
  } };
  entries.add(entry);
  // Native once would consume an unrelated event before the selector matches.
  this.addEventListener(type, entry.callback, settings ? { ...settings, once: false } : options);
  settings?.signal?.addEventListener("abort", entry.remove, { once: true });
}

function off(this: Root, type: string, selector: string | EventListener,
  listenerOrOptions?: Listener | Options, options?: Options): void {
  if (typeof selector !== "string") {
    this.removeEventListener(type, selector, listenerOrOptions as Options);
    return;
  }
  const entries = registrations.get(this);
  for (const entry of entries ?? []) {
    if (entry.type !== type || entry.selector !== selector || entry.listener !== listenerOrOptions || entry.capture !== capture(options)) continue;
    entry.remove();
  }
}

/** Obsidian exposes delegated DOM events on both elements and documents. */
export function installDomEvents(): void {
  for (const prototype of [HTMLElement.prototype, Document.prototype]) {
    Object.assign(prototype, { on, off });
  }
}
