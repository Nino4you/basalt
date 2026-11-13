# Plugin-Kompatibilität

Basalt implementiert die öffentliche Obsidian-Plugin-API (`obsidian.d.ts`) als eigene
Kompatibilitätsschicht. Ziel ist die Kompatibilität mit ausgewählten Obsidian-Plugins, keine
pauschale Zusage für beliebige Community-Plugins. Fehlende gemeinsame APIs werden im Host
ergänzt, nicht durch Änderungen an den Plugin-Bundles kaschiert.

## Lokaler Bundle-Loader und Workspace

### Kern-Live-Vorschau

KaTeX, Mermaid und Markdown-Tabellen werden auch im Editor dargestellt. Eine Tabelle
bleibt beim Bearbeiten sichtbar; nur die aktive Zelle zeigt ihren Markdown-Quelltext.
Registrierte Plugin-Codeblock-Prozessoren haben weiterhin Vorrang vor dem eingebauten
Mermaid-Renderer. Plugin-Einbettungen bleiben ein eigener Lebenszyklus.
Mehrzeilige Formeln in verschachtelten Blockzitaten/Callouts und nicht eindeutig
abbildbare Tabellen bleiben sicherheitshalber als Quelltext sichtbar. Beim Leeren
einer Randzelle ergänzt der Editor nötigenfalls den optionalen äußeren Tabellenstrich,
damit GFM die Nachbarzelle nicht in eine andere Spalte verschiebt.
Bekannte Darstellungsgrenze: Ein maskierter Tabellenstrich innerhalb eines Code-Spans
kann in einer inaktiven Zelle noch mit seinem Backslash erscheinen; der Quelltext bleibt erhalten.
Die Browser-Tests einschließlich schmaler Layouts und synthetischer Composition-Events
ersetzen keine Prüfung mit einer echten Android-Tastatur oder Linux-/Android-Nativlaufzeit.

### Excalidraw 2.29.2: vollständiger Browser-Lebenszyklus verifiziert

Geprüft am 11./12.11.2026 mit den unveränderten offiziellen
[Release-Dateien](https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.29.2)
in isoliertem In-Memory-Speicher, nicht in einem echten Vault.
`main.js` (5.094.286 Bytes) hat SHA-256
`49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541`.

- Die CommonJS-Auswertung gelingt. Die explizite Modultabelle stellt dieselben installierten
  CodeMirror-Instanzen (`commands`, `language`, `state`, `view`) und Lezer-Instanzen
  (`common`, `highlight`, `lr`) bereit, keinen freien `require`- oder Node-Zugriff.
- Ergänzt wurden `getLanguage` (aktuelle deutsche Host-Oberfläche), `BaseComponent`,
  `ValueComponent`, `PopoverSuggest`, `AbstractInputSuggest`, die `EditorSuggest`-Basisklasse,
  das dokumentierte globale `sleep` sowie die von Obsidian erweiterten DOM-Methoden
  (`addClass`, `empty`, `createDiv`, `setCssStyles` usw.) auf `Node`, `Element` und `HTMLElement`.
- Der Host besitzt jetzt echte Workspace-Leaves: `iterateAllLeaves`, `detachLeavesOfType`,
  `getLeaf`, mehrere Ansichten, Lebenszyklus in der Reihenfolge `onunload` → `onClose`
  (wie von Excalidraw dokumentiert) und asynchrones Aufräumen.
- **Chromium-E2E (Desktop):** Plugin aktiviert mit `isReady: true` und 75 Befehlen,
  Ansichten `excalidraw` und `excalidraw-sidepanel`, neue Zeichnung geöffnet, Rechteck
  und Text über die UI erstellt, Autosave schreibt die Markdown-Datei, ein weiteres
  ungespeichertes Element über „Tab schließen“ gesichert und aus dem Vault
  neu geöffnet (alle Element-IDs wiederhergestellt), anschließend deaktiviert
  ohne verbleibende Ansichten, Befehle oder Leaves. Keine Seitenfehler.
- Derselbe Lebenszyklus ist zusätzlich mit der aktuellen Tauri-Produktions-CSP als
  HTTP-Header geprüft (Vite-Module, kein nativer Build). Delegierte DOM-Ereignisse
  `on(type, selector, listener)` / `off(...)` auf Elementen und Dokumenten unterstützen
  dabei den Inline-Texteditor. Der Test entfernt nur den nicht-nativen HMR-Client.
  **Bekannte Grenze:** optionale Xiaolai-CJK-Schriften von `esm.sh` werden weiter durch
  `font-src` gesperrt. Die erwarteten Font-Verstöße werden als Testartefakt erfasst;
  die CSP wurde nicht für das CDN geöffnet. Lateinischer Text ist geprüft,
  chinesische Schriftwiedergabe ist damit nicht nachgewiesen.
- SVG-Export über die unveränderten Plugin-Methoden `getSVG` und `saveSVG` geprüft:
  echte Formen, Text und eingebettete WOFF2-Schrift; die gespeicherte SVG wurde aus dem
  isolierten Vault zurückgelesen. Beide CSP-Varianten bestehen. Dafür tolerieren die
  DOM-Helfer leere Klasseneinträge und unterstützen `Setting.setVisibility`, eine von
  diesem Release verwendete private Host-Methode. `connect-src data:` erlaubt nur das
  Lesen bereits eingebetteter Font-Daten; keine neuen Netz- oder Skriptquellen.
- jsdom kann Excalidraw nicht vollständig starten (kein echtes iframe-Rendering,
  `Worker`/`IndexedDB` fehlen, modernes Release-CSS wird nicht vollständig geparst).
  Der optionale jsdom-Aktivierungstest überspringt deshalb genau dieses Bundle;
  `tests/e2e/excalidraw.spec.ts` ist die maßgebliche Abdeckung.
- Zeichnungen als `![[Drawing.excalidraw.md]]` in der Leseansicht werden vom echten
  Plugin-Postprozessor als dekodierte Grafik gerendert, nicht als komprimierter Quelltext.
  Der Host stellt dafür den aufgelösten Transklusionspfad im Obsidian-Attribut `src`
  bereit; umgebender Notiztext bleibt erhalten. Beide CSP-Varianten und die tatsächlichen
   App-Stylesheets sind geprüft. Der Postprozessor erhält den tatsächlichen Markdown-
   Container, damit Excalidraw den Lesemodus erkennt und eigene Embed-Controls registriert.
   Der Vorschau-Knopf öffnet seinen Dialog; der normale Settings-Deaktivierungsweg
   entlädt die Render-Children und entfernt Toolbar, Vorschau-Dialog, Plugin-Styles,
   Ribbon-/Statusbeiträge und Ansichten. Resize-/Quelltext-Controls sind nicht geprüft.
- PNG-Speicherung über `savePNG` in beiden CSP-Varianten geprüft: Datei aus dem Vault
  zurückgelesen, PNG-Signatur validiert, vom Browser dekodiert und nichtleere dunkle
  Bildpixel gezählt. Dafür waren keine weiteren Host-Änderungen nötig.
- `exportPNG` erzeugt zusätzlich einen echten Browser-Download mit `.png`-Dateinamen
  und gültiger PNG-Signatur, ohne Download-Fehler. Der Exportdialog-Klickpfad und das
  native Speicherdialog-Verhalten sind damit nicht geprüft.

**Verifiziert:** Öffnen, Zeichnen, Autosave, Speichern, erneutes Laden, Markdown-Einbettung, SVG-/PNG-Speicherung und Deaktivieren im
Browser. **Nicht verifiziert:** native Tauri-/Android-Builds, echte Vault-Schreibvorgänge
außerhalb der In-Memory-Kopie, PDF-Export, Exportdialog-/Clipboard-UI und Embed-Resize-/Quelltext-Controls. Die Bundle-Dateien sind nicht
im Repository enthalten.
**PDF-Export blockiert:** Der unveränderte 2.29.2-Exportpfad fordert
`window.electron.remote.dialog.showSaveDialog` und einen Electron-Druckexport an
([Upstream-Quelle](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/2.29.2/src/utils/exportUtils.ts#L71-L108)).
Diese Fähigkeiten werden nicht als pauschaler Electron-/Dateisystem-Shim bereitgestellt.
Das betrifft nicht die lokale PDF-Anzeige im Host.

### Iconize

Das unveränderte Iconize-Bundle **2.14.7** startet im isolierten Chromium-Harness
mit seinem Standard-Icon-Pfad `.obsidian/icons` (auch mit abschließendem `/`). Dieser
Pfad liegt physisch unter `Basalt/Config/icons`, nicht im Vault-Inhalt für Sync-Plugins.
Bereits vorhandene Icon-Packs aus `.obsidian/icons` werden nicht automatisch kopiert und
müssen bei Bedarf in diesen Ordner übernommen werden.

`tests/e2e/iconize.spec.ts` prüft bei gesetztem `BASALT_PLUGIN_DIRS` Aktivierung,
Befehlsregistrierung, Anlegen des Icon-Ordners, eine aktive Notiz mit internem Link,
Öffnen des echten „Change icon“-Dialogs im Datei-Kontextmenü, Vorschau und Auswahl eines
lokalen Test-SVGs samt sichtbarem Dateibaum-Icon und gespeicherter Zuordnung sowie
Deaktivieren samt Entfernen der Befehle ohne Konsolenfehler im Desktop- und mobilen
Browserlayout. Der Host stellt dafür `tokenClassNodeProp` im gemeinsamen
CodeMirror-Sprachmodul bereit; bislang sind nur interne Link-Zieltexte zugeordnet.
Datei-, Ordner-, Tab-, Lesezeichen- und Notizoptionsmenüs lösen `file-menu` aus und
behalten Plugin-Menüeinträge samt `onHide`-Lebenszyklus im gemeinsamen Host-Menü.
Die echte Explorer-Ansicht ist als `file-explorer`-Leaf erreichbar. Ihr `fileItems`-Index
enthält wie in Obsidian alle Dateien und Ordner, auch Kinder eingeklappter Ordner: Deren
Zeilen werden bei Bedarf losgelöst erzeugt und beim Aufklappen wiederverwendet. Baut der
Dateibaum seine Zeilen neu auf, übernimmt er alles, was ein Plugin in eine Zeile eingefügt
hat (etwa `.iconize-icon`), in die neue Zeile. Der Test prüft das für Neuaufbau und
Zu-/Aufklappen eines Ordners.

In der geöffneten Windows-Debug-App wurden außerdem „Weitere Optionen → Change icon“
und die SVG-Vorschau `Rocket (Bt)` aus dem lokalen Test-Pack manuell geprüft, ohne
eine Zuordnung im echten Vault zu speichern.

**Nicht verifiziert:** native Auswahl-/Speicherzyklen, Android-Ausführung, Icon-Pack-Downloads,
Icons in Links und Tabs sowie Datei-Zeilen mit Lesezeichen-Markierung und
Dateityp-Etikett zugleich (Iconize überspringt Zeilen mit mehr als zwei Kindern). Das ist kein Nachweis
vollständiger Iconize-Kompatibilität. Es werden weder persönliche Plugin-Einstellungen
noch Bundle-Dateien eingecheckt.

### Ausführungsmodell

Seit dem Loader-Commit gilt ein bewusst enges, aber echtes Ausführungsmodell:

- Bundles liegen sichtbar unter `Basalt/Plugins/<id>/` mit `manifest.json`, `main.js` und optional
  `styles.css`. Der sichtbare Ordner ist Absicht, weil Androids Storage Access Framework
  versteckte `.obsidian`-Ordner nicht zuverlässig freigibt.
- `manifest.json` wird validiert; die Ordnername-ID muss mit `manifest.id` übereinstimmen.
- `main.js` wird als CommonJS in einem synthetischen Modul-Wrapper ausgeführt. Erlaubt sind nur
  das host-eigene `obsidian`-Modul und ausdrücklich übergebene Module. Bundles erhalten
  dieselben CodeMirror-6-Instanzen wie der Host.
- Ohne ausdrückliche Zustimmung wird kein Bundle geladen. Die Aktivierung erfolgt einzeln
  in den Einstellungen und wird für den jeweiligen Vault gespeichert und wiederhergestellt.
- Plugin-Code erhält bewusst Zugriff auf DOM, WebView-Speicher und die Tauri-Befehle der App.
  Deshalb ist `'unsafe-eval'` in der CSP nötig; das ist eine Vertrauensentscheidung für lokal
  installierte Bundles, keine Sandbox.
- `app.vault.adapter` bildet `.obsidian/plugins/<id>/…` auf `Basalt/Plugins/<id>/…` und alle
  übrigen `.obsidian/…`-Pfade auf `Basalt/Config/…` ab (beides kein Vault-Inhalt);
  `adapter.list` liefert die Pfade wieder in Obsidian-Form. Führende, doppelte und abschließende
  Schrägstriche werden wie in Obsidian toleriert. Iconize (2.14.7) scheiterte sonst beim Start an
  `exists(".obsidian/icons/")`. Eigene Icon-Pakete aus Obsidian gehören nach
  `Basalt/Config/icons/`.
- `loadData`/`saveData` lesen und schreiben wie in Obsidian `Basalt/Plugins/<id>/data.json`
  (eingerückt formatiert, höchstens 16 MiB). Die Einstellungen wandern so mit dem Vault auf
  andere Geräte und in Backups und überstehen eine Neuinstallation der App. Speichervorgänge
  eines Plugins laufen der Reihe nach, sodass der letzte Aufruf gewinnt. Eine ungültige
  `data.json` wird nicht stillschweigend durch Standardwerte ersetzt, sondern als Fehler
  gemeldet; scheitert dadurch ein beim Start wiederhergestelltes Plugin, zeigt die App eine
  Meldung und den Fehler in den Plugin-Einstellungen, statt es kommentarlos zu deaktivieren.
  Die Datei bleibt unverändert. Ältere Basalt-Versionen hielten diese Daten im WebView-`localStorage`; sie werden
  gelesen, bis das Plugin zum ersten Mal speichert, danach entfernt. Wie jede Plugin-Datei
  wird `data.json` versionsgeprüft und vorher gesichert; unter Android (SAF) ist das Schreiben
  nicht atomar (siehe `SECURITY.md`). Im Emulator geprüft (12.11.2026): Migration, Neustart,
  kaputte und gelöschte `data.json` im App-internen Vault und in einem SAF-Ordner.
- Der Loader erzwingt 8 MiB für `main.js`, 64 KiB für das Manifest und 1 MiB für Styles.

Gemeinsame API-Korrekturen: Plugin-Befehle erhalten globale IDs wie `<plugin-id>:<befehl>`
und den Plugin-Namen als Anzeigenamenspräfix; identische lokale IDs verschiedener Plugins
kollidieren damit nicht mehr. `requestUrl` unterstützt URL-Strings, `contentType`, standardmäßige
HTTP-Fehler ab Status 400 und die Promise-Shortcuts `.json`, `.text`, `.arrayBuffer`.
Der Transport bleibt WebView-`fetch`: Obsidian-artiger HTTP-Zugriff ohne CORS-Einschränkungen
ist damit **nicht** implementiert.
API-Vertrag: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts.

`FileManager.processFrontMatter` parst das YAML-Frontmatter mit dem Paket `yaml` und ruft den
Callback mit dem veränderbaren Objekt auf. Zurückgeschrieben werden nur geänderte oder
gelöschte Schlüssel; Kommentare und unveränderte Blöcke bleiben erhalten. Ungültiges YAML und
ein Fehler im Callback verhindern den Schreibvorgang. Das Paket wächst mit rund 100 kB
(minifiziert) im Frontend-Bundle.
Lesen, Callback und Schreiben laufen über `Vault.process`: gleichzeitige Änderungen
werden nacheinander verarbeitet; externe Versionskonflikte werden ohne Callback-Wiederholung gemeldet.

`parseYaml`, `stringifyYaml` und `getFrontMatterInfo` nutzen dieselbe Blockdefinition wie
`processFrontMatter`. `getFrontMatterInfo` liefert `exists`, `frontmatter` (inklusive
abschließendem Zeilenumbruch), `from`, `to` und `contentStart`; ohne Block sind alle Werte leer.
`sanitizeHTMLToDom` bereinigt Plugin-HTML mit dem bereits gebündelten DOMPurify und liefert ein
`DocumentFragment`. `requireApiVersion` vergleicht gegen die gemeldete `apiVersion` 1.15.0;
`getLinkpath`, `stripHeading` und `stripHeadingForLink` folgen den dokumentierten Beispielen, und
`getAllTags` vereinheitlicht die Tags eines `CachedMetadata`. `addIcon`, `getIcon` und `removeIcon`
ergänzen die eingebauten Lucide-Icons, `setIcon` nutzt beide Quellen. Das vollständige
Lucide-Set liegt in einem nachgeladenen Chunk, der vor der Aktivierung jedes Plugins geladen wird;
`setIcon` bleibt deshalb synchron und kennt für Plugins alle Icons. Die Buffer-Helfer
(`arrayBufferToBase64`, `base64ToArrayBuffer`, `arrayBufferToHex`, `hexToArrayBuffer`,
`getBlobArrayBuffer`) arbeiten ungeprüft wie dokumentiert; fehlerhaftes Hex wird abgewiesen,
statt halbe Bytes zu liefern. `parseFrontMatterEntry`, `parseFrontMatterStringArray`,
`parseFrontMatterTags` und `parseFrontMatterAliases` lesen ein bereits geparstes
Frontmatter-Objekt, akzeptieren Schlüssel oder Muster und normalisieren Tags mit `#`.

Das beweist die Modul-, Registrierungs-, Codeblock-, View- und begrenzte Speicher-Ebene, **nicht** die Funktion
des Syncs, der Stifteingabe, der OCR oder das Verhalten auf echten
Android-Geräten.

Im Chromium-Harness mit unveränderten Community-Plugins geprüft: **Colored Tags 7.0.0**
aktiviert nach Ergänzung von `MetadataCache.getTags()` fehlerfrei und deaktiviert rückstandsfrei;
das Bundle registriert nur eine Editor-Extension, keine Views oder Befehle. **Tag Wrangler 0.6.5**
aktiviert nach Ergänzung von `Workspace.registerHoverLinkSource`/`unregisterHoverLinkSource`
ohne Fehler; die Hover-Quelle wird gespeichert. Der Host zeigt inzwischen eine eigene
Seitenvorschau für interne Links, fragt aber noch keine von Plugins registrierten Hover-Quellen
ab. **File Explorer Note Count 1.2.4** durchläuft ebenfalls den Aktivierungs-/Deaktivierungszyklus,
zeigt im Host aber noch keine Ordnerzähler: Das Bundle sucht dafür einen `file-explorer`-
Workspace-Leaf mit `fileItems`; der eigene Dateibaum stellt diese Plugin-Sicht nicht bereit.
Der Test belegt nur den Lebenszyklus, nicht die sichtbare Zählerfunktion.
**Various Complements 11.4.2** aktiviert nach Angleichung der `Scope`-Handler (`func`, `scope`,
Dokument-Reihenfolge) und dem Standard-Escape-Handler der Editor-Vervollständigung mit zehn
Befehlen. Registrierte `EditorSuggest`-Vorschläge werden jetzt in die vorhandene
CodeMirror-6-Vervollständigung eingespeist: Das unveränderte Bundle schlägt Wörter aus der
aktiven Notiz vor, und Enter fügt den Vorschlag über die Plugin-Methode ein. Im Chromium-Test
wurde diese Einfügefunktion geprüft; die Darstellung ist auf den
einfachen CodeMirror-Listeneintrag reduziert, eigene mehrzeilige Plugin-Darstellungen und
Auswahlmodifikatoren sind nicht nachgebildet. `metadataCache.resolvedLinks` und
`unresolvedLinks` liefern dafür Zählungen aufgelöster beziehungsweise fehlender Wikilinks.
**Cmdr 0.5.11** aktiviert nach Ergänzung des exportierten `moment`, von
`app.statusBar.containerEl`, einer echten `MenuItem`-Klasse und der Live-Befehlstabelle
`app.commands.commands` mit `removeCommand`; es registriert den Befehl
`cmdr:open-commander-settings` und deaktiviert rückstandsfrei. Die Makro- und
Ribbon-Oberfläche wurde damit nicht vollständig durchgeklickt.
**Calendar 1.5.10** scheitert weiterhin an `Workspace.getRightLeaf` und bleibt deaktiviert;
dafür fehlt echte Seitenleisten-Leaf-Unterstützung, kein Platzhalter wurde eingebaut.
**Double Shift Search 1.0.0** aktiviert mit `double-shift-search:open-vault-search`, **Ninja
Cursor 0.0.14** aktiviert ohne Befehle oder Views; beide deaktivieren rückstandsfrei. **File
Explorer Plus 1.3.1** scheitert an fehlender `file-explorer`-Ansicht: Der Host hat einen eigenen
Dateibaum, aber keinen entsprechenden Workspace-Leaf, dessen Methoden das Plugin patchen kann;
es wurde kein Ersatzobjekt vorgetäuscht. **Code Styler 1.1.7** kommt mit dem reinen
POSIX-Pfadhelfer und dem Standard-Themewert an der Modulprüfung vorbei, scheitert bei der
Aktivierung aber am fehlenden globalen CodeMirror-5-Modusregister (`window.CodeMirror.modeInfo`).
Der Host nutzt CodeMirror 6; weder ein CodeMirror-5-Ersatz noch ein unbeschränkter Node-Shim
wurde vorgetäuscht.
**Obsidian File Color 1.1.0** aktiviert und deaktiviert ebenfalls rückstandsfrei; es
registriert keine Befehle oder Views. Ob Farben im Host-Dateibaum sichtbar werden, ist damit
nicht belegt.
Die von Obsidian dokumentierten globalen Helfer für Arrays (`first`, `last`, `contains`,
`remove`, `shuffle`, `unique`, `Array.combine`), `Math.clamp`/`square`, `String.contains`/
`format`/`isString` und `Number.isNumber` werden jetzt ohne Überschreiben vorhandener
Standardmethoden bereitgestellt.

Plugin-Codeblöcke werden im Lesemodus und im Live-Preview-Bearbeitungsmodus an registrierte
Prozessoren übergeben. Registrierte, nicht eingerückte Blöcke auf Dokumentebene bleiben im
Live Preview gerendert, auch bei Fokus, Cursor im Block und wiederhergestellter Auswahl.
Der Rohtext ist weiterhin im ausdrücklich gewählten Quelltextmodus zugänglich. Ohne aktiven
Prozessor bleibt ein Codeblock normaler Markdown-Quelltext. Nach dem Laden der Plugins wird
eine bereits gerenderte Leseansicht erneut aufgebaut. Aktive Plugin-Einstellungstabs erscheinen
im Einstellungsdialog.
Ohne aktive Markdown-Notiz sind Editor-Befehle nicht verfügbar; `workspace.activeEditor`,
`getActiveFile` und `getActiveViewOfType(MarkdownView)` melden dann `null`, wie in Obsidian.

`app.embedRegistry.registerExtension` verbindet Datei-Renderer von Plugins mit der Notiz:
eigenständige `![[Datei.ext]]`-Zeilen erscheinen im Live Preview als eingebettete Ansicht, auch mit
dem Cursor im Link. Die Leseansicht unterstützt dieselben registrierten Datei-Einbettungen. Die
eingebettete Datei bleibt der Speicherort; der Quelltextmodus zeigt weiter den Link. Ohne aktiven
Renderer bleibt die bisherige Link-Darstellung erhalten. Beim Ausblenden des Editors und vor dem
Deaktivieren werden Plugin-Oberflächen freigegeben.

## Offene Kompatibilitätsstufen

1. Die vorhandene Workspace-Einbindung von Codeblöcken, Plugin-Views, Datei-Extension-Navigation
   und Einstellungstabs mit echten Plugins in nativen Builds durchgängig testen;
   im jsdom-Harness fehlen Canvas und `IntersectionObserver`, sodass Zeichnen und Messen
   dort nicht geprüft werden können.
2. Sync-, Stift- und Tabellen-Plugins auf echten Geräten prüfen (zwei Clients, Offline/Resume,
   Stiftdruck, OCR-/Worker-Ressourcen, Dateitreue).

Weitere gemeinsame Lücken: sichtbare Plugin-Panes in den Seitenleisten (Calendar) und
der CodeMirror-5-Modus für ältere Syntax-Plugins. `Editor.exec` bildet die dokumentierten
Befehle auf den gemeinsamen CodeMirror-6-Editor ab; `EditorSuggest` ist
an die Editor-Vervollständigung angeschlossen; `registerHoverLinkSource` speichert
Plugin-Quellen, wird für die eigene Seitenvorschau aber noch nicht abgefragt.
Node/Electron-Plugins sind nicht automatisch unter Android lauffähig; ein unbeschränkter
Dateisystem-Shim ist keine zulässige Abkürzung.

`MetadataCache.getFileCache` liefert seit dem letzten Stand geparste Notizdaten
(Links, Embeds, Tags, Überschriften, Frontmatter) mit Positionen. Die Sitzung
liest dafür beim Start alle Markdown-Notizen einmal ein (gebündelt über
`plugin_vault_read_many`, 64 Dateien pro Aufruf) und hält den Cache über
Vault-Ereignisse aktuell; `original` enthält den Linkpfad ohne Alias, weil der
gemeinsame Parser Aliase verwirft. Sind die gespeicherten Tabs nur Notizen und
Canvases, zeigt die App sie vor diesem Einlesen an und verbindet die Plugins
danach; Plugins sehen die geöffnete Datei dann über `file-open` bzw.
`getActiveFile()`. Tabs mit Plugin-Ansichten oder Anhängen warten wie bisher auf
die Sitzung.

`TextFileView` liest die Notiz beim Öffnen, übergibt den Text an `setViewData`
und ruft danach `onLoadFile`; `save()` schreibt nur geänderte Daten über den
Vault (inklusive dessen Versions-/Konfliktprüfung), `requestSave()` bündelt
Änderungen mit 2 s Verzögerung. Ausstehende Änderungen werden beim Unload
abgeschlossen, und ein abgelehnter Schreibvorgang wird weitergereicht statt
verschluckt. Die sichtbare Editor-Ansicht der App ist davon unabhängig.

Die Eingabekomponenten (`TextComponent`, `TextAreaComponent`, `ToggleComponent`,
`ButtonComponent`, `ExtraButtonComponent`, `DropdownComponent`, `SliderComponent`,
`ColorComponent`) sind auch direkt aus dem `obsidian`-Modul exportiert, nicht nur über
`Setting.add…`. Plugins, die sie selbst konstruieren, laufen damit ohne Änderung.

Der `Editor`-Brücke fehlen gegenüber `obsidian.d.ts` nur noch `exec(command)`;
`getDoc`, `setLine`, `wordAt` und `blur` sind ergänzt. `wordAt` liefert für eine Position
genau dann ein Wort, wenn sie in oder direkt hinter einem Wort steht; zwischen zwei
Leerzeichen ist das Ergebnis `null`.

**Aktueller Stand:** Loader, Registrierungsflächen und Workspace-Anbindung sind auf `main`.
Vollständige Plugin-Abläufe sind damit noch nicht auf Geräten nachgewiesen.
Es gibt weiterhin keine pauschale Zusage für beliebige Community-Plugins.

Optionale Tests mit unveränderten lokalen Bundles (etwa `tests/e2e/iconize.spec.ts`) werden über
`BASALT_PLUGIN_DIRS` aktiviert (Pfade unter Linux mit `:`, unter Windows mit `;` getrennt). Ohne
Plugin-Bundles überspringt die Standard-CI sie; grüne CI allein belegt deshalb keine vollständige
Plugin-Kompatibilität.

`Vault.append` schreibt über denselben versionierten Schreibpfad wie `Vault.process`; `Vault.trash`
nutzt den bestehenden Löschpfad mit Backup. Beide Optionen (`DataWriteOptions`, `system`) werden
akzeptiert, aber die Zeitstempel vergibt weiterhin der Speicher.
