import type { Extension } from "@codemirror/state";

/** All plugins share the host's CodeMirror packages; each registration has an independent owner. */
export class EditorExtensionRegistry {
  private readonly registrations = new Map<object, Extension>();
  constructor(private readonly apply: (extensions: Extension[]) => void) {}

  register(extension: Extension): () => void {
    const token = {};
    this.registrations.set(token, extension);
    try {
      this.refresh();
    } catch (error) {
      this.registrations.delete(token);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      this.registrations.delete(token);
      try {
        this.refresh();
      } catch (error) {
        this.registrations.set(token, extension);
        throw error;
      }
      active = false;
    };
  }

  /** Reapply mutable extension arrays, as used by sync plugins when documents are rebound. */
  refresh(): void {
    this.apply([...this.registrations.values()]);
  }
}
