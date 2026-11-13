TAGWERK auf Cloudflare (mit Login)

Inhalt
  public/          die App (Seite, Icons, Schriften, Service Worker)
  src/worker.js    Server: Login und Datenspeicher
  wrangler.jsonc   Einstellungen für Cloudflare
  package.json     Werkzeug zum Veröffentlichen

Passwort
  Das Passwort steht nicht in diesen Dateien. Du legst es in Cloudflare als Secret
  mit dem Namen APP_PASSWORD fest (mindestens 8 Zeichen, besser 12 oder mehr).
  Ändern: Secret in Cloudflare neu setzen. Dann musst du dich auf allen Geräten neu anmelden.

Änderungen an der App
  Nach jeder Änderung an public/ den Wert VERSION in public/sw.js erhöhen (zum Beispiel tagwerk-v3).
  Die neue Version erscheint beim zweiten Öffnen der App.
