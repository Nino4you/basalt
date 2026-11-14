import { getLocale, t } from "../i18n";
import { native } from "../backend";
import {
  compareVersions,
  downloadRelease,
  installedSource,
  installPlugin,
  latestManifest,
  listReleases,
  loadCatalog,
  parseRepo,
  searchCatalog,
  supportsMinAppVersion,
  uninstallPlugin,
  validatePluginFiles,
  verifiedVersion,
  type CatalogEntry,
  type PluginFiles,
  type PluginRelease,
} from "../compat/plugin-catalog";
import { API_VERSION } from "../compat/api-version";
import {
  fetchRequestUrl,
  nativeRequestUrl,
  type RequestUrl,
} from "../compat/request";
import { errorMessage, h, icon } from "../ui/dom";
import { Modal } from "../ui/modal";
import { notify } from "../ui/notice";
import type { App } from "./app";

/** Catalog and release downloads: through Rust in the app, `fetch` in the demo. */
/** HTTP for the app itself: Rust in the native app, fetch in the browser demo. */
export const hostRequest: RequestUrl = native
  ? nativeRequestUrl()
  : fetchRequestUrl;
const request = hostRequest;

/** Rows rendered at once; the catalog has thousands of plugins. */
const PAGE = 100;

let catalog: Promise<CatalogEntry[]> | null = null;

/** The catalog, loaded once per app start; a failed load is tried again next time. */
export function pluginCatalog(): Promise<CatalogEntry[]> {
  catalog ??= loadCatalog(request).catch((error) => {
    catalog = null;
    throw error;
  });
  return catalog;
}

const releases = new Map<string, Promise<PluginRelease[]>>();

/**
 * A repository's releases, listed once per app start (GitHub limits
 * anonymous API calls); a failed listing is tried again next time.
 */
export function pluginReleases(repo: string): Promise<PluginRelease[]> {
  const key = repo.toLowerCase();
  let listed = releases.get(key);
  if (!listed) {
    listed = listReleases(repo, request).catch((error) => {
      releases.delete(key);
      throw error;
    });
    releases.set(key, listed);
  }
  return listed;
}

const formatCount = (value: number) =>
  new Intl.NumberFormat(getLocale(), { notation: "compact" }).format(value);

/**
 * "Checked" for a catalog entry, or, with `version`, only when exactly that
 * version was checked: another release of a checked plugin is untested.
 */
function trustBadge(
  entry: { verified: string | null },
  version?: string,
): HTMLElement {
  if (entry.verified && version !== undefined && version !== entry.verified)
    return h("span", {
      class: "plugin-badge",
      text: t("Ungeprüft"),
      title: t("Mit Basalt geprüft wurde nur Version {version}, nicht diese.", {
        version: entry.verified,
      }),
    });
  return entry.verified
    ? h(
        "span",
        {
          class: "plugin-badge mod-verified",
          title: t("Mit Basalt geprüft (Version {version})", {
            version: entry.verified,
          }),
        },
        icon("badge-check", 14),
        t("Geprüft"),
      )
    : h("span", {
        class: "plugin-badge",
        text: t("Ungeprüft"),
        title: t(
          "Nicht mit Basalt geprüft: kann funktionieren, teilweise funktionieren oder sichtbar scheitern.",
        ),
      });
}

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(
        date,
      );
};

/** A short picker entry: "2.1.0-beta.2 (Vorabversion) ⚠". */
function releaseLabel(
  release: PluginRelease,
  installedVersion: string | undefined,
): string {
  const notes = [
    release.prerelease ? t("Vorabversion") : "",
    release.version === installedVersion ? t("installiert") : "",
  ].filter(Boolean);
  return `${release.version}${notes.length ? ` (${notes.join(", ")})` : ""}${
    supportsMinAppVersion(release.minAppVersion) ? "" : " ⚠"
  }`;
}

/** The line under "Version": what the picked release is. */
function releaseDetail(
  release: PluginRelease,
  installedVersion: string | undefined,
  verified: string | null,
  latest: boolean,
): string {
  const date = formatDate(release.publishedAt);
  return [
    latest
      ? t("Neueste Version {version}", { version: release.version })
      : release.prerelease
        ? t("Vorabversion")
        : t("Version {version}", { version: release.version }),
    date ? t("vom {date}", { date }) : "",
    release.version === installedVersion ? t("installiert") : "",
    release.version === verified ? t("mit Basalt geprüft") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Asks before any plugin code lands in the vault, and says plainly that
 * plugins are not sandboxed. Resolves to `true` when the user agrees.
 */
function confirmInstall(
  files: PluginFiles,
  origin: string,
  installed: string | null,
  verified: string | null,
): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal("mod-plugin-confirm");
    const manifest = files.manifest;
    const downgrade =
      installed !== null &&
      installed !== "?" &&
      compareVersions(manifest.version, installed) < 0;
    modal.setTitle(
      downgrade
        ? t("Plugin-Version wechseln")
        : installed
          ? t("Plugin aktualisieren")
          : t("Plugin installieren"),
    );
    let answer = false;
    modal.onClose = () => resolve(answer);
    const cancel = h("button", {
      text: t("Abbrechen"),
      attrs: { type: "button" },
      on: { click: () => modal.close() },
    });
    const submit = h("button", {
      class: "mod-cta",
      text: downgrade
        ? t("Version wechseln")
        : installed
          ? t("Aktualisieren")
          : t("Installieren"),
      attrs: { type: "button" },
      on: {
        click: () => {
          answer = true;
          modal.close();
        },
      },
    });
    const android =
      document.body.classList.contains("is-mobile") ||
      /Android/i.test(navigator.userAgent);
    modal.contentEl.append(
      h(
        "div",
        "plugin-confirm-head",
        h("strong", { text: manifest.name }),
        trustBadge({ verified }, manifest.version),
      ),
      h("p", {
        class: "modal-description",
        text: installed
          ? t("Version {version} ersetzt {old} · {id} · aus {origin}", {
              version: manifest.version,
              old: installed,
              id: manifest.id,
              origin,
            })
          : t("Version {version} · {id} · aus {origin}", {
              version: manifest.version,
              id: manifest.id,
              origin,
            }),
      }),
      h("p", {
        class: "plugin-warning",
        text: t(
          "Plugins laufen nicht abgeschottet: Ihr Code hat dieselben Rechte wie Basalt und kann alle Notizen lesen und ändern. Installiere nur Plugins, denen du vertraust.",
        ),
      }),
      supportsMinAppVersion(manifest.minAppVersion)
        ? ""
        : h("p", {
            class: "plugin-warning",
            text: t(
              "Diese Version verlangt Obsidian {min}; Basalt bietet die Plugin-Schnittstelle von Obsidian {api}. Sie startet womöglich nicht oder nur teilweise.",
              { min: manifest.minAppVersion ?? "", api: API_VERSION },
            ),
          }),
      downgrade
        ? h("p", {
            class: "plugin-warning",
            text: t(
              "Eine ältere Version kann mit Einstellungen, die eine neuere gespeichert hat, nicht immer umgehen.",
            ),
          })
        : "",
      manifest.isDesktopOnly && android
        ? h("p", {
            class: "plugin-warning",
            text: t(
              "Dieses Plugin ist nur für Desktop-Obsidian gedacht und läuft auf Android wahrscheinlich nicht.",
            ),
          })
        : "",
      h("p", {
        class: "modal-description",
        text: installed
          ? t(
              "Seine Einstellungen bleiben erhalten; die ersetzten Dateien werden gesichert.",
            )
          : t(
              "Installieren aktiviert das Plugin noch nicht. Das geschieht danach in der Liste der installierten Plugins.",
            ),
      }),
      h("div", "modal-button-container", cancel, submit),
    );
    modal.open();
    cancel.focus();
  });
}

/**
 * Installs or updates after asking. An enabled plugin is stopped while its
 * files change and started again afterwards. Returns `true` when installed.
 */
async function install(
  app: App,
  files: PluginFiles,
  source: { repo: string } | null,
  verified: string | null,
): Promise<boolean> {
  const session = app.compatibility;
  if (!session)
    throw new Error(
      t("Plugins lassen sich nur in der nativen App installieren."),
    );
  const id = files.manifest.id;
  const current = (await session.bundleHost.list()).find(
    (listing) => listing.id === id,
  );
  const origin = source ? source.repo : t("lokalen Dateien");
  if (
    !(await confirmInstall(
      files,
      origin,
      current?.manifest?.version ?? (current ? "?" : null),
      verified,
    ))
  )
    return false;
  if (session !== app.compatibility) return false;
  const wasEnabled = session.bundleHost.isEnabled(id);
  if (wasEnabled) {
    app.releasePluginUi();
    await session.bundleHost.disable(id);
  }
  let updated = false;
  try {
    updated = (await installPlugin(session.configVault, files, source)).updated;
  } finally {
    await session.refresh().catch((error) => app.report(error));
    if (wasEnabled)
      try {
        await session.bundleHost.enable(id);
        app.pluginErrors.delete(id);
      } catch (error) {
        app.pluginErrors.set(id, errorMessage(error));
        app.report(error);
      }
    session.saveEnabledPlugins();
    app.refreshPluginUi();
  }
  notify(
    updated
      ? t("„{name}“ ist jetzt auf Version {version}.", {
          name: files.manifest.name,
          version: files.manifest.version,
        })
      : t(
          "„{name}“ ist installiert. Aktiviere es in der Liste der installierten Plugins.",
          { name: files.manifest.name },
        ),
  );
  return true;
}

/** Browses the community catalog and installs from it. */
export function openPluginCatalog(app: App, changed: () => void): void {
  const modal = new Modal("mod-plugin-catalog");
  modal.setTitle(t("Community-Plugins durchsuchen"));
  const search = h("input", {
    class: "plugin-catalog-search",
    attrs: {
      type: "search",
      placeholder: t("Plugins suchen …"),
      "aria-label": t("Plugins suchen …"),
      spellcheck: "false",
    },
  });
  const list = h("div", { class: "plugin-catalog-list" });
  const details = h("div", {
    class: "plugin-catalog-details",
    attrs: { "aria-live": "polite" },
  });
  const status = h("p", {
    class: "plugin-catalog-status",
    text: t("Katalog wird geladen …"),
  });
  modal.contentEl.append(
    search,
    status,
    h("div", "plugin-catalog-body", list, details),
  );
  let entries: CatalogEntry[] = [];
  let shown: CatalogEntry[] = [];
  let selected: CatalogEntry | null = null;
  let limit = PAGE;
  const installed = new Map<string, string>();
  /** The release tag picked per plugin; missing or "" means the latest. */
  const chosen = new Map<string, string>();

  const renderList = () => {
    list.replaceChildren(
      ...shown.slice(0, limit).map((entry) =>
        h(
          "button",
          {
            class: `plugin-catalog-row${entry === selected ? " is-selected" : ""}`,
            attrs: {
              type: "button",
              "aria-pressed": entry === selected ? "true" : null,
            },
            on: {
              click: () => {
                selected = entry;
                modal.modalEl.classList.add("is-previewing");
                renderList();
                renderDetails();
              },
            },
          },
          h(
            "span",
            "plugin-catalog-row-title",
            h("span", { text: entry.name }),
            entry.verified ? trustBadge(entry) : null,
            installed.has(entry.id)
              ? h("span", {
                  class: "plugin-badge mod-installed",
                  text: t("Installiert"),
                })
              : null,
          ),
          h("span", {
            class: "plugin-catalog-row-meta",
            text: [
              entry.author,
              entry.downloads
                ? t("{count} Downloads", {
                    count: formatCount(entry.downloads),
                  })
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
          }),
          h("span", {
            class: "plugin-catalog-row-description",
            text: entry.description,
          }),
        ),
      ),
      shown.length > limit
        ? h("button", {
            class: "plugin-catalog-more",
            text: t("Weitere {count} anzeigen", {
              count: Math.min(PAGE, shown.length - limit),
            }),
            attrs: { type: "button" },
            on: {
              click: () => {
                limit += PAGE;
                renderList();
              },
            },
          })
        : "",
    );
    status.textContent = entries.length
      ? t("{shown} von {total} Plugins", {
          shown: shown.length,
          total: entries.length,
        })
      : status.textContent;
  };

  const renderDetails = () => {
    const entry = selected;
    if (!entry) {
      details.replaceChildren(
        h("p", {
          class: "plugin-catalog-empty",
          text: t("Wähle ein Plugin, um mehr zu sehen."),
        }),
      );
      return;
    }
    const version = installed.get(entry.id);
    const tag = chosen.get(entry.id) ?? "";
    let listed: PluginRelease[] = [];
    const action = h("button", {
      class: "mod-cta",
      attrs: { type: "button" },
    });
    const latestOption = h("option", {
      text: t("Neueste Version"),
      attrs: { value: "" },
    });
    const picker = h(
      "select",
      {
        class: "dropdown plugin-catalog-version",
        attrs: { "aria-label": t("Version"), disabled: true },
      },
      latestOption,
    );
    const versionInfo = h("div", {
      class: "setting-item-description",
      text: t("Versionen werden geladen …"),
    });
    const versionNote = h("p", {
      class: "plugin-warning plugin-catalog-compat",
      attrs: { hidden: true },
    });
    const pickedRelease = () =>
      picker.value
        ? listed.find((release) => release.tag === picker.value)
        : listed.find((release) => !release.prerelease);
    /** Button text and notes for the release currently picked. */
    const syncChoice = () => {
      const release = pickedRelease();
      const order =
        version && release && picker.value
          ? compareVersions(release.version, version)
          : 1;
      action.textContent = !version
        ? t("Installieren")
        : order < 0
          ? t("Version wechseln")
          : order === 0
            ? t("Installiert")
            : t("Aktualisieren");
      action.disabled = !app.compatibility || order === 0;
      if (release)
        versionInfo.textContent = releaseDetail(
          release,
          version,
          entry.verified,
          !picker.value,
        );
      versionNote.textContent =
        release && !supportsMinAppVersion(release.minAppVersion)
          ? t(
              "Braucht Obsidian {min}, Basalt bietet die Schnittstelle von {api}. Das Plugin startet womöglich nicht oder nur teilweise.",
              { min: release.minAppVersion ?? "", api: API_VERSION },
            )
          : "";
      versionNote.hidden = !versionNote.textContent;
    };
    picker.addEventListener("change", () => {
      chosen.set(entry.id, picker.value);
      syncChoice();
    });
    syncChoice();
    void pluginReleases(entry.repo).then(
      (list) => {
        if (selected !== entry || !modal.isOpen) return;
        listed = list;
        const latest = list.find((release) => !release.prerelease);
        if (latest)
          latestOption.textContent = t("Neueste ({version})", {
            version: latest.version,
          });
        else versionInfo.textContent = "";
        picker.append(
          ...list.map((release) =>
            h("option", {
              text: releaseLabel(release, version),
              attrs: { value: release.tag },
            }),
          ),
        );
        picker.value = list.some((release) => release.tag === tag) ? tag : "";
        picker.disabled = list.length === 0;
        syncChoice();
      },
      (error) => {
        if (selected !== entry || !modal.isOpen) return;
        versionInfo.textContent = t(
          "Ältere Versionen konnten nicht geladen werden: {error}",
          { error: errorMessage(error) },
        );
      },
    );
    action.addEventListener("click", () => {
      const pick = picker.value;
      action.disabled = true;
      action.textContent = t("Wird geladen …");
      void downloadRelease(entry.repo, request, entry.id, pick || undefined)
        .then(async (files) => {
          const order = version
            ? compareVersions(files.manifest.version, version)
            : 1;
          // "Latest" only ever updates; an explicitly picked release may
          // also go back to an older version.
          if (version && (pick ? order === 0 : order <= 0)) {
            notify(
              t("„{name}“ ist bereits aktuell ({version}).", {
                name: entry.name,
                version,
              }),
            );
            return;
          }
          if (await install(app, files, { repo: entry.repo }, entry.verified)) {
            installed.set(entry.id, files.manifest.version);
            changed();
          }
        })
        .catch((error) => app.report(error))
        .finally(() => {
          if (modal.isOpen) {
            renderList();
            renderDetails();
          }
        });
    });
    details.replaceChildren(
      h(
        "button",
        {
          class: "plugin-catalog-back",
          attrs: { type: "button" },
          on: {
            click: () => {
              selected = null;
              modal.modalEl.classList.remove("is-previewing");
              renderList();
              renderDetails();
            },
          },
        },
        icon("chevron-left", 16),
        t("Zurück"),
      ),
      h("h3", { class: "plugin-catalog-name", text: entry.name }),
      h(
        "div",
        "plugin-catalog-facts",
        trustBadge(entry),
        h("span", { text: t("von {author}", { author: entry.author || "?" }) }),
        entry.downloads
          ? h("span", {
              text: t("{count} Downloads", {
                count: formatCount(entry.downloads),
              }),
            })
          : null,
        version
          ? h("span", { text: t("Installiert: {version}", { version }) })
          : null,
      ),
      h("p", { class: "plugin-catalog-description", text: entry.description }),
      h("p", {
        class: "plugin-catalog-note",
        text: [
          entry.verified
            ? t("Mit Basalt geprüft (Version {version})", {
                version: entry.verified,
              })
            : t(
                "Nicht mit Basalt geprüft: kann funktionieren, teilweise funktionieren oder sichtbar scheitern.",
              ),
          app.compatibility
            ? ""
            : t("Plugins lassen sich nur in der nativen App installieren."),
        ]
          .filter(Boolean)
          .join(" "),
      }),
      h(
        "div",
        "plugin-catalog-install",
        h(
          "div",
          "setting-item",
          h(
            "div",
            "setting-item-info",
            h("div", { class: "setting-item-name", text: t("Version") }),
            versionInfo,
          ),
          h("div", "setting-item-control", picker),
        ),
        versionNote,
      ),
      h(
        "div",
        "modal-button-container",
        h(
          "button",
          {
            attrs: { type: "button" },
            on: {
              click: () => app.openExternal(`https://github.com/${entry.repo}`),
            },
          },
          t("Repository-Link kopieren"),
        ),
        action,
      ),
    );
  };

  search.addEventListener("input", () => {
    shown = searchCatalog(entries, search.value);
    limit = PAGE;
    renderList();
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...list.querySelectorAll<HTMLElement>(".plugin-catalog-row")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    rows[
      Math.max(
        0,
        Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
      )
    ]?.focus();
  });

  modal.open();
  search.focus();
  renderDetails();
  void (async () => {
    try {
      const session = app.compatibility;
      if (session)
        for (const listing of await session.bundleHost.list())
          if (listing.manifest)
            installed.set(listing.id, listing.manifest.version);
      entries = await pluginCatalog();
      if (!modal.isOpen) return;
      shown = searchCatalog(entries, search.value);
      renderList();
    } catch (error) {
      status.textContent = t(
        "Der Katalog konnte nicht geladen werden: {error}",
        { error: errorMessage(error) },
      );
    }
  })();
}

/** Installs the latest release of any GitHub repository, such as your own plugin. */
export function promptGithubInstall(app: App, changed: () => void): void {
  const modal = new Modal("mod-plugin-github");
  modal.setTitle(t("Plugin von GitHub installieren"));
  const input = h("input", {
    attrs: {
      type: "text",
      placeholder: "owner/repository",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": t("GitHub-Repository"),
    },
  });
  const error = h("p", {
    class: "field-error",
    attrs: { role: "alert", hidden: true },
  });
  const submit = h("button", {
    class: "mod-cta",
    text: t("Weiter"),
    attrs: { type: "submit" },
  });
  const form = h(
    "form",
    { attrs: { novalidate: true } },
    h("p", {
      class: "modal-description",
      text: t(
        "Für eigene Plugins und solche, die nicht im Katalog stehen. Basalt lädt manifest.json, main.js und styles.css aus dem neuesten Release.",
      ),
    }),
    input,
    error,
    h(
      "div",
      "modal-button-container",
      h("button", {
        text: t("Abbrechen"),
        attrs: { type: "button" },
        on: { click: () => modal.close() },
      }),
      submit,
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const repo = parseRepo(input.value);
    if (!repo) {
      error.textContent = t(
        "Bitte „owner/repository“ oder eine GitHub-Adresse angeben.",
      );
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    error.hidden = true;
    void (async () => {
      try {
        const files = await downloadRelease(repo, request);
        const entry = (await pluginCatalog().catch(() => [])).find(
          (item) => item.id === files.manifest.id,
        );
        modal.close();
        if (await install(app, files, { repo }, verifiedVersion(entry, repo)))
          changed();
      } catch (reason) {
        error.textContent = errorMessage(reason);
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    })();
  });
  modal.contentEl.append(form);
  modal.open();
  input.focus();
}

/** Installs a plugin from picked files: manifest.json, main.js and an optional styles.css. */
export async function installFromFiles(
  app: App,
  picked: FileList | File[],
  changed: () => void,
): Promise<void> {
  const byName = new Map(
    [...picked].map((file) => [file.name.toLowerCase(), file]),
  );
  const manifest = byName.get("manifest.json");
  const main = byName.get("main.js");
  if (!manifest || !main) {
    notify(t("Bitte mindestens manifest.json und main.js auswählen."), true);
    return;
  }
  try {
    const files = validatePluginFiles(
      await manifest.text(),
      await main.text(),
      (await byName.get("styles.css")?.text()) ?? null,
    );
    if (await install(app, files, null, null)) changed();
  } catch (error) {
    app.report(error);
  }
}

/** Newer releases of installed plugins, by id, for plugins whose repository is known. */
export async function findUpdates(
  app: App,
): Promise<Map<string, { repo: string; version: string }>> {
  const session = app.compatibility;
  const updates = new Map<string, { repo: string; version: string }>();
  if (!session) return updates;
  const known = new Map(
    (await pluginCatalog().catch(() => [])).map((entry) => [
      entry.id,
      entry.repo,
    ]),
  );
  const failures: unknown[] = [];
  await Promise.all(
    (await session.bundleHost.list()).map(async (listing) => {
      if (!listing.manifest) return;
      const repo =
        (await installedSource(session.configVault, listing.id))?.repo ??
        known.get(listing.id);
      if (!repo) return;
      try {
        const latest = await latestManifest(repo, request);
        if (
          latest.id === listing.id &&
          compareVersions(latest.version, listing.manifest.version) > 0
        )
          updates.set(listing.id, { repo, version: latest.version });
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  if (failures.length)
    console.warn("Some plugin updates could not be checked", failures);
  return updates;
}

/** Downloads and installs one update found by `findUpdates`. */
export async function updatePlugin(
  app: App,
  id: string,
  repo: string,
  changed: () => void,
): Promise<void> {
  const files = await downloadRelease(repo, request, id);
  const entry = (await pluginCatalog().catch(() => [])).find(
    (item) => item.id === id,
  );
  if (await install(app, files, { repo }, verifiedVersion(entry, repo)))
    changed();
}

/** Asks, stops the plugin and removes its files (they go to the vault trash). */
export function confirmUninstall(
  app: App,
  id: string,
  name: string,
  changed: () => void,
): void {
  const session = app.compatibility;
  if (!session) return;
  const modal = new Modal();
  modal.setTitle(t("Plugin deinstallieren"));
  const cancel = h("button", {
    text: t("Abbrechen"),
    attrs: { type: "button" },
    on: { click: () => modal.close() },
  });
  const submit = h("button", {
    class: "mod-warning",
    text: t("Deinstallieren"),
    attrs: { type: "button" },
  });
  submit.addEventListener("click", () => {
    submit.disabled = cancel.disabled = true;
    void (async () => {
      try {
        if (session.bundleHost.isEnabled(id)) {
          app.releasePluginUi();
          await session.bundleHost.disable(id);
        }
        await uninstallPlugin(session.configVault, id);
        app.pluginErrors.delete(id);
        session.saveEnabledPlugins();
        await session.refresh();
        app.refreshPluginUi();
        notify(t("„{name}“ wurde deinstalliert.", { name }));
        modal.close();
        changed();
      } catch (error) {
        app.report(error);
        submit.disabled = cancel.disabled = false;
      }
    })();
  });
  modal.contentEl.append(
    h("p", {
      text: t(
        "„{name}“ mit seinen Einstellungen entfernen? Die Dateien landen im Papierkorb des Vaults (.basalt/trash/).",
        { name },
      ),
    }),
    h("div", "modal-button-container", cancel, submit),
  );
  modal.open();
  cancel.focus();
}
