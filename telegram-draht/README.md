# telegram-draht

Claude-Code-Mod: Telegram als Draht zum Handy. Du schickst einen Auftrag ab,
stehst auf, und Claude meldet sich, wenn es fertig ist oder eine Frage hat.
Antworten kannst du direkt in Telegram.

## Was sie tut

- **Fertig-Meldung, wenn du weg bist:** Hat seit 1 min niemand Maus oder
  Tastatur angefasst (macOS-Leerlauf über `ioreg`), kommt der Abschluss aufs
  Handy, egal wie lange der Auftrag lief. Sitzt du am Rechner, kommt nichts.
  Lange Antworten kommen als Anfang und Ende, formatiert (fett, Code, Links).
  Ist der Leerlauf nicht messbar (kein Mac), gilt: ab 10 min Laufzeit.
- **Antworten = weiterschreiben:** Antwortest du in Telegram auf eine
  Fertig-Meldung, landet dein Text als neue Nachricht in der Sitzung. Das
  Ergebnis kommt zurück, auch wenn es schnell ging. Gilt 12 h oder bis am
  Rechner weitergeschrieben wird.
- **📱 In der App weitermachen:** Der Knopf unter einer Fertig-Meldung schaltet
  Remote Control für die Sitzung ein (Desktop-App: direkt, ohne Modell;
  Terminal: `/remote-control`). Dann geht es in der Claude-App unter Code weiter.
- **Rückfragen:** Bleibt eine `AskUserQuestion` 25 s unbeantwortet (bist du schon
  weg: sofort), kommt sie mit Knöpfen aufs Handy. Mehrfachauswahl: antippen,
  dann „Fertig“. Eigener Text: einfach antworten. Es gilt die erste Antwort,
  Rechner oder Handy; die andere Seite wird abgeräumt.

Die Mod spricht Deutsch.

## Installieren

```
/plugin install telegram-draht --marketplace Savo2610/claude-mods
```

## Einrichten (einmalig, 2 Minuten)

1. In Telegram **@BotFather** öffnen, `/newbot` schicken, Namen wählen. Er
   antwortet mit einem Token wie `123456789:AAH…`.
2. Den Token in die Datei `~/.claude/telegram.env` schreiben, **nicht** in den
   Claude-Chat (sonst steht er im Verlauf):
   ```bash
   echo 'TELEGRAM_BOT_TOKEN=123456789:AAH…' > ~/.claude/telegram.env
   chmod 600 ~/.claude/telegram.env
   ```
3. Deinem neuen Bot in Telegram irgendeine Nachricht schicken (z. B. „hallo“).
4. In Claude Code: `/telegram einrichten`. Die Mod sucht deinen Chat, trägt
   `TELEGRAM_CHAT_ID` in die Datei ein und schickt eine Bestätigung.

Danach `/telegram test`: Es kommt eine Probe-Meldung, auf die du antworten kannst.

Der Bot reagiert nur auf den eingetragenen Chat; schreibt ihm jemand anderes,
passiert nichts.

## Einstellungen

`/telegram` zeigt den Zustand (auch, ob der Leerlauf messbar ist).

| Befehl | Wirkung |
| --- | --- |
| `/telegram weg <min>\|aus` | Ab so viel Leerlauf giltst du als weg (Standard 1) |
| `/telegram fertig <min>\|aus` | Zusätzlich jeden Auftrag ab so viel Laufzeit melden, auch wenn du da bist (Standard aus) |
| `/telegram fragen <sek>\|sofort\|aus` | Wann Rückfragen aufs Handy gehen (Standard 25 s) |
| `/telegram test` | Probe-Meldung schicken |
| `/telegram einrichten` | Chat zum Token suchen und eintragen |

## Meldungen auf Zuruf (optional)

`bin/tg` schickt einen beliebigen Text an denselben Chat, praktisch, um eine
Meldung an einen langen Befehl zu hängen:

```bash
cp bin/tg ~/.claude/bin/tg   # aus dem Plugin-Ordner
make build; ~/.claude/bin/tg "Build fertig (Exit $?)"
```

Eine Zeile in deiner `~/.claude/CLAUDE.md` bringt Claude bei, das bei
„informier mich, wenn es fertig ist“ selbst zu tun:

```markdown
- "Informier mich (bei Abschluss)" heißt: `~/.claude/bin/tg "Text"`. Läuft danach noch ein Prozess, hänge die Meldung an ihn: `befehl; ~/.claude/bin/tg "fertig (Exit $?)"`.
```

Hat Claude in einem Zug selbst per `~/.claude/bin/tg` gemeldet, schickt die
Mod keine zweite Meldung.

## Zusammen mit cache-waechter

Beide Mods lesen denselben Bot und dieselbe `telegram.env`. Jede lässt die
Telegram-Updates der anderen eine Minute liegen, damit keine Antwort verloren geht.

## Entwickeln

`claude plugin validate telegram-draht` und `claude plugin test telegram-draht`.
Die Plugin-API für Mods ist Early Access und kann sich ändern.
