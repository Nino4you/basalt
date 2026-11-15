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

### Blockiert / braucht Freigabe

- Eine Lösung, die unrestricted Node/fs/Prozess-/Serverzugriff, globale Installationen, bezahlte APIs oder Veröffentlichung voraussetzt, ist nicht freigegeben. Andere sichere Lücken werden währenddessen weiterbearbeitet.
