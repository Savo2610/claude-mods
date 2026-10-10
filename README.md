# claude-mods

Mods für [Claude Code](https://claude.com/claude-code), geschrieben mit der
Plugin-API für Function Hooks (Early Access). Alle sprechen Deutsch.

| Mod | Was sie tut | Installieren |
| --- | --- | --- |
| [deploy-wacht](deploy-wacht) | Beobachtet nach jedem `git push` den Cloudflare-Build, zeigt den Stand unter dem Prompt, gibt Claude bei rotem Build das Log und meldet per Telegram, wenn du weg bist | `/plugin install deploy-wacht --marketplace Savo2610/claude-mods` |
| [telegram-draht](telegram-draht) | Fertig-Meldungen und Rückfragen aufs Handy, wenn du nicht am Rechner bist; antworten und weiterschreiben direkt in Telegram | `/plugin install telegram-draht --marketplace Savo2610/claude-mods` |
| [cache-waechter](cache-waechter) | Zeigt die Restzeit des Prompt-Caches, hält teure Nachrichten in einen kalten Cache an und fragt vor dem Abkühlen per Telegram nach | `/plugin install cache-waechter --marketplace Savo2610/claude-mods` |
| [werkbank](werkbank) | Zeigt, welcher Checkout eines Repos wo läuft, gibt jedem Worktree einen festen Port, startet/stoppt Dev-Server, räumt gemergte Worktrees auf und schützt Checkouts anderer Sessions | `/plugin install werkbank --marketplace Savo2610/claude-mods` |

Den Befehl in einer Claude-Code-Sitzung eingeben, dann `y` zum Hinzufügen des
Marketplace und einen Scope wählen. Nach Updates: `/plugin update` und `/reload-plugins`.

Alle Telegram-Funktionen nutzen `~/.claude/telegram.env`; eingerichtet wird
sie mit `/telegram einrichten` (siehe [telegram-draht](telegram-draht#einrichten-einmalig-2-minuten)).

Lizenz: MIT
