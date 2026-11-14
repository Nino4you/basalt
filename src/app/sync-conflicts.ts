import { plural, t } from "../i18n";
import { basename, h } from "../ui/dom";
import { confirmAction, Modal } from "../ui/modal";
import { notify } from "../ui/notice";
import type { App } from "./app";
import { collapseDiff, diffLines } from "./line-diff";

export type Conflict =
  /** A copy a sync tool wrote next to the file it could not merge. */
  | { kind: "copy"; path: string; original: string; tool: string }
  /** Git merge markers inside a note. */
  | { kind: "markers"; path: string };

const COPY_PATTERNS: Array<{ tool: string; pattern: RegExp }> = [
  // Syncthing: Note.sync-conflict-20261114-093000-ABCDEFG.md
  {
    tool: "Syncthing",
    pattern: /^(.*)\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]+)?(\.[^./]+)?$/,
  },
  // Nextcloud, ownCloud and Dropbox:
  // Note (conflicted copy 2026-11-14 093000).md, Note (Ana's conflicted copy 2026-11-14).md
  {
    tool: "Nextcloud/Dropbox",
    pattern: /^(.*?) \((?:[^()]*'s )?conflicted copy[^()]*\)(\.[^./]+)?$/i,
  },
];

/** The file a conflict copy belongs to, or null for ordinary files. */
export function conflictCopyOf(
  path: string,
): { original: string; tool: string } | null {
  const slash = path.lastIndexOf("/");
  const folder = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  for (const { tool, pattern } of COPY_PATTERNS) {
    const match = pattern.exec(name);
    if (match && match[1])
      return { original: `${folder}${match[1]}${match[2] ?? ""}`, tool };
  }
  return null;
}

/** Whether a note still holds an unresolved Git merge conflict. */
export function hasConflictMarkers(text: string): boolean {
  const start = text.search(/^<{7}(?: |$)/m);
  if (start < 0) return false;
  const middle = text.slice(start).search(/^={7}\s*$/m);
  return middle > 0 && /^>{7}(?: |$)/m.test(text.slice(start + middle));
}

/** Conflict copies of notes and canvases, and notes with merge markers. */
export function findConflicts(
  files: readonly string[],
  contentOf: (path: string) => string | undefined,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const path of files) {
    if (!/\.(md|canvas)$/i.test(path)) continue;
    const copy = conflictCopyOf(path);
    if (copy) {
      conflicts.push({ kind: "copy", path, ...copy });
      continue;
    }
    const text = /\.md$/i.test(path) ? contentOf(path) : undefined;
    if (text !== undefined && hasConflictMarkers(text))
      conflicts.push({ kind: "markers", path });
  }
  return conflicts.sort((a, b) => a.path.localeCompare(b.path));
}

/** Tells about conflicts once each per session, so sync problems do not go unnoticed. */
export class ConflictWatcher {
  private readonly reported = new Set<string>();
  conflicts: Conflict[] = [];

  update(conflicts: Conflict[]): Conflict[] {
    this.conflicts = conflicts;
    const fresh = conflicts.filter(
      (conflict) => !this.reported.has(conflict.path),
    );
    for (const conflict of fresh) this.reported.add(conflict.path);
    return fresh;
  }

  reset(): void {
    this.reported.clear();
    this.conflicts = [];
  }
}

function diffView(before: string, after: string): HTMLElement {
  const lines = diffLines(before, after);
  if (!lines)
    return h("p", {
      class: "pane-empty",
      text: t("Die Dateien unterscheiden sich zu stark für einen Vergleich."),
    });
  if (lines.every((line) => line.type === "same"))
    return h("p", {
      class: "pane-empty",
      text: t("Beide Fassungen sind gleich."),
    });
  return h(
    "div",
    "recovery-diff sync-conflict-diff",
    ...collapseDiff(lines, 2).map((line) =>
      line.type === "skip"
        ? h("div", {
            class: "recovery-diff-skip",
            text: plural(line.count, {
              one: "{count} unveränderte Zeile",
              other: "{count} unveränderte Zeilen",
            }),
          })
        : h("div", {
            class: `recovery-diff-line is-${line.type}`,
            text: `${line.type === "add" ? "+" : line.type === "remove" ? "−" : " "} ${line.text}`,
          }),
    ),
  );
}

/** Lists the vault's sync conflicts with ways to compare and resolve them. */
export function openSyncConflicts(app: App): void {
  const modal = new Modal("mod-sync-conflicts");
  modal.setTitle(t("Sync-Konflikte"));
  const render = () => {
    const conflicts = app.syncConflicts();
    modal.contentEl.replaceChildren(
      h("p", {
        class: "setting-item-description",
        text: t(
          "Sync-Programme legen eine Konfliktkopie an, wenn eine Datei auf zwei Geräten geändert wurde. Basalt ändert nichts davon von selbst.",
        ),
      }),
    );
    if (!conflicts.length) {
      modal.contentEl.append(
        h("p", {
          class: "pane-empty",
          text: t("Keine Sync-Konflikte gefunden."),
        }),
      );
      return;
    }
    for (const conflict of conflicts) {
      const item = h("div", "sync-conflict");
      const actions = h("div", "sync-conflict-actions");
      const details = h("div", "sync-conflict-details");
      const button = (text: string, onClick: () => void, warning = false) =>
        h("button", {
          class: warning ? "mod-warning" : "",
          text,
          attrs: { type: "button" },
          on: { click: onClick },
        });
      const open = (path: string) => {
        modal.close();
        void app.openPath(path);
      };
      if (conflict.kind === "markers") {
        item.append(
          h("div", { class: "sync-conflict-title", text: conflict.path }),
          h("div", {
            class: "setting-item-description",
            text: t("Enthält Git-Konfliktmarkierungen (<<<<<<< … >>>>>>>)."),
          }),
          actions,
        );
        actions.append(button(t("Öffnen"), () => open(conflict.path)));
        modal.contentEl.append(item);
        continue;
      }
      const exists = app.index.has(conflict.original);
      item.append(
        h("div", { class: "sync-conflict-title", text: conflict.path }),
        h("div", {
          class: "setting-item-description",
          text: exists
            ? t("Konfliktkopie von „{name}“ ({tool}).", {
                name: conflict.original,
                tool: conflict.tool,
              })
            : t("Konfliktkopie von „{name}“ ({tool}); das Original fehlt.", {
                name: conflict.original,
                tool: conflict.tool,
              }),
        }),
        actions,
        details,
      );
      actions.append(button(t("Öffnen"), () => open(conflict.path)));
      if (exists) {
        actions.append(
          button(t("Vergleichen"), () => {
            if (details.firstChild) {
              details.replaceChildren();
              return;
            }
            void Promise.all([
              app.readNote(conflict.original),
              app.readNote(conflict.path),
            ]).then(
              ([original, copy]) =>
                details.replaceChildren(
                  h("div", {
                    class: "setting-item-description",
                    text: t("− nur im Original, + nur in der Konfliktkopie"),
                  }),
                  diffView(original, copy),
                ),
              (error) => app.report(error),
            );
          }),
          button(t("Kopie übernehmen"), () =>
            confirmAction({
              title: t("Kopie übernehmen"),
              text: t(
                "„{original}“ durch den Inhalt der Konfliktkopie ersetzen und die Kopie in den Papierkorb verschieben? Das Original wird vorher gesichert.",
                {
                  original: basename(conflict.original),
                },
              ),
              confirm: t("Übernehmen"),
              run: async () => {
                await app.adoptConflictCopy(conflict.path, conflict.original);
                notify(t("Konfliktkopie übernommen."));
                render();
              },
              onError: (error) => app.report(error),
            }),
          ),
        );
      }
      actions.append(
        button(
          t("Kopie löschen"),
          () =>
            confirmAction({
              title: t("Kopie löschen"),
              text: t("„{name}“ in den Papierkorb des Vaults verschieben?", {
                name: basename(conflict.path),
              }),
              confirm: t("Löschen"),
              warning: true,
              run: async () => {
                await app.trashFile(conflict.path);
                render();
              },
              onError: (error) => app.report(error),
            }),
          true,
        ),
      );
      modal.contentEl.append(item);
    }
  };
  render();
  modal.open();
}

/** One line for the status bar, or "" without conflicts. */
export function conflictSummary(conflicts: Conflict[]): string {
  return conflicts.length
    ? plural(conflicts.length, {
        one: "{count} Sync-Konflikt",
        other: "{count} Sync-Konflikte",
      })
    : "";
}
