import { plural, t } from "../i18n";
import { h, icon } from "../ui/dom";
import { Modal } from "../ui/modal";
import type { SharedContent } from "./android-share";
import { shareTitle } from "./android-share";

export interface ShareTarget {
  /** Saves as a new note named `name`; resolves to its path. */
  createNote(share: SharedContent, name: string): Promise<string | null>;
  /** Appends to the open note; null when no Markdown note is open. */
  appendTarget(): string | null;
  appendToCurrent(share: SharedContent): Promise<void>;
}

const PREVIEW = 400;

/** Asks where content shared from another app goes: a new note or the open one. */
export function openShareDialog(
  target: ShareTarget,
  share: SharedContent,
): Modal {
  const modal = new Modal("mod-share");
  modal.setTitle(t("Mit Basalt teilen"));
  const text = share.text.trim();
  const preview = h(
    "div",
    "share-preview",
    text
      ? h("div", {
          class: "share-preview-text",
          text: text.length > PREVIEW ? `${text.slice(0, PREVIEW)} …` : text,
        })
      : null,
    ...share.files.map((file) =>
      h(
        "div",
        "share-preview-file",
        icon(file.type.startsWith("image/") ? "image" : "file", 16),
        h("span", { text: file.name }),
      ),
    ),
  );
  if (!preview.childElementCount)
    preview.append(
      h("div", {
        class: "share-preview-text",
        text: t("Keine lesbaren Inhalte."),
      }),
    );
  const input = h("input", {
    label: t("Name der Notiz"),
    attrs: {
      type: "text",
      maxlength: "180",
      autocomplete: "off",
      spellcheck: "false",
      enterkeyhint: "done",
    },
  });
  input.value = shareTitle(share);
  const error = h("p", {
    class: "field-error",
    attrs: { role: "alert", hidden: true },
  });
  const skipped = share.skipped.length
    ? h("p", {
        class: "share-skipped",
        text: `${plural(share.skipped.length, {
          one: "{count} Datei wurde nicht übernommen (zu groß oder nicht lesbar)",
          other:
            "{count} Dateien wurden nicht übernommen (zu groß oder nicht lesbar)",
        })}: ${share.skipped.join(", ")}`,
      })
    : null;
  const appendPath = target.appendTarget();
  const buttons: HTMLButtonElement[] = [];
  const run = (action: () => Promise<unknown>) => {
    error.hidden = true;
    for (const button of buttons) button.disabled = true;
    action().then(
      () => modal.close(),
      (reason) => {
        error.textContent =
          reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
        for (const button of buttons) button.disabled = false;
      },
    );
  };
  const create = h("button", {
    class: "mod-cta",
    text: t("Als neue Notiz speichern"),
    attrs: { type: "submit" },
  });
  buttons.push(create);
  const append = appendPath
    ? h("button", {
        text: t("An „{name}“ anhängen", {
          name: appendPath.split("/").pop()!.replace(/\.md$/i, ""),
        }),
        attrs: { type: "button" },
        on: { click: () => run(() => target.appendToCurrent(share)) },
      })
    : null;
  if (append) buttons.push(append);
  const form = h(
    "form",
    { attrs: { novalidate: true } },
    preview,
    skipped,
    h("label", { class: "share-label", text: t("Name der Notiz") }),
    input,
    error,
    h("div", "modal-button-container share-buttons", append, create),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(() => target.createNote(share, input.value));
  });
  modal.contentEl.append(form);
  modal.open();
  return modal;
}
