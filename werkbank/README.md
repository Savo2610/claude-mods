# werkbank

Claude-Code-Mod für Repos mit mehreren Checkouts (Hauptordner und
`git worktree`s): Jeder Checkout hat einen festen Platz mit eigenem Port, und
man sieht auf einen Blick, welcher Stand wo läuft, wer daran arbeitet und was
weg kann. Claude hält sich an diese Plätze, statt jedes Mal neu zu improvisieren.

## Was sie tut

- **Lagebild:** Die Werkbank folgt dem Repo, in dem Claude gerade arbeitet (auch
  per `cd` oder `git -C` aus einer anderen Sitzung heraus). Unter dem Prompt
  steht eine Zeile, wenn es etwas zu sagen gibt:
  `🛠 ▶ raupe :5174 · 👥 „Kabelsee-Wertung“ arbeitet in main · 🧹 1 zum Aufräumen`.
  `/werkbank` öffnet ein Fenster mit allen Checkouts, ihren Ports, dem Stand
  gegenüber `main`, offenen Dateien und Knöpfen (Starten, Öffnen, Stopp, Was drin?).
- **Feste Ports:** Der Hauptordner hat 5173 (API 8787), jeder Worktree den
  nächsten freien Platz: 5174/8801, 5175/8802, … (8788 und 8790 bleiben für
  Uploader und Kurzlink frei). Der Platz bleibt, solange es den Worktree gibt.
- **Dev-Server:** `/werkbank dev raupe` startet Web und API dieses Checkouts im
  Hintergrund (vite mit `--port … --strictPort`, `API_PORT` für beide), stoppt
  die anderen Server des Repos und öffnet die Vorschau. Ohne Branch startet
  `/werkbank dev` den zuletzt geänderten Checkout (jüngster Commit oder
  zuletzt bearbeitete offene Datei). Server, in deren Checkout
  gerade eine andere Sitzung arbeitet, bleiben stehen. Ein frischer Worktree
  bekommt einen Link auf die `node_modules` von main. Logs:
  `~/.claude/werkbank/logs/`. Die Server laufen weiter, wenn die Sitzung endet.
- **Für Claude:** ein Werkzeug `werkbank` (lage, dev, stopp, aufraeumen, was) und
  bei `git worktree add` ein Hinweis auf den festen Port. Nichts davon steht im
  Systemprompt, damit der Cache warm bleibt.
- **Aufräumen:** Nach einem Push oder Merge verschwindet am Ende des Zugs jeder
  Worktree, dessen Commits jetzt in main sind, der sauber ist und in dem keine
  andere Sitzung arbeitet, samt Branch und Server. `/werkbank aufräumen` nimmt
  auch leere Worktrees mit und sagt zum Rest, was noch drin ist.
- **Löschschutz:** `git worktree remove` oder `rm -r…` auf einen Checkout, in dem
  eine andere Sitzung arbeitet, und auf den Hauptordner lehnt die Mod ab.
- **Merge-Ampel:** Geht ein Push oder Merge nach `main`, während eine andere
  Sitzung im Repo arbeitet, erfährt Claude das mit Namen. Arbeitet sie im
  selben Checkout, wird angehalten.

Andere Sitzungen kennt die Mod aus `~/.claude/sessions/` (Ordner, beschäftigt
oder frei); läuft dort auch die Werkbank, weiß sie zudem, in welchem Worktree.

## Befehle

| Befehl | Wirkung |
| --- | --- |
| `/werkbank` | Fenster öffnen, Lage als Text |
| `/werkbank dev [branch]` | Dev-Server des Checkouts starten (ohne Branch: der zuletzt geänderte), andere stoppen, Vorschau öffnen |
| `/werkbank stopp [branch\|alle]` | Server stoppen |
| `/werkbank aufräumen` | Gemergte und leere Worktrees entfernen, den Rest erklären |
| `/werkbank was <branch>` | Commits und offene Dateien eines Checkouts |
| `/werkbank weg <branch>` | Worktree und Branch entfernen, auch ungemergt (nur sauber; der Rückweg wird genannt) |

## Entwickeln

`claude plugin validate werkbank` und `claude plugin test werkbank`.
Die Plugin-API für Mods ist Early Access und kann sich ändern.
