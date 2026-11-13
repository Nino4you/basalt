# Basalt

**Ein ruhiger Ort für vernetzte Gedanken.** Lokaler Markdown-Arbeitsraum mit gemeinsamem
Rust-Kern für **Linux und Android**. Eigenständige Neuimplementierung, kein Obsidian-Fork.

**[Erste Einblicke: Desktop und mobiles Layout](screenshots/)** · Aufnahmen der Browser-Demo.

![Basalt – Desktop-Vorschau der Browser-Demo](screenshots/01-desktop-dark.png)

> **Entwicklungsversion 0.2.0, kein fertiger Obsidian-Ersatz.** Ein opt-in CommonJS-Loader
> führt lokale Bundles aus `Basalt/Plugins/<id>` aus. Die Kompatibilität ist auf
> ausgewählte Plugins ausgerichtet und noch nicht vollständig auf Geräten nachgewiesen. Android- und Linux-Builds sind erst
> nach erfolgreichem CI-Lauf verfügbar.

## Bereits implementiert

- Rust-Vault-Kern: Markdown-Dateien auflisten, lesen, anlegen und durchsuchen.
- Dateisystemzugriff auf den ausgewählten Vault begrenzt; Tests gegen Pfad- und Symlink-Ausbrüche.
- Speichern mit Konflikterkennung und vorheriger Sicherung unter `.basalt/history/`.
- Dateien über das Kontextmenü oder „Weitere Optionen“ nach Bestätigung in den
  Vault-Papierkorb verschieben. Notizentwürfe werden vorher gespeichert; externe
  Änderungen brechen das Löschen ab. Sicherungen unter `.basalt/trash/` müssen
  derzeit manuell wiederhergestellt werden. Plugin-Dateien vorher speichern.
- Tauri-2-Shell für Linux und Android. Android-Vault-Auswahl über Storage Access Framework.
- Arbeitsfläche im Stil von Obsidian: Ribbon, einklappbare und in der Breite verstellbare
  Seitenleisten, Notizen in Tabs mit Verlauf (zurück/vor), Dateibaum mit Ordnern,
  Lesezeichen und Kontextmenüs. Geöffnete Tabs werden pro Vault wiederhergestellt.
- Frei andockbare Ansichten wie in VS Code: Dateiexplorer, Suche, Lesezeichen, Rückverweise,
  ausgehende Links, Tags und Gliederung lassen sich per Drag & Drop (oder über das
  Kontextmenü ihres Tabs) in die linke oder rechte Seitenleiste und in einen unteren Bereich
  verschieben und umsortieren. Beim Ziehen zeigt eine Vorschau genau die Fläche, in der die
  Ansicht landet. Das Layout bleibt gespeichert; auf dem Handy erscheinen unten angedockte
  Ansichten in der rechten Schublade.
- Dateien lassen sich im Dateiexplorer per Drag & Drop (oder über „Verschieben nach …“ im
  Kontextmenü) in einen anderen Ordner verschieben sowie per „Umbenennen“ im Kontextmenü,
  Tab-Menü oder mit F2 umbenennen. Geöffnete Tabs, Lesezeichen und ungespeicherte
  Änderungen wandern mit; vorhandene Dateien werden nie überschrieben.
- Geteilter Editor wie in VS Code: Ein Tab lässt sich an den Rand einer Editorgruppe ziehen,
  um sie nach links, rechts, oben oder unten zu teilen, oder in eine andere Gruppe
  verschieben; „Editor nach rechts/unten teilen“ öffnet die aktuelle Notiz ein zweites Mal.
  Bearbeitet wird in der fokussierten Gruppe, die anderen zeigen ihre Notiz mit – ein Klick
  wechselt hinüber. Canvas- und Plugin-Ansichten sind nur in der fokussierten Gruppe aktiv.
- CodeMirror-6-Editor mit Live-Vorschau (Markdown-Zeichen verschwinden abseits des Cursors,
  klickbare Links und Checkboxen, KaTeX-Formeln, Mermaid-Diagramme und gerenderte Tabellen).
  Formeln und Diagramme zeigen beim Bearbeiten ihren Quelltext; bei Tabellen wird nur die
  angeklickte Zelle editierbar. Tab/Shift+Tab wechseln die Zelle, Enter/Escape beenden die
  Eingabe; Undo/Redo und Autosave arbeiten weiter auf dem Markdown. Dazu Quellcode-Modus und Vervollständigung für
  `[[Wiki-Links]]` und `#Tags`.
- Seitenvorschau mit Textauszug beim Überfahren interner Links in Editor und Leseansicht.
- Leseansicht mit aufklappbaren Callouts, Tags, Eigenschaften (Frontmatter), Notiz-Einbettungen,
  eingebetteten PDF-/Audio-/Video-Dateien, KaTeX-Formeln, Mermaid-Diagrammen und
  Syntaxhervorhebung (u. a. Java, Python, SQL, Bash, PowerShell).
- PDFs, Bilder, Audio und Video öffnen direkt in einem eigenen Anhang-Tab statt im Texteditor;
  nicht unterstützte Binärformate zeigen eine klare Meldung. PDFs werden lokal mit lazy
  geladenem PDF.js gerendert, mit Seitennavigation und auswählbarem Text auch in Einbettungen.
  Kein externer PDF-Dienst; passwortgeschützte Dateien und PDF-Formulare sind noch nicht unterstützt.
- Vorlagen aus `_templates` einfügen, mit `{{title}}`, `{{date}}`/`{{time}}` und eigenen Datumsformaten.
- Rückverweise mit Kontext, ausgehende Links, Tag-Übersicht, Gliederung, Volltextsuche
  (`tag:`, `path:`, `file:`, Ausschluss mit `-`), Schnellauswahl (Strg+O) und
  Befehlspalette (Strg+P).
- Graphansicht aller Notizen und ihrer Links (Filter, optional Tags und unaufgelöste Links,
  Zoom per Mausrad oder Zwei-Finger-Geste) sowie ein lokaler Graph der aktiven Notiz in der
  rechten Seitenleiste.
- Helles/dunkles Farbschema mit wählbarer Akzentfarbe, mobiles Layout mit Schubladen und
  unterer Navigationsleiste, Tastaturbedienung und Markdown-Export.
- Lokale Entwurfswiederherstellung mit Erhalt der ursprünglichen Konfliktbasis.
- Canvas: unendliche Fläche im offenen JSON-Canvas-Format (`.canvas`, kompatibel mit
  Obsidian) mit Text-, Notiz-, Link- und Gruppenkarten, Verbindungen mit Beschriftung,
  Farben, Rückgängig/Wiederholen sowie Maus-, Stift- und Touch-Bedienung (Doppeltippen,
  Ziehen, Zwei-Finger-Zoom). Notizkarten zählen als Rückverweise; unlesbare Dateien
  werden nur angezeigt und nie überschrieben.
- Opt-in-Plugin-Loader: validierte Manifeste, CommonJS-Wrapper, gemeinsame
  CodeMirror-Instanzen, Lifecycle-Cleanup und explizite Aktivierung.
- Plugin-Beiträge in der Oberfläche: Befehle in der Befehlspalette, Ribbon- und
  Statusleisten-Elemente, Einstellungstabs, Markdown-Codeblöcke und registrierte Datei-Views.
- Vault-Adapter für gängige Plugin-Pfade; `.obsidian/plugins/<id>` wird auf den sichtbaren
  Ordner `Basalt/Plugins/<id>` abgebildet.
- Automatisierte Core-, Frontend-, Plugin- und Browser-Tests; getrennte Linux-/Android-CI-Builds.

## Entwickeln

Voraussetzungen: Node.js 22.13+ (oder 24+), aktuelle stabile Rust-Version. Für die native App zusätzlich
die [Tauri-Systemabhängigkeiten](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run dev              # ausdrücklich Browser-Demo: localStorage statt echter Vault-Dateien
npm run build
npm test
npx playwright install chromium
npm run test:e2e

cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo run -p vault-cli -- list examples/demo-vault
cargo run -p vault-cli -- search examples/demo-vault Android

npm run tauri -- dev     # native Linux-App
npm run tauri -- build
```

Android benötigt JDK, Android SDK/NDK und das Rust-Ziel `aarch64-linux-android`:

```sh
npm run tauri -- android init --ci --skip-targets-install
npm run tauri -- icon public/basalt.svg
npm run tauri -- android build --apk --debug --target aarch64
```

Die CI stellt Linux-Pakete und ein **debug-signiertes Android-Test-APK** als Actions-Artefakte
bereit, sofern die entsprechenden Jobs erfolgreich sind. Kein Play-Store-Release und keine
Produktionssignatur. Keine Zugangsdaten oder Signierschlüssel im Repository.

Für Push-Builds verwendet die CI eine feste Entwicklungs-Signatur aus dem Repository-Secret
`ANDROID_DEBUG_KEYSTORE`, damit Test-Updates nicht bei jedem Build einen anderen Schlüssel erhalten.
Die APK enthält ARM64 sowie x86_64 für Emulator-Tests. Das ist weiterhin keine Produktionssignatur.

Produktiv signierte Releases (Android-APK/AAB mit Release-Schlüssel, OpenPGP-signierte
Linux-Pakete und `SHA256SUMS`) entstehen getrennt davon über den Tag-Workflow
`.github/workflows/release.yml`. Einrichtung der Schlüssel und Secrets, Release-Ablauf und
Prüfung der Downloads: [docs/release-signing.md](docs/release-signing.md).

Signaturschlüssel der Releases (Downloads müssen zu diesen Fingerabdrücken passen):

| Schlüssel                          | Fingerabdruck                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| OpenPGP (Linux-Pakete, Prüfsummen) | `628F A944 F494 AED2 1F0B  6CCD B72F F2A2 4F65 FB22`                                              |
| Android-Zertifikat (SHA-256)       | `C0:3E:FA:2F:40:12:C4:57:FC:44:D7:68:B2:64:AA:BF:0F:2D:54:D3:3B:C3:06:7B:8C:6D:1B:76:84:83:4A:51` |

Ein Emulator-Test prüft die echte Android-WebView einschließlich Rust-IPC und Dateispeicherung;
die Browser-Layout-Tests sind davon getrennt. Linux erhält zusätzlich einen nativen Starttest.

## Architektur und Plugins

| Bereich              | Aufgabe                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `crates/vault-core/` | UI-unabhängiger Rust-Kern und Storage-Vertrag                         |
| `crates/vault-cli/`  | Direkt testbarer Kommandozeilen-Client                                |
| `src-tauri/`         | Native Shell, auf Vaults begrenzte IPC-Kommandos, Android-SAF-Backend |
| `src/`               | WebView-Oberfläche, CodeMirror 6, Vorschau, Entwürfe                  |
| `tools/`             | Android-Patch, Smoke-Tests und Release-Skripte                        |

Bestehende JavaScript-Plugins benötigen Obsidian-kompatible Klassen, Workspace-/Vault-Events,
DOM-Hilfsmethoden und Editor-Integration. Eine WebView allein stellt das nicht bereit.
Die Zielarchitektur bleibt deshalb **Rust-Kern + WebView + explizite Kompatibilitätsschicht**,
nicht eine ausschließlich native Rust-Oberfläche.

Ein Bundle wird nur nach ausdrücklicher Aktivierung in den Einstellungen ausgeführt. Es liegt
unter `Basalt/Plugins/<id>/` mit `manifest.json`, `main.js` und optional `styles.css`.
Plugin-Code erhält DOM-, Netzwerk- und Tauri-Zugriff; das ist keine Sandbox. Deshalb ist
`'unsafe-eval'` in der CSP ausschließlich für dieses lokale Vertrauensmodell nötig.

Details: [Plugin-Kompatibilität](docs/plugin-compatibility.md), [Sicherheitsgrenzen](SECURITY.md).

## Lizenz

Basalt steht unter der [Mozilla Public License 2.0](LICENSE) (`MPL-2.0`). Änderungen an
Basalt-Dateien müssen bei Weitergabe unter derselben Lizenz offengelegt werden; Plugins und
andere Programme, die Basalt nutzen oder mit ihm gebündelt werden, dürfen eine eigene Lizenz
haben. Mitgelieferte Abhängigkeiten behalten ihre jeweiligen Lizenzen; die Liste und die
Lizenztexte stehen in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

„Obsidian“ ist eine Marke ihres jeweiligen Inhabers. Basalt ist ein unabhängiges Projekt und
steht in keiner Verbindung zu Obsidian oder dessen Herstellern; der Name wird nur verwendet, um
die Kompatibilität mit Obsidian-Vaults und -Plugins zu beschreiben.
