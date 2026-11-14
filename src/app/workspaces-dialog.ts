import { getLocale, t } from "../i18n";
import { h, icon } from "../ui/dom";
import { fuzzyMatch, highlightMatch } from "../ui/fuzzy";
import { confirmAction, Modal, SuggestModal } from "../ui/modal";
import type { App } from "./app";

/** Error codes of `WorkspaceLibrary` and `workspaceName` as user messages. */
export function workspaceError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "empty") return t("Gib einen Namen ein.");
  if (code === "too-long")
    return t("Der Name ist zu lang (höchstens 80 Zeichen).");
  if (code === "limit")
    return t("Es können höchstens 100 Workspaces gespeichert werden.");
  if (code === "exists")
    return t("Ein Workspace mit diesem Namen existiert bereits.");
  return error instanceof Error ? error.message : String(error);
}

/** Save the current layout under a name, and load, rename or delete saved ones. */
export function openWorkspaces(app: App): Modal | null {
  const library = app.workspaces;
  if (!library) return null;
  const modal = new Modal("mod-workspaces");
  modal.setTitle(t("Workspaces"));
  const input = h("input", {
    label: t("Name des Workspace"),
    attrs: {
      type: "text",
      placeholder: t("Name des Workspace"),
      maxlength: "80",
      autocomplete: "off",
      spellcheck: "false",
      enterkeyhint: "done",
    },
  });
  input.value = library.active ?? "";
  const error = h("p", {
    class: "field-error",
    attrs: { role: "alert", hidden: true },
  });
  const showError = (reason: unknown) => {
    error.textContent = workspaceError(reason);
    error.hidden = false;
  };
  const list = h("div", { class: "workspace-list", attrs: { role: "list" } });
  const form = h(
    "form",
    { class: "workspace-save", attrs: { novalidate: true } },
    h("p", {
      class: "modal-description",
      text: t(
        "Speichert offene Tabs, Teilungen und Seitenleisten. Ein vorhandener Name wird überschrieben.",
      ),
    }),
    h(
      "div",
      "workspace-save-row",
      input,
      h("button", {
        class: "mod-cta",
        text: t("Speichern"),
        attrs: { type: "submit" },
      }),
    ),
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.hidden = true;
    try {
      app.saveNamedWorkspace(input.value);
      render();
    } catch (reason) {
      showError(reason);
      input.focus();
    }
  });

  const date = new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const render = () => {
    const items = library.list();
    list.replaceChildren(
      ...(items.length
        ? items.map((workspace) => {
            const active = workspace.name === library.active;
            return h(
              "div",
              {
                class: `workspace-item${active ? " is-active" : ""}`,
                attrs: { role: "listitem" },
              },
              h(
                "div",
                "workspace-item-info",
                h("div", {
                  class: "workspace-item-name",
                  text: workspace.name,
                }),
                h("div", {
                  class: "workspace-item-meta",
                  text: active
                    ? t("Aktiv · gespeichert {date}", {
                        date: date.format(workspace.saved),
                      })
                    : t("Gespeichert {date}", {
                        date: date.format(workspace.saved),
                      }),
                }),
              ),
              h("button", {
                class: active ? "" : "mod-cta",
                text: t("Laden"),
                attrs: { type: "button" },
                on: {
                  click: () => {
                    modal.close();
                    void app
                      .loadNamedWorkspace(workspace.name)
                      .catch((reason) => app.report(reason));
                  },
                },
              }),
              h(
                "button",
                {
                  class: "clickable-icon",
                  label: t("Workspace „{name}“ löschen", {
                    name: workspace.name,
                  }),
                  attrs: { type: "button" },
                  on: {
                    click: () =>
                      confirmAction({
                        title: t("Workspace löschen?"),
                        text: t(
                          "„{name}“ wird entfernt. Offene Tabs und Notizen bleiben unverändert.",
                          { name: workspace.name },
                        ),
                        confirm: t("Löschen"),
                        warning: true,
                        run: async () => {
                          library.remove(workspace.name);
                          render();
                        },
                        onError: (reason) => app.report(reason),
                      }),
                  },
                },
                icon("trash-2", 16),
              ),
            );
          })
        : [
            h("p", {
              class: "workspace-empty",
              text: t("Noch keine Workspaces gespeichert."),
            }),
          ]),
    );
  };
  render();
  modal.contentEl.append(form, list);
  modal.open();
  input.focus();
  input.select();
  return modal;
}

/** Quick picker over the saved workspaces. */
export function openWorkspaceLoader(app: App): void {
  const library = app.workspaces;
  if (!library) return;
  const items = library.list();
  if (!items.length) {
    openWorkspaces(app);
    return;
  }
  new SuggestModal(t("Workspace laden …"), t("Workspace laden"), (raw) => {
    const query = raw.trim().toLowerCase();
    return items
      .map((workspace) => ({
        workspace,
        match: query
          ? fuzzyMatch(query, workspace.name, workspace.name.toLowerCase())
          : null,
      }))
      .filter((entry) => !query || entry.match)
      .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
      .map(({ workspace, match }) => ({
        render(parent) {
          parent.classList.add("mod-complex");
          parent.append(
            h("div", "suggestion-icon", icon("layout-template", 16)),
            h(
              "div",
              "suggestion-content",
              h(
                "div",
                "suggestion-title",
                match
                  ? highlightMatch(workspace.name, match.positions)
                  : workspace.name,
              ),
            ),
          );
          if (workspace.name === library.active)
            parent.append(
              h("div", { class: "suggestion-aux", text: t("Aktiv") }),
            );
        },
        run: () =>
          void app
            .loadNamedWorkspace(workspace.name)
            .catch((reason) => app.report(reason)),
      }));
  }).open();
}
