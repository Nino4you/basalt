import { getLocale, t } from "../i18n";
import { validateNotePath } from "../backend";
import { basename, dirname, formatHotkey, h, icon } from "../ui/dom";
import { fuzzyMatch, highlightMatch } from "../ui/fuzzy";
import { SuggestModal, type Suggestion } from "../ui/modal";
import type { App } from "./app";

let current: SuggestModal | null = null;

/** Opening one prompt replaces the other; pressing its hotkey again closes it. */
function toggle(kind: string, create: () => SuggestModal): void {
  const wasSame = current?.isOpen && current.modalEl.dataset.kind === kind;
  current?.close();
  current = null;
  if (wasSame) return;
  const modal = create();
  modal.modalEl.dataset.kind = kind;
  current = modal;
  modal.open();
}

const MAX_RESULTS = 200;

export function openQuickSwitcher(app: App): void {
  toggle("switcher", () => {
    const entries = app.index.files.map((path) => {
      const name = basename(path);
      return {
        path,
        name,
        lowerName: name.toLowerCase(),
        lowerPath: path.toLowerCase(),
      };
    });
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const open = (path: string) => (event: { newTab: boolean }) =>
      void app.openPath(path, { newTab: event.newTab });

    const fileSuggestion = (
      entry: (typeof entries)[number],
      namePositions: number[] | null,
      pathPositions: number[] | null,
    ): Suggestion => ({
      render(parent) {
        const folder = dirname(entry.path);
        parent.append(
          h(
            "div",
            "suggestion-content",
            h(
              "div",
              "suggestion-title",
              namePositions
                ? highlightMatch(entry.name, namePositions)
                : entry.name,
            ),
            folder
              ? h(
                  "div",
                  "suggestion-note",
                  pathPositions
                    ? highlightMatch(`${folder}/`, pathPositions)
                    : `${folder}/`,
                )
              : null,
          ),
        );
      },
      run: open(entry.path),
    });

    /** A note found by one of its aliases: the alias, then the note it names. */
    const aliasSuggestion = (
      entry: (typeof entries)[number],
      alias: string,
      positions: number[],
    ): Suggestion => ({
      render(parent) {
        parent.append(
          h(
            "div",
            "suggestion-content",
            h("div", "suggestion-title", highlightMatch(alias, positions)),
            h("div", {
              class: "suggestion-note",
              text: `→ ${entry.path.replace(/\.md$/i, "")}`,
            }),
          ),
        );
      },
      run: open(entry.path),
    });

    return new SuggestModal(
      t("Notiz suchen oder erstellen …"),
      t("Schnellauswahl"),
      (raw) => {
        const query = raw.trim().toLowerCase();
        if (!query) {
          const recent = app.ws.recent
            .filter((path) => path !== app.activePath)
            .map((path) => byPath.get(path))
            .filter((entry) => entry !== undefined);
          const seen = new Set(recent.map((entry) => entry.path));
          return [
            ...recent,
            ...entries.filter((entry) => !seen.has(entry.path)),
          ].map((entry) => fileSuggestion(entry, null, null));
        }
        const scored: Array<{ score: number; suggestion: Suggestion }> = [];
        let exact = false;
        for (const entry of entries) {
          if (entry.lowerName === query) exact = true;
          const byName = fuzzyMatch(query, entry.name, entry.lowerName);
          if (byName) {
            scored.push({
              score: byName.score + 100,
              suggestion: fileSuggestion(entry, byName.positions, null),
            });
            continue;
          }
          const alias = app.index
            .aliasesOf(entry.path)
            .map((name) => ({
              name,
              match: fuzzyMatch(query, name, name.toLowerCase()),
            }))
            .find((candidate) => candidate.match);
          if (alias?.match) {
            scored.push({
              score: alias.match.score + 90,
              suggestion: aliasSuggestion(
                entry,
                alias.name,
                alias.match.positions,
              ),
            });
            continue;
          }
          const byFullPath = fuzzyMatch(query, entry.path, entry.lowerPath);
          if (!byFullPath) continue;
          const split = entry.path.lastIndexOf("/") + 1;
          scored.push({
            score: byFullPath.score,
            suggestion: fileSuggestion(
              entry,
              byFullPath.positions
                .filter((position) => position >= split)
                .map((position) => position - split),
              byFullPath.positions.filter((position) => position < split),
            ),
          });
        }
        scored.sort((a, b) => b.score - a.score);
        const results = scored
          .slice(0, MAX_RESULTS)
          .map((entry) => entry.suggestion);
        const name = raw.trim();
        let creatable = false;
        try {
          validateNotePath(name);
          creatable = !exact;
        } catch {
          // Not a valid note name; offer matches only.
        }
        if (creatable)
          results.push({
            render(parent) {
              parent.classList.add("mod-create");
              parent.append(
                h(
                  "div",
                  "suggestion-content",
                  h("div", { class: "suggestion-title", text: name }),
                ),
                h("div", {
                  class: "suggestion-aux suggestion-flair",
                  text: t("Enter zum Erstellen"),
                }),
              );
            },
            run: (event) => void app.createNote(name, { newTab: event.newTab }),
          });
        return results;
      },
      [
        ["↑↓", t("navigieren")],
        ["↵", t("öffnen")],
        [`${formatHotkey("Mod")} ↵`, t("in neuem Tab öffnen")],
        ["esc", t("schließen")],
      ],
      t("Keine Notizen gefunden."),
    );
  });
}

export function openCommandPalette(app: App): void {
  toggle("palette", () => {
    const own = app.commands
      .list()
      .filter((command) => command.id !== "command-palette")
      .map((command) => ({
        name: command.name,
        lower: command.name.toLowerCase(),
        icon: command.icon ?? "terminal",
        hotkey: formatHotkey(app.commands.hotkeyOf(command.id) ?? ""),
        run: () => app.commands.run(command.id),
      }));
    const session = app.compatibility;
    const plugin =
      session?.services
        .getCommands()
        .filter((command) => session.services.isCommandAvailable(command.id))
        .map((command) => ({
          name: command.name,
          lower: command.name.toLowerCase(),
          icon: "puzzle",
          hotkey: "",
          run: () => {
            if (session !== app.compatibility) return;
            try {
              void Promise.resolve(
                session.services.runCommand(command.id),
              ).catch((error) => app.report(error));
            } catch (error) {
              app.report(error);
            }
          },
        })) ?? [];
    const all = [...own, ...plugin].sort((a, b) =>
      a.name.localeCompare(b.name, getLocale()),
    );
    return new SuggestModal(
      t("Befehl eingeben …"),
      t("Befehlspalette"),
      (raw) => {
        const query = raw.trim().toLowerCase();
        const matched = query
          ? all
              .map((command) => ({
                command,
                match: fuzzyMatch(query, command.name, command.lower),
              }))
              .filter((entry) => entry.match)
              .sort((a, b) => b.match!.score - a.match!.score)
          : all.map((command) => ({ command, match: null }));
        return matched.map(({ command, match }) => ({
          render(parent) {
            parent.classList.add("mod-complex");
            parent.append(
              h("div", "suggestion-icon", icon(command.icon, 16)),
              h(
                "div",
                "suggestion-content",
                h(
                  "div",
                  "suggestion-title",
                  match
                    ? highlightMatch(command.name, match.positions)
                    : command.name,
                ),
              ),
            );
            if (command.hotkey)
              parent.append(
                h(
                  "div",
                  "suggestion-aux",
                  h("kbd", {
                    class: "suggestion-hotkey",
                    text: command.hotkey,
                  }),
                ),
              );
          },
          run: command.run,
        }));
      },
      [
        ["↑↓", t("navigieren")],
        ["↵", t("ausführen")],
        ["esc", t("schließen")],
      ],
      t("Kein passender Befehl."),
    );
  });
}
