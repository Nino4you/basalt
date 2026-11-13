# Daten- und Sicherheitsgrenzen

Basalt ist eine Entwicklungsversion. Zum Testen zuerst Kopien von Vaults verwenden.

- Der Rust-Kern verwendet `cap-std` statt zusammengesetzter absoluter Dateipfade.
  Nur die explizite Vault-Auswahl öffnet einen neuen Dateisystem-Root.
- Vorhandene Notizen werden nicht beim Anlegen überschrieben. Speichern prüft die
  geladene Ausgangsversion und legt vorher eine Kopie unter `.basalt/history/` an.
- Linux schreibt zunächst eine separate Datei und ersetzt die Zieldatei durch Rename.
  Unkoordinierte externe Schreiber können trotzdem zwischen Prüfung und Rename schreiben:
  Es gibt keinen dateisystemübergreifend garantierten Compare-and-Swap.
- Android-SAF-Provider garantieren keinen atomaren Austausch. Dort wird vor dem Schreiben
  gesichert und erneut auf Konflikte geprüft. Unterbrochene Provider-Schreibvorgänge können
  die aktuelle Datei beschädigen; die vorherige Sicherung muss dann wiederhergestellt werden.
- Lesezugriffe unter Android merken sich bis zu 10 Sekunden lang, welches SAF-Dokument zu
  welchem Pfad gehört, damit nicht jeder Lesezugriff den ganzen Ordner neu auflistet.
  Größe, Änderungszeit und Inhalt werden trotzdem jedes Mal frisch abgefragt, und der Name
  wird gegengeprüft. Bei Providern mit undurchsichtigen Dokument-IDs kann eine extern in
  einen anderen Ordner verschobene Datei in diesem Zeitfenster noch unter dem alten Pfad
  gelesen werden. Schreiben, Löschen und deren Konfliktprüfungen nutzen den Cache nie.
- Neue Dateien können bei Schreibfehlern unvollständig sein. Fehler werden weitergegeben.
- Entwürfe und Browser-Demo liegen im lokalen WebView-/Browser-Speicher, unverschlüsselt.
  Die ursprüngliche Versionsbasis bleibt im Entwurf, damit Wiederherstellung externe Änderungen
  nicht still überschreibt. Ein volles/gesperrtes Speichermedium bleibt ein Fehlerfall.
- Markdown wird vor der Anzeige mit DOMPurify bereinigt. Native CSP blockiert Remote-Ressourcen,
  Scripts, Frames und Objekt-Einbettungen; externe Links werden nicht automatisch geöffnet.
  Die Vorschau entfernt zusätzlich Remote-Bildquellen, auch in der Browser-Demo.
- Plugin-Loader: Bundles werden nur nach ausdrücklicher Aktivierung aus
  `Basalt/Plugins/<id>` ausgeführt. Es gibt **keine Sandbox**: Plugin-Code hat dieselben
  Frontend-Rechte wie die App, einschließlich DOM, WebView-Speicher, Netzwerk und der
  freigegebenen Tauri-Befehle. Nur vertrauenswürdige Bundles aktivieren.
- `'unsafe-eval'` in der CSP ist ausschließlich für den CommonJS-Loader nötig. `connect-src`
  erlaubt HTTPS/WSS, weil Sync-Plugins und Plugin-Ressourcen Netzwerkzugriff benötigen.
  `data:` erlaubt das Lesen bereits eingebetteter Font-Bytes beim Excalidraw-SVG-Export,
  keine zusätzlichen Netzwerkziele oder Skriptquellen. Externe Schriften bleiben gesperrt.
  `worker-src 'self' blob:` erlaubt Workern aus Blob-URLs, die Plugins selbst erzeugen
  (etwa für OCR). `script-src blob:` erlaubt Skripte aus Blob-URLs, die Plugin-Code
  selbst aus eigenen Bytes erzeugt (etwa tesseract.js und dessen Wasm-Kern).
  Das erweitert keine Rechte: Eine Blob-URL kann nur bereits laufender Seitencode anlegen,
  und dieser darf wegen `'unsafe-eval'` ohnehin beliebigen Code ausführen. Eingeschleustes
  Markup kann keine Blob-URLs erzeugen; Remote-Skripte bleiben gesperrt. Es gibt weiterhin
  keinen generischen `window.require('fs')`-Shim.
- `requestUrl` läuft in der nativen App wie in Obsidian außerhalb der WebView über den
  Rust-Befehl `plugin_request_url` und unterliegt daher keiner CORS-Prüfung. Erlaubt sind
  nur `http`/`https`, Anfrage- und Antwortinhalt sind auf 64 MiB begrenzt, TLS-Zertifikate
  werden gegen die mitgelieferten Webpki-Wurzeln geprüft. Plugins hatten bereits
  Netzwerkzugriff; es entfällt nur die Cross-Origin-Beschränkung des Browsers.
- Plugin-Pfade unter `.obsidian/plugins/<id>` werden auf `Basalt/Plugins/<id>` abgebildet.
  Wie `.obsidian` in Obsidian ist `Basalt/Plugins` für Plugins kein Vault-Inhalt: Es fehlt in
  `getFiles()` und Vault-Ereignissen und ist nur über den Adapter und den Loader erreichbar.
  So laden Sync-Plugins installierten Plugin-Code nicht als Anhang hoch.
- `app.loadLocalStorage`/`saveLocalStorage` sind pro Vault getrennt, damit Anmeldungen
  (etwa Sync-Token) nicht in einen anderen Vault übernommen werden. `loadData`/`saveData`
  liegen dagegen wie in Obsidian als `Basalt/Plugins/<id>/data.json` im Vault: Was ein Plugin
  dort speichert, liegt im Klartext neben den Notizen und wird mit ihnen kopiert und gesichert.
  Alle übrigen Pfade unter `.obsidian/` (etwa Iconizes Icon-Pakete in `.obsidian/icons`)
  landen in `Basalt/Config/`, das genauso wie `Basalt/Plugins` kein Vault-Inhalt ist und nur
  über den Adapter erreichbar ist. Andere versteckte Pfade (`.basalt/`, versteckte
  Unterordner) bleiben gesperrt; `..`- und `.`-Segmente werden weiterhin abgelehnt, doppelte
  sowie führende und abschließende Schrägstriche wie bei Obsidians `normalizePath` ignoriert.
- Ressourcen-URLs (`adapter.getResourcePath`) gibt es nur für den eigenen Plugin-Ordner und nur
  so eng, wie etwa eine Tesseract-OCR-Engine es braucht (Sprachdaten per `langPath` im Worker):
  - Das native Protokoll `basalt-resource:` liefert ausschließlich Dateien unter
    `Basalt/Plugins/<id>/` eines Plugins, das in der aktuellen Vault-Sitzung aktiviert ist.
    Beim Aktivieren erhält das Plugin eine zufällige 256-Bit-Freigabe in der URL; Deaktivieren
    widerruft sie, ein Vault-Wechsel verwirft alle Freigaben. Andere Plugin-Ordner, Notizen,
    Anhänge und der App-Datenordner haben keine Ressourcen-URLs.
  - Nur `GET`/`HEAD`, keine Ordnerlisten, keine verborgenen Pfade. Gelesen wird über denselben
    Speicherpfad wie `plugin_vault_read` (`VaultPath`, `cap-std` beziehungsweise SAF, kein
    Symlink-Ausbruch, 64 MiB). Unbekannte Freigaben, ungültige Pfade und fehlende Dateien
    ergeben einheitlich 404.
  - Antworten sind immer `application/octet-stream` mit `nosniff` und eigener
    `sandbox`-CSP. Die WebView-CSP nennt das Protokoll nur in `connect-src`, nicht in
    `script-src`, `img-src`, `frame-src` oder `worker-src`: Die URLs sind nur per `fetch`
    lesbar, nie als Skript, Bild oder Frame ladbar. CORS-Freigabe gibt es nur für Basalts
    eigene Herkunft (`tauri://localhost`, unter Android `http://tauri.localhost`).
  - Plugin-Code ist nicht sandboxed und konnte dieselben Bytes bereits über den Adapter lesen;
    die URL fügt nur einen zweiten, ebenso begrenzten Lesepfad hinzu, den auch Worker nutzen
    können. Es gibt weiterhin keine breite Asset-Freigabe.
- Plugin-Dateilöschung prüft die beobachtete Version, sichert die Bytes unter `.basalt/trash/`,
  prüft sie erneut und löscht erst danach. Ein Rennen zwischen letzter Prüfung und Löschung
  durch unkoordinierte externe Schreiber bleibt möglich. Ordnerlöschung wird abgelehnt.
- Das Dateimenü verwendet denselben nativen Löschpfad nach Bestätigung. Geladene und
  wiederhergestellte Notizentwürfe werden vorher mit ihrer ursprünglichen Konfliktbasis
  gespeichert. Plugin-interne, noch ungespeicherte Bearbeitungen sind nicht Bestandteil
  der Dateisicherung; Plugin-Dateien deshalb vorher speichern. Die Browser-Demo hält
  Sicherung und Entfernung gemeinsam in einem lokalen Speichervorgang fest und blendet
  `.basalt/` aus der Dateiliste aus. Sie ist kein Test des nativen Dateisystems.
- Umbenennen erfolgt derzeit nicht atomar: zuerst eine exklusive Kopie, dann die geprüfte
  Löschung des Originals. Bei unklarem Löschfehler bleibt die Zielkopie zur Wiederherstellung
  erhalten und der Fehler wird angezeigt. Zeitstempel und Dateirechte können sich dabei ändern;
  Links werden noch nicht automatisch angepasst. Groß-/Kleinschreibungswechsel auf
  case-insensitiven Dateisystemen sind nicht abgedeckt.
- Diese Plugin-Dateioperationen sind auf 64 MiB pro Datei begrenzt. Papierkorb und
  Versionssicherungen werden nicht automatisch bereinigt; sie belegen weiterhin Speicherplatz
  und sind keine sichere Datenlöschung. Wiederherstellung ist derzeit manuell.
- Kein automatischer Sync, kein Konto und keine Telemetrie.
- Debug-signierte Android-APKs sind Testartefakte, keine produktionssignierten Veröffentlichungen.
  Der feste Entwicklungsschlüssel liegt als Actions-Secret vor, nicht im Git-Verlauf.
  Produktive Releases werden über `.github/workflows/release.yml` mit einem separat verwalteten
  Android-Release-Schlüssel und einem OpenPGP-Schlüssel signiert; beide liegen nur als Secrets der
  GitHub-Umgebung `release` vor (siehe `docs/release-signing.md`). Releases entstehen als Entwurf
  und werden manuell freigegeben.
