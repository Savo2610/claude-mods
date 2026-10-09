# cache-waechter

Claude-Code-Mod für den Prompt-Cache (Abo: 1 h für den Hauptverlauf).

- **Anzeige** unten rechts in der Fußzeile, standardmäßig „knapp“: ab 50k Tokens
  in den letzten 25 min und wenn der Cache kalt ist.
- **Warnung:** ab 150k Tokens wird die erste Nachricht in einen kalten Cache
  angehalten; der Text liegt wieder im Feld, Enter schickt ihn trotzdem.
- **Telegram:** ab 200k Tokens kommt 50 min nach der letzten Anfrage eine Frage
  mit den Knöpfen Komprimieren / Warmhalten / Nichts. Zugangsdaten in
  `~/.claude/telegram.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`); am
  einfachsten mit `/telegram einrichten` aus der Mod telegram-draht. Knöpfe und
  Texte für die Mod telegram-draht bleiben beim Abholen eine Minute liegen.

Installieren: `/plugin install cache-waechter --marketplace Savo2610/claude-mods`

`/cache` zeigt den Zustand; `/cache anzeige aus|knapp|immer|unten|oben`,
`/cache warnung an|aus|test`, `/cache telegram an|aus|test`.

Prüfen: `claude plugin validate cache-waechter` und `claude plugin test cache-waechter`.
Nach Änderungen in einer laufenden Sitzung `/reload-plugins`.
