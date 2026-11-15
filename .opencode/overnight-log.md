# Overnight: Community-Plugin-Kompatibilität

## Auftrag / Start 2026-11-15

- Nutzerziel: alle 100 Plugins aus dem vorhandenen Massentest ohne Fehler durch den echten Aktivieren/Notiz/Einstellungen/Deaktivieren-Zyklus bringen. Die zwei Berichte unter Downloads sind der Stand VOR PR #19/#23/#24 (24 sauber, 11 mit Fehlern, 65 nicht startfähig; API 525/762).
- Branch `overnight/2026-11-15`, Basis `ab009f737586636496b7c2ca57a6a6c73670547e` (next nach allen drei PRs).
- Ausdrückliche Nutzerregel: öffentliches Repo. Keine privaten Daten, privaten E-Mail-Adressen, Credentials, echten Vault-Inhalte oder identifizierenden lokalen Pfade in Commits, PRs, Issues, Berichten oder Screenshots. Nur synthetische Daten, relative Pfade und GitHub-noreply-Metadaten; vor jedem Commit/Veröffentlichen prüfen. Dauerhaft auch in AGENTS.md und CONSTRAINTS.md festgehalten.
- Keine Rückfragen im explizit gewünschten Overnight-Modus. Annahme: gemeinsame Host-APIs implementieren, unveränderte Release-Bundles prüfen; keine plugin-spezifischen Quelltext-Patches oder Attrappen zum Bestehen.
- Nur lokale Commits; KEIN Push, PR, Release oder Deployment. Keine globalen Installationen, kostenpflichtigen APIs, echten Vaults oder persönlichen Plugin-Einstellungen.
- Sicherheitsgrenzen aus AGENTS.md und SECURITY.md gelten weiter: kein freies Node/fs/child_process/Electron, keine breiten Resource-URLs, keine Abschwächung der CSP/Versionschecks/Backups.
- Ziel 100/100 bleibt bestehen. Plugins, die echte Systemprozesse/Server benötigen, bleiben ehrlich als Fehler/Blocker sichtbar, bis eine sichere echte Lösung existiert; niemals als bestanden umklassifizieren.

## Baseline

- Frisch unmittelbar vor Auftrag auf EXAKT gleichem Source-Tree `35f0d962500da8a5827692f4c67c6c9416c66a92` verifiziert: npm ci --ignore-scripts, npm run build erfolgreich, npm test 638/638 (93 Dateien), WSL cargo test --workspace --locked 29/29, fmt/clippy -D warnings erfolgreich.
- Browser-Grundsuite: 148 bestanden, 46 bestehende Plattform-/Opt-in-Skips. Nicht als Massentest gezählt! Native Linux/Android nur über die einzelnen PR-CIs, keine neue native Gesamtprüfung.
- Nicht-fatal: Build-Chunks >500 kB; Unit-stderr Medien-Mock/JSDOM getClientRects. Nicht versteckt oder für grün unterdrückt.
- Massentest nach PRs: `node tools/plugin-survey/run.mjs --api 1.14.4 --config <local-isolated-config> --workers 4` abgeschlossen: 26 sauber, 16 mit Fehlern, 58 nicht startfähig; API 538/773 (69,6 %), 84 Exporte fehlen. 101 Playwright-Fälle bestanden bedeutet hier nur erfolgreiche Diagnose, nicht 100 kompatible Plugins.
- Eigener Vite-Port 14751; vorhandener anderer Checkout/Server auf 1420 wird nicht berührt. Externe Config liegt eine Ebene über Repo.

## Todo (laufend aktualisieren)

- [x] Berichte, AGENTS, SECURITY, vorhandenen Survey-Runner/Test und API-Struktur lesen.
- [x] Sauberen Branch vom nach-PR-next anlegen; Sitzung in Repo verschieben.
- [x] Baseline-Massentest auswerten, alle 100 IDs/Versionen/Hashes fixieren; Downloads und Fehler vollständig zählen.
- [ ] Gemeinsame Fehler nach Häufigkeit priorisieren und offizielle .d.ts/Upstream-Nutzung prüfen.
- [ ] Je Fehlerfamilie: reproduzierender roter Test, kleinste echte Host-Ergänzung, grüner Test + Build, gezielter echter Bundlelauf, lokaler Commit.
- [ ] Gesamten unveränderten 100er-Satz neu prüfen; Regressionen/Timeouts/Console-Fehler zählen, keine Skips/Filter ergänzen.
- [ ] Full Unit/Build/Browser/Core laufen lassen; Native-Anforderungen separat benennen.
- [ ] Fortschritt und verbleibende Blocker mit Zahlen, Commit-IDs und Berichtspfaden festhalten; nächste sichere Fehlerfamilie abarbeiten.

## Nächster Ansatz / Entscheidungen

- Gemeinsame API-Lücken statt 100 individueller Patches; vorhandene Browser-/CodeMirror-/Vault-Funktionen wiederverwenden. Alternative pauschaler Node/Electron-Shim verworfen (Sicherheits-/Android-Vertrag); Alternative Tests abschwächen verworfen (verfehlt Auftrag).
- Untersuchungsorte: `src/compat/{obsidian-api,plugin,component,session,workspace,editor-modules,plugin-module,plugin-bundles}.ts`, `tests/unit/`, `tools/plugin-survey/`, `tests/e2e/plugin-survey.spec.ts`.
- Survey-Test sammelt Fehler bewusst in JSON und schlägt deswegen nicht automatisch fehl. Runner-Exit 0 / Playwright-grün ist KEIN Nachweis von 100 sauberen Plugins: `report.json`, Resultatanzahl, enabled-Flags und events separat auswerten.
- Der Survey öffnet vor Plugin-Aktivierung keine aktive Notiz; einige bekannte aktive-Datei-Fehler können reale Null-Vertragsfehler des Plugins oder Harness-Abweichungen sein. Nicht blind durch Teständerungen ausblenden; reproduzieren und Host-/Testvertrag unterscheiden.

## Stand / Erledigt

- Einrichtung und Analyse begonnen; noch keine Produktänderung, noch keine behauptete Verbesserung der 100er-Zahlen.
- Baseline eingefroren: `node_modules/.cache/basalt-plugin-survey-baseline-20261115/` enthält rohe Ergebnisse, Bericht, offizielle API-Oberfläche und `selected.json` mit 100 eindeutigen IDs/Versionen/SHA-256-Hashes. 100 Resultate, 0 Downloadfehler; alles ignoriert und nicht für Veröffentlichung vorgesehen.
- Nächste sichere Fehlerfamilie: installierte, bereits vom Host verwendete CodeMirror-Module autocomplete/search fehlen nur in der expliziten Plugin-Modultabelle (TaskNotes, make.md, Metadata Menu). Keine neue Abhängigkeit oder Systemberechtigung nötig.
- CodeMirror autocomplete/search ergänzt: zwei Regressionen erst rot (fehlende Module), danach grün mit identischen Host-Klassen/Effekten und echter EditorState-Nutzung. Build erfolgreich, gesamte Unit-Suite 640/640. Unveränderte drei Bundles erneut diagnostiziert: TaskNotes aktiviert jetzt, hat aber weitere echte Laufzeitfehler; make.md/Metadata Menu erreichen die nächste fehlende Abhängigkeit `@codemirror/lint`. Kein Plugin voreilig als sauber gezählt, keine Tests oder Fehler gefiltert.
- Button-Tooltips und CTA-Rücknahme ergänzt: beide fehlenden Methoden durch rote Tests reproduziert; 19 UI-Tests und gesamte Suite 642/642 grün, Build erfolgreich. LiveSync erreicht jetzt die nächste Lücke `Setting.setDisabled` (statt setTooltip/removeCta). Bestehender Tooltip-Helper bietet native Titel/ARIA, keine positionierte Tooltip-UI; diese Einschränkung bleibt sichtbar, nicht durch erfundene Attribute kaschiert.
- `Setting.setDisabled` mit echten, registrierten Steuerelementen implementiert; Buttons erben jetzt wie dokumentiert von BaseComponent. Drei rote Regressionen (alle acht Kontrolltypen, später hinzugefügte Controls, absichtlich deaktivierte Controls) danach grün: 22 UI-Tests, 645/645 gesamte Suite, Build erfolgreich. LiveSync 1.0.50 durchläuft den unveränderten Survey jetzt ohne Ereignisfehler. Terminal kommt weiter, bleibt aber wegen echter Electron/Node-Abhängigkeiten und weiterer View-Lücken fehlerhaft; nicht als kompatibel gezählt.
- Öffentliche `SettingPage`-Basisklasse mit echten Titel-/Inhalts-Elementen und Hide-/Render-Lebenszyklus ergänzt (keine behauptete Navigation/deklarative Settings-Engine). Zwei Tests erst rot, danach 24 passende Tests und 647/647 gesamte Suite grün; Build erfolgreich. Breadcrumbs aktiviert jetzt ohne Ereignisfehler; QuickAdd/Importer erreichen den fehlenden Protocol-Handler. Templater bleibt bei einer anderen fehlenden Basisklasse blockiert.
- Vollständiger Zwischenlauf: 28/100 fehlerfrei, 16 mit Laufzeitfehlern, 56 Ladefehler (vorher 26/16/58). Alle 100 IDs und SHA-256 sämtlicher Original-Assets stimmen mit der eingefrorenen Ausgangsmenge überein; keine Downloadfehler. Rohdaten lokal im ignorierten Cache gesichert.
- Datums-Platzhalter durch Moment.js 2.31.0 ersetzt; eine direkte MIT-Abhängigkeit ohne transitive Abhängigkeiten/Installationsskripte statt eigener Kalender-Nachbildung. Offiziellen Changelog (inklusive Sicherheitsfix) und Locale-Import-Dokumentation geprüft. Zwei Tests erst rot (Eingabedatum wurde ignoriert), danach 10 passende Tests und 649/649 gesamte Suite grün; Build erfolgreich. npm audit: null Befunde; 242 Registry-Signaturen und 81 Attestierungen geprüft. Unveränderte Reminder-/Full-Calendar-Bundles ohne Ereignisfehler; Calendar Beta erreicht fehlende Tagesnotiz-Konfiguration, Day Planner benötigt dateilose Hauptansichten, Pretty Properties einen weiteren internen Dienst. Keine Fehler unterdrückt.

- `SearchComponent` und `SettingGroup` nach offiziellen Signaturen mit echten DOM-Controls ergänzt: Suchwert/Änderungsereignis, barrierefrei beschrifteter Löschbutton, deaktivierte Controls, gruppierte Settings und Fragment-Überschriften. Beide fehlenden Exporte erst rot reproduziert, danach 24 passende Tests und 651/651 gesamte Suite grün; Build erfolgreich. Custom Frames und Various Complements durchlaufen die unveränderten Bundles ohne Ereignisfehler. BRAT erreicht den weiterhin fehlenden Protocol-Handler; Iconic hat weitere reale Host-Lücken. Kein voller neuer 100er-Zähler aus Teiltests abgeleitet.

- Theme-Lücke reproduziert: `App.isDarkMode` und das von Colored Text verwendete ältere `getTheme` fehlen. Beide lesen nun den echten aktuellen Host-Modus (inklusive Umschalten); keine feste Theme-Attrappe. Unverändertes Colored Text 1.3.1 aktiviert, rendert Einstellungen und deaktiviert ohne Ereignisfehler; 652/652 Unit-Tests und Produktionsbuild erfolgreich.

- `editorLivePreviewField` bildet jetzt den echten Host-Facet ab, statt als fehlender Export CodeMirror abstürzen zu lassen. Regression erst rot; Umschalten Source/Live und Abbau beim Session-Ende geprüft, 653/653 Unit-Tests und Build erfolgreich. Vollständiger unveränderter 100er-Lauf: 31 sauber, 15 mit Fehlern, 54 Ladefehler; Excalidraw jetzt ohne Ereignisfehler. Alle 100 Versionen und Original-Asset-Hashes erneut identisch; zweiter Rohdaten-Zwischenstand nur im ignorierten Cache gesichert.

- Die ältere öffentliche `request`-API nutzt jetzt denselben realen HTTP-Transport wie `requestUrl` und liefert dessen Text zurück. Zwei Regressionen erst rot, danach 655/655 Tests und Build erfolgreich; Browser-/native Transportwahl, HTTP-Fehler, `throw: false` und Netzfehler geprüft. LiveSync weiterhin ohne Ereignisfehler; Editing Toolbar und Code Styler bleiben an anderen Host-Lücken hängen. Keine neue Netzwerkberechtigung.

- Kanbans Konstruktor scheiterte am schreibgeschützten `_loaded`-Feld. Es ist jetzt ein vom Host gepflegtes Kompatibilitätsfeld; die private Zustandsmaschine bleibt allein für Laden, Besitz und Aufräumen zuständig. Regression erst rot, danach 656/656 Tests und Build grün; absichtlich überschriebene Flags umgehen weder Einmaligkeit noch spätes Cleanup. Kanban erreicht nun die nächste reale Lücke im Extension-Registry-Zugriff, bleibt also als Fehler sichtbar.

- Legacy-ES5-Konstruktoren unterstützen jetzt echte `super.call/apply`-Initialisierung über Reflect.construct, ohne die gemeinsamen Host-Klassen zu ersetzen. Zwei rote Lade-/Settings-Regressionen danach grün; fremde Receiver und ungültige Plugin-IDs bleiben abgewiesen. Unveränderte Mind Map und Note Refactor aktivieren und durchlaufen den Survey ohne Ereignisfehler. Gesamtsuite nach separater Parser-Reparatur 661/661, Build grün; Browser-Grundsuite erneut 148 bestanden/46 unveränderte Opt-in-Skips, Core 29/29 inklusive Unix-Symlinks und fmt/clippy grün.

- Ein voller Unit-Lauf zeigte einen sporadischen fehlenden Embed (isoliert zunächst grün). Ursache deterministisch für große Notizen reproduziert: CodeMirror parst zunächst nur einen Teil; nachfolgender Parser-Fortschritt ohne Textänderung aktualisierte weder Plugin-Embeds noch Plugin-Codeblöcke. Zwei Regressionen erst rot, danach beide Dekorationsfelder um den echten Syntaxbaumwechsel ergänzt; 20 passende Tests, volle 661/661 und Build grün. Keine Wartezeit erhöht und kein Fehler versteckt. Die spätere Typecheck-Korrektur betraf ausschließlich die neue synthetische Test-Factory, deren loadFile-Methode der reale Embed-Vertrag verlangt.

- SVG-DOM-Helfer nach offizieller Signatur ergänzt: echte SVG-Namensräume, verschachtelte Formen, Attribute, Klassen, Fragment-/Parent-Einfügung und Callback vor Einfügung. Regression erst rot, danach 23 passende Tests grün. Neuer voller 100er-Lauf: 34 sauber, 15 mit Fehlern, 51 Ladefehler; Dice Roller jetzt ohne Ereignisfehler. Alle 100 Original-Asset-Hashes unverändert, Rohdaten-Zwischenstand 03 gesichert. Ein paralleler Volltest zeigte eine zeitabhängige Sofort-Assertion des bestehenden Embed-Tests; der Host verfolgt dort bereits Syntaxbaum-Fortschritt. Mit vier Unit-Workern und ohne parallelen Browserlauf bestanden alle 662 Tests unverändert; Build ebenfalls grün. Keine Assertion, Frist oder Parser-Grenze verändert.

- Berichtsauswertung verschärft: bisher wurden reine Netzfehler trotz „ohne Fehler“ als sauber gezählt. Rote Node-Regressionsprüfung reproduziert die falsche Einstufung; nach einer Bedingungsänderung beide Report-Tests grün, fehlende/gescheiterte Ergebnisse weiterhin nicht sauber. Aktuelle 100 Rohresultate neu ausgewertet: unverändert 34/15/51, alle 34 sauberen Plugins tatsächlich mit leerer Fehlerliste. Keine Fehler umklassifiziert oder ausgeblendet; Prüfbefehl und Bedeutung grüner Diagnose-Läufe dokumentiert.

- Der öffentliche Mermaid-Loader nutzt jetzt exakt denselben verzögert geladenen Renderer wie Host-Diagramme. Zwei fehlende-Export-Regressionen erst rot; gemeinsame Instanz, unveränderte strikte Host-Konfiguration und weitergereichte Importfehler geprüft. Eine neue Testannahme zum Fehlertext wurde auf die von Vitest erhaltene originale Fehlerursache korrigiert (kein Produktionsfehler verschluckt). 664/664 Unit-Tests mit vier Workern und Produktionsbuild grün. Unveränderte Mermaid Tools ohne Fehler und ohne fehlenden Export; Image in Editor behält seinen unabhängigen StateField-Fehler. Kein neuer voller 100er-Zähler behauptet.

### Blockiert / braucht Freigabe

- Eine Lösung, die unrestricted Node/fs/Prozess-/Serverzugriff, globale Installationen, bezahlte APIs oder Veröffentlichung voraussetzt, ist nicht freigegeben. Andere sichere Lücken werden währenddessen weiterbearbeitet.
