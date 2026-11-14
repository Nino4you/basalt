import { Facet, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Explorer rows put their vault path under this type while dragging. */
export const FILE_MIME = "application/x-basalt-file";

export interface AttachmentHost {
  /**
   * Stores the files in the vault and returns the Markdown that links them,
   * or null when nothing was stored (the host reports why).
   */
  attachFiles?(files: File[], pasted: boolean): Promise<string | null>;
  /** The wiki link for a vault file dragged in from the explorer. */
  linkTo?(path: string): string | null;
}

export const attachmentHost = Facet.define<AttachmentHost, AttachmentHost>({
  combine: (values) => values[0] ?? {},
});

function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files?.length) return [...data.files];
  const files: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

async function attach(
  view: EditorView,
  host: AttachmentHost,
  files: File[],
  pasted: boolean,
): Promise<void> {
  const markdown = await host.attachFiles!(files, pasted);
  if (!markdown || !view.state.facet(EditorView.editable)) return;
  view.dispatch(view.state.replaceSelection(markdown), {
    scrollIntoView: true,
    userEvent: pasted ? "input.paste" : "input.drop",
  });
  view.focus();
}

/**
 * Pasting or dropping files stores them as attachments and inserts links,
 * like Obsidian. Pasted text always wins over files, so copying formatted
 * text from an office program (text plus a picture of it) still pastes text.
 * Rows dragged from the file explorer drop a wiki link.
 */
export const attachmentHandlers: Extension = EditorView.domEventHandlers({
  paste(event, view) {
    const host = view.state.facet(attachmentHost);
    const data = event.clipboardData;
    if (!host.attachFiles || !view.state.facet(EditorView.editable))
      return false;
    if (data?.getData("text/plain")) return false;
    const files = filesOf(data);
    if (!files.length) return false;
    event.preventDefault();
    void attach(view, host, files, true);
    return true;
  },
  dragover(event, view) {
    const types = event.dataTransfer?.types ?? [];
    if (
      view.state.facet(EditorView.editable) &&
      (types.includes("Files") || types.includes(FILE_MIME))
    ) {
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    }
    return false;
  },
  drop(event, view) {
    const host = view.state.facet(attachmentHost);
    const data = event.dataTransfer;
    if (!data || !view.state.facet(EditorView.editable)) return false;
    const vaultPath = data.getData(FILE_MIME);
    const files = vaultPath ? [] : filesOf(data);
    if (!vaultPath && (!files.length || !host.attachFiles)) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) view.dispatch({ selection: { anchor: pos } });
    if (vaultPath) {
      const link = host.linkTo?.(vaultPath);
      if (link)
        view.dispatch(view.state.replaceSelection(link), {
          userEvent: "input.drop",
        });
      view.focus();
      return true;
    }
    void attach(view, host, files, false);
    return true;
  },
});
