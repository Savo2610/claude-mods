# deploy-wacht

Claude-Code-Mod für Projekte mit Cloudflare **Workers Builds** (Auto-Deploy bei
jedem Push). Nach einem `git push` muss niemand mehr warten und nachsehen: die
Mod beobachtet den Build und sagt Bescheid.

## Was sie tut

- **Erkennt jeden Push**, den Claude macht (auch `git -C <pfad> push` oder
  `cd … && git push` aus einem Worktree): Sie vergleicht die Remote-Branches vor
  und nach dem Befehl. Ein Repo mit `wrangler.jsonc`/`.json`/`.toml` im
  Hauptordner gilt als Cloudflare-Projekt; der Worker-Name kommt von dort.
- **Sagt Claude sofort**, dass die Mod den Build beobachtet: keine
  selbstgebauten `curl`-und-`sleep`-Schleifen mehr.
- **Statuszeile unter dem Prompt:** `🚀 website baut 1:20` → `✅ website live (2:41)`
  oder `❌ website: Build fehlgeschlagen`; das Ergebnis bleibt 5 min stehen.
- **Grün:** Danach ruft sie einmal die Domain aus der wrangler-Konfiguration
  auf (z. B. veerka.mp) und warnt, falls die mit einem Fehler antwortet. Claude
  bekommt eine kurze Notiz, dass es live ist.
- **Rot:** Claude bekommt das Ende des Build-Logs als neue Nachricht, mit dem
  Auftrag, die Ursache zu finden und Kleines selbst zu beheben. Höchstens
  zweimal hintereinander; danach nur noch erklären, damit keine Schleife aus
  Fix, Push und Fehler entsteht. Mit `/deploy fehler melden` gibt es nur eine Notiz.
- **Kein Build** nach 3 min zu einem Push auf `main`: Hinweis (Repo nicht
  verbunden, Branch nicht im Trigger, Pfad ausgeschlossen). Bei anderen
  Branches ohne Vorschau-Builds bleibt sie still.
- **Telegram:** Bist du weg (1 min ohne Maus und Tastatur), kommt das Ergebnis
  aufs Handy. Nutzt `~/.claude/telegram.env` von
  [telegram-draht](../telegram-draht); ohne die Datei passiert hier nichts.

## Einrichten (einmalig)

1. Einen **Benutzer-Token** anlegen (dash.cloudflare.com → Profil → API-Tokens),
   **keinen** Konto-Token: die Builds-API weist Konto-Token mit „Invalid token“ ab.
   Berechtigungen (Konto): **Workers Builds Configuration · Lesen** (auch „Workers
   CI“) und **Workers-Skripte · Lesen**; Kontoressourcen: dein Konto. Nur Leserechte.
2. Den Token in eine Datei schreiben, **nicht** in den Claude-Chat:
   ```bash
   echo 'CLOUDFLARE_API_TOKEN=…' > ~/.claude/cloudflare.env
   chmod 600 ~/.claude/cloudflare.env
   ```
3. In Claude Code: `/deploy einrichten`. Die Mod prüft den Token, sucht die
   Konto-ID, trägt sie in die Datei ein und testet, ob Builds lesbar sind.

## Befehle

| Befehl | Wirkung |
| --- | --- |
| `/deploy` | Zustand, laufende Builds und der letzte Build des aktuellen Projekts (rot: mit Log-Ende) |
| `/deploy einrichten` | Token prüfen, Konto eintragen |
| `/deploy fehler beheben\|melden` | Roter Build: Claude behebt Kleines selbst (Standard) oder bekommt nur eine Notiz |
| `/deploy telegram an\|aus` | Ergebnis aufs Handy, wenn du weg bist (Standard an) |

## Entwickeln

`claude plugin validate deploy-wacht` und `claude plugin test deploy-wacht`.
Die Plugin-API für Mods ist Early Access und kann sich ändern.
