<div align="center">

<img src="public/basalt.svg" width="96" alt="Basalt-Logo" />

# Basalt

**Ein ruhiger Ort für vernetzte Gedanken.**

Lokaler Markdown-Arbeitsraum für Linux und Android, mit Rust-Kern und
Unterstützung für Obsidian-Vaults und ausgewählte Obsidian-Plugins.

[![Lizenz: MPL-2.0](https://img.shields.io/badge/Lizenz-MPL--2.0-blue.svg)](LICENSE)
![Plattformen: Linux | Android](https://img.shields.io/badge/Plattformen-Linux%20%7C%20Android-informational)
![Status: Vorschau](https://img.shields.io/badge/Status-Vorschau%200.2-orange)

[Funktionen](#funktionen) · [Installation](#installation) · [Plugins](#plugins) ·
[Selbst bauen](#selbst-bauen) · [Mitmachen](#mitmachen)

![Basalt auf dem Desktop: Dateibaum, Tabs, Editor mit Live-Vorschau und Rückverweise](screenshots/01-desktop-dark.png)

</div>

## Warum Basalt?

- **Deine Dateien bleiben deine Dateien.** Notizen sind normale Markdown-Dateien in einem
  Ordner deiner Wahl. Kein Konto, keine Cloud, keine Telemetrie.
- **Kompatibel mit deinem Vault.** Wiki-Links, Tags, Frontmatter, Callouts, Einbettungen und
  Canvas-Dateien funktionieren wie gewohnt; bestehende Obsidian-Vaults lassen sich direkt öffnen.
- **Gebaut für Linux und Android.** Ein gemeinsamer Rust-Kern, eine native Tauri-App für beide
  Plattformen und eine Oberfläche, die sich an Maus, Tastatur, Touch und Stift anpasst.
- **Vorsichtig mit deinen Daten.** Jede Änderung wird vor dem Speichern gesichert, externe
  Änderungen werden erkannt statt überschrieben, und der Dateizugriff ist auf den Vault begrenzt.

## Funktionen

**Schreiben**

- CodeMirror-6-Editor mit Live-Vorschau: Markdown-Zeichen treten zurück, Links und Checkboxen
  sind klickbar, KaTeX-Formeln, Mermaid-Diagramme und Tabellen werden direkt im Editor
  dargestellt. Tabellen bearbeitest du Zelle für Zelle; das Markdown bleibt die Quelle.
- Vervollständigung für `[[Wiki-Links]]` und `#Tags`, Seitenvorschau beim Überfahren von Links,
  Vorlagen mit Titel- und Datumsplatzhaltern, Quelltextmodus.
- Leseansicht mit Callouts, Eigenschaften, Notiz-Einbettungen und Syntaxhervorhebung.
- PDFs, Bilder, Audio und Video öffnen in eigenen Tabs; PDFs werden lokal gerendert.

**Organisieren**

- Dateibaum mit Ordnern, Lesezeichen, Drag & Drop und sicherem Umbenennen, bei dem offene
  Tabs, Lesezeichen und ungespeicherte Änderungen mitwandern.
- Rückverweise mit Kontext, ausgehende Links, Tags, Gliederung und Volltextsuche
  (`tag:`, `path:`, `file:`, Ausschluss mit `-`).
- Graphansicht für den ganzen Vault und als lokaler Graph der aktiven Notiz, mit Gruppenfarben.
- Canvas im offenen JSON-Canvas-Format (`.canvas`) mit Text-, Notiz-, Link- und Gruppenkarten.

**Arbeitsfläche**

- Tabs mit eigenem Verlauf, geteilte Editoren und frei andockbare Seitenansichten wie in
  VS Code; das Layout bleibt pro Vault gespeichert.
- Schnellauswahl (Strg+O), Befehlspalette (Strg+P) und durchgehende Tastaturbedienung.
- Helles und dunkles Design mit Akzentfarbe; auf dem Handy ein eigenes Layout mit Schubladen,
  unterer Navigationsleiste und Formatierungsleiste.

<p align="center">
  <img src="screenshots/02-mobile-dark.png" width="300" alt="Basalt auf dem Handy: Leseansicht mit unterer Navigationsleiste" />
</p>

## Installation

Fertige Pakete erscheinen unter [Releases](https://github.com/Nino4you/basalt/releases):

| Plattform                      | Paket                                    |
| ------------------------------ | ---------------------------------------- |
| Linux x86_64                   | `.deb` oder AppImage                     |
| Android (ARM64, ARMv7, x86_64) | `Basalt_<version>_android-universal.apk` |

Alle Downloads sind signiert. Bitte prüfe sie gegen diese Fingerabdrücke, wie in
[docs/release-signing.md](docs/release-signing.md#downloads-prüfen) beschrieben:

| Schlüssel                          | Fingerabdruck                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| OpenPGP (Linux-Pakete, Prüfsummen) | `628F A944 F494 AED2 1F0B  6CCD B72F F2A2 4F65 FB22`                                              |
| Android-Zertifikat (SHA-256)       | `C0:3E:FA:2F:40:12:C4:57:FC:44:D7:68:B2:64:AA:BF:0F:2D:54:D3:3B:C3:06:7B:8C:6D:1B:76:84:83:4A:51` |

Zum Ausprobieren ohne Installation gibt es eine Browser-Demo: `npm ci && npm run dev`
(siehe [Selbst bauen](#selbst-bauen)). Sie speichert nur im Browser, nicht in echten Dateien.

## Status

Basalt ist eine **Vorschau (0.2)** und noch kein vollständiger Ersatz für Obsidian. Der Kern
ist stabil und getestet, aber einige Dinge fehlen noch:

- kein automatisches Update und kein eingebauter Sync,
- Plugin-Kompatibilität nur für ausgewählte Plugins (siehe unten),
- Sicherungen aus `.basalt/history/` und `.basalt/trash/` stellst du derzeit von Hand wieder her,
- kein Play-Store- oder Distributionspaket, nur direkte Downloads.

Mach vor dem ersten Öffnen eines wichtigen Vaults eine Kopie.

## Plugins

Basalt bringt eine eigene Umsetzung der Obsidian-Plugin-API mit. Plugins liegen im Vault unter
`Basalt/Plugins/<id>/` (`manifest.json`, `main.js`, optional `styles.css`) und laufen erst,
nachdem du sie in den Einstellungen einzeln aktiviert hast.

> [!WARNING]
> Plugin-Code läuft ohne Sandbox mit denselben Rechten wie die App. Aktiviere nur Plugins,
> denen du vertraust.

Ziel ist eine gute Unterstützung ausgewählter Plugins, nicht jedes Community-Plugins. Welche
Plugins und APIs geprüft sind und wo es noch Lücken gibt, steht in
[docs/plugin-compatibility.md](docs/plugin-compatibility.md). Plugins, die Node.js- oder
Electron-APIs voraussetzen, laufen nicht.

## Selbst bauen

Voraussetzungen: Node.js 22.13+ und aktuelles stabiles Rust. Für die native App zusätzlich die
[Tauri-Systemabhängigkeiten](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run dev              # Browser-Demo auf http://127.0.0.1:1420
npm run tauri -- dev     # native Linux-App
npm run tauri -- build   # Linux-Pakete (.deb, AppImage)
```

Android braucht zusätzlich JDK, Android SDK/NDK und das Rust-Ziel `aarch64-linux-android`:

```sh
npm run tauri -- android init --ci --skip-targets-install
node tools/patch_android.mjs
npm run tauri -- icon public/basalt.svg
npm run tauri -- android build --apk --debug --target aarch64
```

Tests:

```sh
npm test                                  # Frontend (Vitest)
npx playwright install chromium && npm run test:e2e
cargo test --workspace --locked           # Rust-Kern
cargo clippy --workspace --all-targets --locked -- -D warnings
```

## Aufbau

| Bereich              | Aufgabe                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `crates/vault-core/` | UI-unabhängiger Rust-Kern: Pfade, Speicher, Konfliktprüfung       |
| `crates/vault-cli/`  | Kommandozeilen-Client für den Kern                                |
| `src-tauri/`         | Native Shell, auf den Vault begrenzte IPC, Android-Speicher (SAF) |
| `src/`               | Oberfläche, Editor, Ansichten und Plugin-Kompatibilitätsschicht   |
| `tools/`             | Android-Patch, Smoke-Tests und Release-Skripte                    |

Mehr Details: [Sicherheitsgrenzen](SECURITY.md), [Plugin-Kompatibilität](docs/plugin-compatibility.md),
[Release-Signatur](docs/release-signing.md).

## Mitmachen

Fehlerberichte und Vorschläge sind über [Issues](https://github.com/Nino4you/basalt/issues)
willkommen. Für Pull Requests gilt: Vor dem Einreichen sollten `npm run build`, `npm test`,
`cargo fmt --all -- --check`, `cargo test --workspace` und `cargo clippy` grün sein.
Sicherheitslücken bitte nicht öffentlich melden, sondern wie in [SECURITY.md](SECURITY.md)
beschrieben.

## Lizenz

Basalt steht unter der [Mozilla Public License 2.0](LICENSE). Änderungen an Basalt-Dateien
müssen bei Weitergabe unter derselben Lizenz offengelegt werden; Plugins und andere Programme,
die Basalt nutzen, dürfen eine eigene Lizenz haben. Mitgelieferte Abhängigkeiten behalten ihre
Lizenzen, siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

„Obsidian“ ist eine Marke ihres jeweiligen Inhabers. Basalt ist ein unabhängiges Projekt und
steht in keiner Verbindung zu Obsidian oder dessen Herstellern; der Name wird nur verwendet, um
die Kompatibilität mit Obsidian-Vaults und -Plugins zu beschreiben.
