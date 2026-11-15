// Project page behaviour: language switch, decorative basalt columns, scroll
// reveal and the in-page demo launcher. The page is complete without this file;
// English is the markup, German lives in the table below.

const de = {
  title: "Basalt — ein ruhiger Ort für vernetzte Gedanken",
  description:
    "Basalt ist ein lokaler Markdown-Arbeitsbereich für Linux und Android, mit einem Rust-Kern und Unterstützung für Obsidian-Vaults und ausgewählte Obsidian-Plugins.",
  skip: "Zum Inhalt springen",
  "nav.features": "Funktionen",
  "nav.plugins": "Plugins",
  "nav.core": "Unter der Haube",
  "nav.download": "Download",
  "hero.chip": "Vorschau 0.4 · Linux &amp; Android · Open Source",
  "hero.title":
    'Ein ruhiger Ort für <span class="wikilink"><i>[[</i>vernetzte<i>]]</i></span> Gedanken.',
  "hero.lead":
    "Basalt ist ein lokaler Markdown-Arbeitsbereich für Linux und Android. Deine Notizen sind einfache Dateien in einem Ordner deiner Wahl, und bestehende Obsidian-Vaults lassen sich direkt öffnen.",
  "hero.download": "Basalt herunterladen",
  "hero.demo": "Im Browser ausprobieren",
  "hero.note": "Kein Konto. Keine Cloud. Keine Telemetrie.",
  "hero.alt":
    "Basalt auf dem Desktop: Dateibaum, eine Notiz in der Live-Vorschau mit Aufgabenliste, Formel und Tabelle, rechts die Rückverweise",
  "hero.launch": "Demo direkt hier starten",
  "hero.caption":
    "Das ist die echte App, keine Attrappe. Die Demo speichert ihre Notizen nur in deinem Browser.",
  "p1.title": "Deine Dateien bleiben deine Dateien",
  "p1.text":
    "Notizen sind einfaches Markdown in einem Ordner deiner Wahl. Kein Konto, keine Cloud, keine Telemetrie.",
  "p2.title": "Passt zu deinem Vault",
  "p2.text":
    "Wiki-Links, Tags, Frontmatter, Callouts, Einbettungen, Canvas-Dateien und Bases verhalten sich so, wie du es erwartest.",
  "p3.title": "Gebaut für Linux und Android",
  "p3.text":
    "Ein gemeinsamer Rust-Kern, eine native App und eine Oberfläche für Maus, Tastatur, Touch und Stift.",
  "p4.title": "Sorgsam mit deinen Daten",
  "p4.text":
    "Frühere Fassungen werden vor dem Überschreiben gesichert und lassen sich zurückholen. Änderungen von außen werden erkannt statt überschrieben.",
  "f1.title": "Markdown, das dir nicht im Weg steht",
  "f1.text":
    "In der Live-Vorschau tritt die Syntax beim Schreiben zurück. Links und Checkboxen sind anklickbar, Formeln, Diagramme und Tabellen erscheinen direkt im Editor. Maßgeblich bleibt das Markdown darunter.",
  "f1.a":
    "Vervollständigung für <code>[[Wiki-Links]]</code> und <code>#Tags</code>",
  "f1.b":
    "KaTeX-Formeln, Mermaid-Diagramme, Tabellen Zelle für Zelle bearbeiten",
  "f1.c":
    "Seitenvorschau, Vorlagen, Fußnoten, Einklappen, Vim-Tasten auf Wunsch",
  "f1.d":
    "Bearbeitbare Eigenschaften, eingefügte Bilder, Druck als PDF oder HTML",
  "f1.alt":
    "Links der Markdown-Quelltext, rechts dieselbe Notiz in der Live-Vorschau",
  "f1.source": "was du tippst",
  "f1.preview": "was du siehst",
  "f2.title": "Sieh, wie alles zusammenhängt",
  "f2.text":
    "Jeder Link funktioniert in beide Richtungen. Rückverweise zeigen den Satz um jede Erwähnung, und der Graph zeichnet deinen Vault als das, was er ist: ein Netz.",
  "f2.a":
    "Rückverweise mit Kontext und unverlinkte Erwähnungen, die zu Links werden",
  "f2.b":
    "Volltextsuche mit <code>tag:</code>, <code>path:</code> und <code>file:</code>",
  "f2.c": "Graph des ganzen Vaults oder lokaler Graph einer Notiz",
  "f2.d":
    "Benenne eine Notiz um oder verschiebe sie, und alle Links ziehen mit",
  "f2.alt":
    "Graphansicht: acht Notizen als verbundene Knoten, daneben die Filtereinstellungen",
  "f3.title": "Platz zum Ausbreiten",
  "f3.text":
    "Manche Gedanken sind keine Liste. Lege Notizen, Texte, Links und Gruppen auf eine endlose Canvas und verbinde sie mit Pfeilen.",
  "f3.a": "Gespeichert im offenen JSON-Canvas-Format (<code>.canvas</code>)",
  "f3.b": "Boards aus anderen Apps bleiben beim Speichern verlustfrei erhalten",
  "f3.c": "Maus, Touch und Stift, Zoomen mit zwei Fingern",
  "f3.alt":
    "Canvas mit Textkarten, eingebetteten Notizen und Pfeilen dazwischen",
  "f4.title": "Ein Arbeitsbereich, der sich dir anpasst",
  "f4.text":
    "Teile den Editor, docke Seitenansichten an, wo du sie brauchst, und halte eine zweite Notiz neben der ersten offen. Das Layout wird pro Vault gemerkt.",
  "f4.a": "Tabs mit eigenem Verlauf, geteilte Editoren, andockbare Ansichten",
  "f4.b":
    "Schnellauswahl <kbd>Strg</kbd> <kbd>O</kbd>, Befehlspalette <kbd>Strg</kbd> <kbd>P</kbd>",
  "f4.c": "Helles und dunkles Design mit einer Akzentfarbe deiner Wahl",
  "f4.d": "PDFs, Bilder, Audio und Video öffnen sich in eigenen Tabs",
  "f4.alt":
    "Zwei Notizen nebeneinander, in der Seitenleiste der lokale Graph der aktiven Notiz",
  "f5.title": "Derselbe Vault in der Hosentasche",
  "f5.text":
    "Die Android-App ist kein geschrumpfter Desktop. Sie hat ein eigenes Layout mit Schubladen, einer Leiste am unteren Rand und einer Formatierungsleiste über der Tastatur, und sie läuft auf demselben Rust-Kern.",
  "f5.a":
    "Öffnet einen Ordner, den du über den Android-Speicherzugriff auswählst",
  "f5.b": "Gemacht für Touch und Stift",
  "f5.c": "Ein universelles APK für ARM64 und x86_64",
  "f5.alt":
    "Basalt auf dem Handy: eine Notiz in der Leseansicht mit Navigationsleiste unten",
  "pl.title": "Bring deine Plugins mit. Vorerst die ausgewählten.",
  "pl.text":
    "Basalt bringt eine eigene Umsetzung der Obsidian-Plugin-API mit. Das Ziel ist verlässliche Unterstützung für ausgewählte Plugins statt eines vagen Versprechens für alle.",
  "pl.a.title": "Ein Katalog, und deine eigenen",
  "pl.a.text":
    "Durchsuche den Community-Katalog, installiere von GitHub oder aus eigenen Dateien. Nichts läuft, bevor du es aktivierst.",
  "pl.b.title": "Ehrlich bei Lücken",
  "pl.b.text":
    "Eine fehlende API schlägt sichtbar fehl, statt Erfolg vorzutäuschen. Plugins, die Node.js oder Electron brauchen, laufen nicht.",
  "pl.c.title": "Vertraut, nicht abgeschottet",
  "pl.c.text":
    "Plugin-Code läuft mit denselben Rechten wie die App. Aktiviere nur Plugins, denen du vertraust.",
  "pl.more": "Was geprüft ist und was nicht →",
  "c.title": "Fest bis auf den Grund",
  "c.text":
    "Basalt besteht aus drei Schichten mit schmalen Nähten dazwischen. Der Teil, der deine Dateien anfasst, ist eine kleine Rust-Bibliothek, die nichts von der Oberfläche weiß, und sie ist bewusst vorsichtig.",
  "c.a":
    "Dateizugriffe können den Vault-Ordner nicht verlassen, auch nicht über Symlinks",
  "c.b":
    "Beim Speichern wird mit dem geladenen Stand verglichen, nichts wird blind überschrieben",
  "c.c":
    "Vorher landet eine Sicherung in <code>.basalt/history/</code>; Gelöschtes in <code>.basalt/trash/</code>",
  "c.more": "Die Sicherheitsgrenzen nachlesen →",
  "c.aria": "Schichten der Architektur",
  "c.l1.title": "Oberfläche",
  "c.l1.text": "TypeScript ohne Framework, Editor auf CodeMirror 6",
  "c.l2.title": "Native Hülle",
  "c.l2.text": "Tauri 2, Befehle an den geöffneten Vault gebunden",
  "c.l3.title": "Vault-Kern",
  "c.l3.text": "Rust: geprüfte Pfade, Versionsabgleich, Sicherungen",
  "c.l4.text": "Dein Ordner mit Markdown-Dateien",
  "s.title": "Noch nicht ganz erkaltet",
  "s.text":
    "Basalt ist eine Vorschau (0.4) und noch kein vollständiger Ersatz für Obsidian. Der Kern ist stabil und getestet, aber ein paar Dinge fehlen:",
  "s.a": "keine eingebaute Synchronisation, Android-Updates noch per Download",
  "s.b": "Plugin-Unterstützung nur für ausgewählte Plugins",
  "s.c": "Sicherungen werden noch nicht automatisch aufgeräumt",
  "s.d":
    "nur Direktdownloads, noch kein Play Store und keine Distributionspakete",
  "s.tip":
    "Lege eine Kopie jedes wichtigen Vaults an, bevor du ihn zum ersten Mal öffnest.",
  "d.title": "Basalt holen",
  "d.text":
    "Frei und quelloffen. Signierte Pakete werden auf GitHub veröffentlicht.",
  "d.linux": "x86_64, als <code>.deb</code>-Paket oder AppImage.",
  "d.linux.btn": "Für Linux herunterladen",
  "d.android": "Ein universelles APK für ARM64 und x86_64.",
  "d.android.btn": "Für Android herunterladen",
  "d.verify": "Download überprüfen",
  "d.verify.text":
    'Alle Downloads sind signiert. Vergleiche sie mit diesen Fingerabdrücken, wie in den <a href="https://github.com/Nino4you/basalt/blob/main/docs/release-signing.md#verifying-downloads">Hinweisen zur Signierung</a> beschrieben.',
  "d.pgp": "OpenPGP (Linux-Pakete, Prüfsummen)",
  "d.cert": "Android-Zertifikat (SHA-256)",
  "d.demo": "Browser-Demo ausprobieren",
  "d.source": "Aus dem Quelltext bauen",
  "ft.tagline": "Ein ruhiger Ort für vernetzte Gedanken.",
  "ft.source": "Quelltext",
  "ft.issues": "Fehler melden",
  "ft.security": "Sicherheit",
  "ft.plugins": "Plugin-Kompatibilität",
  "ft.license": "Lizenz: MPL-2.0",
  "ft.notices": "Hinweise zu Drittsoftware",
  "ft.private":
    "Diese Seite lädt keine Schriften, Skripte oder Tracker von Dritten und setzt keine Cookies.",
  "ft.trademark":
    "„Obsidian“ ist eine Marke des jeweiligen Inhabers. Basalt ist ein unabhängiges Projekt und steht in keiner Verbindung zu Obsidian oder dessen Herstellern; der Name wird nur verwendet, um die Kompatibilität mit Obsidian-Vaults und -Plugins zu beschreiben.",
};

const root = document.documentElement;
root.classList.add("js");

/* ---------- Language ---------- */

const LANG_KEY = "basalt-site-lang";
// English is whatever the markup says; remember it so switching back works.
const english = new Map();
const metaDescription = document.querySelector('meta[name="description"]');
const translatable = [
  ["[data-i18n]", "i18n", (el) => el.innerHTML, (el, v) => (el.innerHTML = v)],
  ["[data-i18n-alt]", "i18nAlt", (el) => el.alt, (el, v) => (el.alt = v)],
  [
    "[data-i18n-aria]",
    "i18nAria",
    (el) => el.getAttribute("aria-label"),
    (el, v) => el.setAttribute("aria-label", v),
  ],
];
for (const [selector, key, read] of translatable)
  for (const el of document.querySelectorAll(selector))
    english.set(el.dataset[key], read(el));
english.set("title", document.title);
english.set("description", metaDescription.content);

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Storage can be blocked; the page works without it.
  }
}

let lang = "en";

function setLanguage(next, remember) {
  lang = next === "de" ? "de" : "en";
  const text = (key) => (lang === "de" && de[key]) || english.get(key);
  for (const [selector, key, , write] of translatable)
    for (const el of document.querySelectorAll(selector))
      write(el, text(el.dataset[key]));
  document.title = text("title");
  metaDescription.content = text("description");
  root.lang = lang;
  for (const button of document.querySelectorAll("[data-lang]"))
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  if (remember)
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // Not remembered, then.
    }
}

for (const button of document.querySelectorAll("[data-lang]"))
  button.addEventListener("click", () =>
    setLanguage(button.dataset.lang, true),
  );

setLanguage(
  stored(LANG_KEY) ??
    (navigator.language?.toLowerCase().startsWith("de") ? "de" : "en"),
);

/* ---------- Basalt columns ---------- */

/** Small deterministic generator, so the stone looks the same on every visit. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Columns from above: a field of hexagons with cracks between them. */
function drawHexfield() {
  const svg = document.querySelector(".hexfield");
  const { width, height } = svg.getBoundingClientRect();
  if (!width) return;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const next = random(7);
  const radius = width < 700 ? 24 : 32;
  const step = Math.sqrt(3) * radius;
  const inner = radius * 0.94;
  let markup = "";
  for (let row = 0, y = 0; y < height + radius; row++, y = row * radius * 1.5) {
    for (let x = row % 2 ? step / 2 : 0; x < width + step; x += step) {
      const points = [];
      for (let corner = 0; corner < 6; corner++) {
        const angle = (Math.PI / 3) * corner + Math.PI / 6;
        points.push(
          `${(x + inner * Math.cos(angle)).toFixed(1)},${(y + inner * Math.sin(angle)).toFixed(1)}`,
        );
      }
      const lit = next() < 0.045;
      const style = lit
        ? `--d:-${(next() * 7).toFixed(1)}s`
        : `--o:${(0.012 + next() * 0.04).toFixed(3)}`;
      markup += `<polygon${lit ? ' class="lit"' : ""} style="${style}" points="${points.join(" ")}"/>`;
    }
  }
  svg.innerHTML = markup;
}

/** Columns from the side: the skyline above the footer. */
function drawColumns() {
  const host = document.querySelector(".columns");
  const next = random(23);
  let height = 55;
  let markup = "";
  for (let index = 0; index < 120; index++) {
    // A random walk reads as stepped rock; pure noise would read as a bar chart.
    height = Math.min(100, Math.max(18, height + (next() - 0.5) * 50));
    markup += `<i style="--h:${height.toFixed(0)}%"></i>`;
  }
  host.innerHTML = markup;
}

drawHexfield();
drawColumns();

let resizeTimer;
let lastWidth = innerWidth;
addEventListener("resize", () => {
  if (innerWidth === lastWidth) return; // Mobile address bars resize the height only.
  lastWidth = innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawHexfield, 150);
});

/* ---------- Reveal on scroll ---------- */

const revealed = document.querySelectorAll(
  ".pillar, .feature-text, .feature-art, .card, .strata li, .status-box",
);
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of revealed) {
    el.classList.add("reveal");
    observer.observe(el);
  }
}

/* ---------- Demo ---------- */

/**
 * The demo shares this origin's localStorage. Visitors who have no demo data
 * yet get the showcase vault from the screenshots instead of the built-in
 * notes; existing data and settings are never touched.
 */
async function seedDemo() {
  try {
    const { vault, accent, workspace } = await import("./showcase-vault.js");
    if (!localStorage.getItem("basalt-demo-v1")) {
      localStorage.setItem("basalt-demo-v1", JSON.stringify(vault));
      if (!localStorage.getItem(workspace.key))
        localStorage.setItem(workspace.key, JSON.stringify(workspace.value));
    }
    if (!localStorage.getItem("basalt-settings"))
      localStorage.setItem(
        "basalt-settings",
        JSON.stringify({ language: lang, theme: "dark", accent }),
      );
  } catch {
    // Without storage the demo still starts, with its built-in notes.
  }
}

for (const link of document.querySelectorAll("[data-demo-link]"))
  link.addEventListener("click", async (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    await seedDemo();
    location.href = link.href;
  });

const launch = document.querySelector("[data-demo-launch]");
launch.addEventListener("click", async () => {
  await seedDemo();
  const frame = document.createElement("iframe");
  frame.src = "demo/";
  frame.title = lang === "de" ? "Basalt Live-Demo" : "Basalt live demo";
  const figure = launch.closest("figure");
  figure.replaceChildren(frame);
  frame.focus();
});
