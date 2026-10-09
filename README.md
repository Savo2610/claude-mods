# claude-mods

Mods für [Claude Code](https://claude.com/claude-code), geschrieben mit der
Plugin-API für Function Hooks (Early Access). Beide sprechen Deutsch.

| Mod | Was sie tut | Installieren |
| --- | --- | --- |
| [telegram-draht](telegram-draht) | Fertig-Meldungen und Rückfragen aufs Handy, wenn du nicht am Rechner bist; antworten und weiterschreiben direkt in Telegram | `/plugin install telegram-draht --marketplace Savo2610/claude-mods` |
| [cache-waechter](cache-waechter) | Zeigt die Restzeit des Prompt-Caches, hält teure Nachrichten in einen kalten Cache an und fragt vor dem Abkühlen per Telegram nach | `/plugin install cache-waechter --marketplace Savo2610/claude-mods` |

Den Befehl in einer Claude-Code-Sitzung eingeben, dann `y` zum Hinzufügen des
Marketplace und einen Scope wählen. Nach Updates: `/plugin update` und `/reload-plugins`.

Beide Telegram-Funktionen nutzen `~/.claude/telegram.env`; eingerichtet wird
sie mit `/telegram einrichten` (siehe [telegram-draht](telegram-draht#einrichten-einmalig-2-minuten)).

Lizenz: MIT
