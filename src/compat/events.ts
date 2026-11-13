/** Opaque listener handles, shared by the compatibility API and lifecycle cleanup. */
export type EventRef = object;
type Callback = (...args: unknown[]) => unknown;
type Listener = {
  owner: Events;
  name: string;
  callback: Callback;
  context: unknown;
  active: boolean;
};
const listeners = new WeakMap<EventRef, Listener>();

export function detachEvent(ref: EventRef): void {
  const listener = listeners.get(ref);
  listener?.owner.offref(ref);
}

/** The error sink is injectable by the host; listener failures never stop other listeners. */
export class Events {
  private readonly events = new Map<string, Set<EventRef>>();

  constructor(
    private readonly report: (error: unknown) => void = (error) => {
      queueMicrotask(() => {
        throw error;
      });
    },
  ) {}

  on<Args extends unknown[]>(
    name: string,
    callback: (...args: Args) => unknown,
    context?: unknown,
  ): EventRef {
    const ref = Object.freeze({});
    listeners.set(ref, {
      owner: this,
      name,
      callback: callback as Callback,
      context,
      active: true,
    });
    let group = this.events.get(name);
    if (!group) this.events.set(name, (group = new Set()));
    group.add(ref);
    return ref;
  }

  off<Args extends unknown[]>(
    name: string,
    callback: (...args: Args) => unknown,
  ): void {
    for (const ref of this.events.get(name) ?? []) {
      if (listeners.get(ref)?.callback === callback) this.offref(ref);
    }
  }

  offref(ref: EventRef): void {
    const listener = listeners.get(ref);
    if (!listener || listener.owner !== this || !listener.active) return;
    listener.active = false;
    const group = this.events.get(listener.name);
    group?.delete(ref);
    if (!group?.size) this.events.delete(listener.name);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const ref of [...(this.events.get(name) ?? [])])
      this.tryTrigger(ref, args);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    const listener = listeners.get(ref);
    if (!listener || listener.owner !== this || !listener.active) return;
    try {
      listener.callback.apply(listener.context, args);
    } catch (error) {
      this.report(error);
    }
  }
}
