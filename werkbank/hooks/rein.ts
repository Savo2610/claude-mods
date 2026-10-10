// Reine Hilfen der Werkbank: Ausgaben von git, lsof und ps lesen, Befehle
// deuten, Ports vergeben. Kein $ hier, damit alles ohne Host testbar bleibt.

export const WEB_BASIS = 5173
// main behält 8787 (so steht es in den Projekten); Worktrees ab 8801, weil 8788
// (Uploader) und 8790 (Kurzlink) lokal schon vergeben sind.
export const API_HAUPT = 8787
export const API_BASIS = 8800
const HAUPTBRANCHES = new Set(['main', 'master'])

export type Worktree = { pfad: string; head: string; branch: string | null }
export type Lauscher = { pid: number; cmd: string; port: number }

/** `git worktree list --porcelain`: der erste Eintrag ist der Hauptordner. */
export function leseWorktrees(ausgabe: string): Worktree[] {
  const aus: Worktree[] = []
  for (const block of ausgabe.split(/\n\s*\n/)) {
    const zeilen = block.split('\n')
    const pfad = zeilen.find(z => z.startsWith('worktree '))?.slice(9)
    if (!pfad || zeilen.includes('bare')) continue
    const head = zeilen.find(z => z.startsWith('HEAD '))?.slice(5) ?? ''
    const ref = zeilen.find(z => z.startsWith('branch '))?.slice(7)
    aus.push({ pfad, head, branch: ref ? ref.replace(/^refs\/heads\//, '') : null })
  }
  return aus
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: je Prozess und Port ein Eintrag. */
export function leseLauscher(ausgabe: string): Lauscher[] {
  const aus: Lauscher[] = []
  const gesehen = new Set<string>()
  let pid = 0
  let cmd = ''
  for (const zeile of ausgabe.split('\n')) {
    const art = zeile[0]
    const wert = zeile.slice(1)
    if (art === 'p') pid = Number(wert)
    else if (art === 'c') cmd = wert
    else if (art === 'n') {
      const port = Number(/:(\d+)$/.exec(wert)?.[1])
      const key = `${pid}:${port}`
      if (pid && port && !gesehen.has(key)) {
        gesehen.add(key)
        aus.push({ pid, cmd, port })
      }
    }
  }
  return aus
}

// Claude-Code-Sitzungen lauschen selbst auf einem lokalen Port und haben den
// Projektordner als cwd: sie sind kein Server und dürfen nie gestoppt werden
// (10.10.: /werkbank dev hat so die eigene Sitzung beendet).
const KEIN_SERVER = /claude/i
// Gestoppt wird nur, was nach Dev-Server aussieht (lsof kürzt den Namen auf 15 Zeichen).
const DEV_SERVER = /^(node|bun|deno|workerd|wrangler|vite|esbuild|npm|pnpm|yarn|python[\d.]*|ruby|php|java|hugo|astro|next-server.*)$/i

export function istServer(cmd: string): boolean {
  return !KEIN_SERVER.test(cmd)
}

/** Ob ein Lauscher gestoppt werden darf: auf einem festen Platz-Port oder ein bekannter Dev-Server. */
export function stoppbar(s: { cmd: string; art: string }): boolean {
  return istServer(s.cmd) && (s.art !== 'anderer' || DEV_SERVER.test(s.cmd))
}

/** `lsof -a -d cwd -p … -Fpn`: Prozess → Arbeitsordner. */
export function leseCwds(ausgabe: string): Map<number, string> {
  const m = new Map<number, string>()
  let pid = 0
  for (const zeile of ausgabe.split('\n')) {
    if (zeile[0] === 'p') pid = Number(zeile.slice(1))
    else if (zeile[0] === 'n' && pid) m.set(pid, zeile.slice(1))
  }
  return m
}

/** Die Pfade aus `git status --porcelain` (bei Umbenennung der neue), ohne den node_modules-Link. */
export function offenePfade(ausgabe: string): string[] {
  return ausgabe.split('\n')
    .filter(z => z.trim() && !/^\?\? node_modules\/?$/.test(z))
    .map(z => z.slice(3).split(' -> ').pop()!.replace(/^"(.*)"$/, '$1'))
}

/** Der Checkout mit der jüngsten Änderung (Commit oder offene Datei); bei Gleichstand der erste. */
export function zuletztGeaendert<T extends { geaendert: number }>(checkouts: readonly T[]): T | undefined {
  let best: T | undefined
  for (const c of checkouts) if (!best || c.geaendert > best.geaendert) best = c
  return best
}

/** `git status --porcelain`: geänderte Dateien, ohne den eigenen node_modules-Link. */
export function zaehleOffen(ausgabe: string): number {
  return ausgabe.split('\n').filter(z => z.trim() && !/^\?\? node_modules\/?$/.test(z)).length
}

export function normalisiere(p: string): string {
  const teile: string[] = []
  for (const t of p.split('/')) {
    if (!t || t === '.') continue
    if (t === '..') teile.pop()
    else teile.push(t)
  }
  return '/' + teile.join('/')
}

export function absolut(p: string, cwd: string, home: string): string {
  const q = p.replace(/^(['"])(.*)\1$/, '$2')
  if (q === '~' || q.startsWith('~/')) return normalisiere(home + q.slice(1))
  return normalisiere(q.startsWith('/') ? q : `${cwd}/${q}`)
}

/** Der Checkout, in dem ein Pfad liegt (längster Treffer), oder undefined. */
export function checkoutVon(pfad: string, checkouts: readonly string[]): string | undefined {
  let best: string | undefined
  for (const c of checkouts) {
    if ((pfad === c || pfad.startsWith(c + '/')) && (!best || c.length > best.length)) best = c
  }
  return best
}

const GIT = String.raw`git\s+(?:-[Cc]\s+("[^"]+"|'[^']+'|\S+)\s+)*`

/** Wo ein Befehl wirkt: git -C <pfad>, sonst das letzte cd, sonst cwd. */
export function befehlsOrt(befehl: string, cwd: string, home: string): string {
  const c = new RegExp(`(?:^|[\\s;&|(])git\\s+-C\\s+("[^"]+"|'[^']+'|\\S+)`).exec(befehl)
  if (c?.[1]) return absolut(c[1], cwd, home)
  let ort = cwd
  for (const cd of befehl.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) ort = absolut(cd[1]!, ort, home)
  return ort
}

export const PUSH = new RegExp(`(^|[\\s;&|(])${GIT}push\\b([^;&|]*)`)
const MERGE = new RegExp(`(^|[\\s;&|(])${GIT}merge\\b`)
const WT_ADD = new RegExp(`(^|[\\s;&|(])${GIT}worktree\\s+add\\b`)

/** Geht der Befehl nach main? Push mit main im Ziel, oder ohne Ziel vom Branch main aus. */
export function zielMain(befehl: string, branchAmOrt: string | null): boolean {
  const p = PUSH.exec(befehl)
  if (p) {
    const rest = (p[3] ?? '').replace(/\s-{1,2}[\w-]+(=\S+)?/g, ' ').trim().split(/\s+/).filter(Boolean)
    const refspecs = rest.slice(1)
    if (!refspecs.length) return !!branchAmOrt && HAUPTBRANCHES.has(branchAmOrt)
    return refspecs.some(r => HAUPTBRANCHES.has(r.split(':').pop()!.replace(/^refs\/heads\//, '')))
  }
  return MERGE.test(befehl) && !!branchAmOrt && HAUPTBRANCHES.has(branchAmOrt)
}

export function istWorktreeAdd(befehl: string): boolean {
  return WT_ADD.test(befehl)
}

/** Was ein Befehl löschen will: git worktree remove <pfad>, rm -r… <pfade>. */
export function loeschZiele(befehl: string, ort: string, home: string): string[] {
  const aus: string[] = []
  for (const m of befehl.matchAll(new RegExp(`(?:^|[\\s;&|(])${GIT}worktree\\s+remove\\s+((?:-{1,2}\\S+\\s+)*)("[^"]+"|'[^']+'|[^\\s;&|)]+)`, 'g'))) {
    aus.push(absolut(m[3]!, m[1] ? absolut(m[1], ort, home) : ort, home))
  }
  for (const m of befehl.matchAll(/(?:^|[\s;&|(])rm\s+((?:-\w+\s+)*)([^;&|]+)/g)) {
    if (!/r/i.test(m[1] ?? '')) continue
    for (const p of m[2]!.trim().split(/\s+/)) if (p && !p.startsWith('-')) aus.push(absolut(p, ort, home))
  }
  return aus
}

/** Fester Platz je Checkout: der Hauptordner 0, Worktrees der kleinste freie ab 1. */
export function naechsterPlatz(belegt: Iterable<number>): number {
  const s = new Set(belegt)
  let n = 1
  while (s.has(n)) n++
  return n
}

export function portsFuer(platz: number): { web: number; api: number } {
  return { web: WEB_BASIS + platz, api: platz === 0 ? API_HAUPT : API_BASIS + platz }
}

export function istHauptbranch(b: string | null): boolean {
  return !!b && HAUPTBRANCHES.has(b)
}

/** Shell-sicher in einfache Anführungszeichen. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Wie der Dev-Server startet: vite mit festem Port, sonst PORT. */
export function startBefehl(scripts: Record<string, string>, ports: { web: number; api: number }): { web?: string; api?: string } {
  const env = `API_PORT=${ports.api}`
  const dev = scripts.dev
  return {
    web: dev
      ? /\bvite\b/.test(dev)
        ? `${env} npm run dev -- --port ${ports.web} --strictPort`
        : `${env} PORT=${ports.web} npm run dev`
      : undefined,
    api: scripts['dev:api'] ? `${env} npm run dev:api` : undefined,
  }
}

export function fmtAlter(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  const std = Math.round(min / 60)
  return std < 48 ? `${std} h` : `${Math.round(std / 24)} Tagen`
}
