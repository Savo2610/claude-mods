import type { EngineInterface, Register } from 'claude-code'

import {
  absolut, befehlsOrt, checkoutVon, fmtAlter, istHauptbranch, istWorktreeAdd, leseCwds, leseLauscher, leseWorktrees,
  loeschZiele, naechsterPlatz, portsFuer, PUSH, q, startBefehl, zaehleOffen, zielMain,
} from './rein'

const SEK = 1000
const MIN = 60 * SEK
// So oft wird die Lage still aufgefrischt (Statuszeile); offen das Fenster öfter.
const AUFFRISCHEN_MS = 20 * SEK
const FENSTER_MS = 3 * SEK
// Wie lange eine Sitzung als „arbeitet in Checkout X“ gilt, nachdem Claude dort zuletzt etwas tat.
const SITZUNG_GILT_MS = 6 * 60 * MIN
const PANE = 'werkbank'
const BROWSER = 'mcp__Claude_Browser__preview_start'

type Checkout = {
  pfad: string
  name: string
  branch: string | null
  head: string
  haupt: boolean
  vor: number
  hinter: number
  offen: number
  alter: number
  platz: number
  web: number
  api: number
  /** Hatte eigene Commits und die stecken jetzt in main. */
  gemergt: boolean
  /** Keine eigenen Commits, nichts offen: ein leerer Worktree. */
  leer: boolean
}
type Server = { pid: number; port: number; cmd: string; pfad: string; art: 'web' | 'api' | 'anderer' }
type Sitzung = { sid: string; name: string; arbeitet: boolean; checkout?: string; ich: boolean }
type Lage = { repo: string; name: string; basis: string; checkouts: Checkout[]; server: Server[]; sitzungen: Sitzung[]; at: number }
type SitzungsEintrag = { repo: string; checkout: string; at: number }

type Zustand = {
  home: string
  sid: string
  /** Das Repo, um das es gerade geht: wo Claude zuletzt arbeitete, sonst cwd. */
  repo: string | null
  lage: Lage | null
  fensterOffen: boolean
  laedt: Promise<Lage | null> | null
  repoCache: Map<string, string | null>
  meinCheckout: string | null
  aufraeumenNachZug: Set<string>
  status: string | undefined
  meldung: string
}

// ---------- Host ----------

async function lauf($: EngineInterface, argv: string[], cwd?: string, timeoutMs = 15 * SEK) {
  try {
    return await $.process.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs })
  } catch {
    return { exitCode: -1, stdout: '', stderr: 'nicht startbar' }
  }
}

async function git($: EngineInterface, ort: string, args: string[]): Promise<string | null> {
  const r = await lauf($, ['git', '-C', ort, ...args])
  return r.exitCode === 0 ? r.stdout : null
}

/** Der Hauptordner des Repos, in dem `dir` liegt (auch aus einem Worktree heraus). */
async function repoVon($: EngineInterface, z: Zustand, dir: string): Promise<string | null> {
  if (z.repoCache.has(dir)) return z.repoCache.get(dir)!
  let d = dir
  // Ein Ordner, den es (noch) nicht gibt: am nächsten vorhandenen Elternordner fragen.
  for (let i = 0; i < 4 && !(await $.fs.exists(d).catch(() => false)); i++) d = d.replace(/\/[^/]+$/, '') || '/'
  const common = (await git($, d, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim()
  const repo = common?.endsWith('/.git') ? common.slice(0, -5) : null
  z.repoCache.set(dir, repo)
  return repo
}

async function basisVon($: EngineInterface, repo: string): Promise<string> {
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await git($, repo, ['rev-parse', '--verify', '-q', b])) return b
  }
  return 'HEAD'
}

async function plaetze($: EngineInterface, repo: string): Promise<Record<string, number>> {
  return ((await $.store.get(`plaetze:${repo}`)) as Record<string, number> | undefined) ?? {}
}

async function lauscher($: EngineInterface): Promise<{ pid: number; port: number; cmd: string; cwd: string }[]> {
  const r = await lauf($, ['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  const liste = leseLauscher(r.stdout)
  if (!liste.length) return []
  const pids = [...new Set(liste.map(l => l.pid))].join(',')
  const cwds = leseCwds((await lauf($, ['/usr/sbin/lsof', '-a', '-d', 'cwd', '-p', pids, '-Fpn'])).stdout)
  return liste.map(l => ({ ...l, cwd: cwds.get(l.pid) ?? '' }))
}

/** Laufende Sitzungen aus ~/.claude/sessions, mit dem, was die Mod über sie weiß. */
async function sitzungen($: EngineInterface, z: Zustand, repo: string, checkouts: string[], now: number): Promise<Sitzung[]> {
  const ordner = `${z.home}/.claude/sessions`
  let eintraege: { name: string }[] = []
  try { eintraege = await $.fs.list(ordner) } catch { return [] }
  const roh: { pid: number; sessionId: string; cwd: string; status?: string; name?: string }[] = []
  for (const e of eintraege) {
    if (!e.name.endsWith('.json')) continue
    try { roh.push(JSON.parse(await $.fs.read(`${ordner}/${e.name}`))) } catch { /* halb geschrieben */ }
  }
  if (!roh.length) return []
  const lebt = new Set((await lauf($, ['/bin/ps', '-o', 'pid=', '-p', roh.map(r => r.pid).join(',')])).stdout.split('\n').map(s => Number(s.trim())))
  const aus: Sitzung[] = []
  for (const r of roh) {
    if (!lebt.has(r.pid)) continue
    const e = (await $.store.get(`sitzung:${r.sessionId}`)) as SitzungsEintrag | undefined
    const checkout = e && e.repo === repo && now - e.at < SITZUNG_GILT_MS && checkouts.includes(e.checkout)
      ? e.checkout
      : checkoutVon(r.cwd, checkouts)
    const ich = r.sessionId === z.sid
    if (!checkout && !ich) continue
    aus.push({ sid: r.sessionId, name: r.name || r.sessionId.slice(0, 8), arbeitet: r.status === 'busy', checkout: ich ? z.meinCheckout ?? checkout : checkout, ich })
  }
  return aus
}

async function ladeLage($: EngineInterface, z: Zustand, repo: string): Promise<Lage | null> {
  const wl = await git($, repo, ['worktree', 'list', '--porcelain'])
  if (wl === null) return null
  const wts = leseWorktrees(wl)
  const basis = await basisVon($, repo)
  const now = await $.clock.now()
  // Feste Plätze: verschwundene Checkouts geben ihren frei, neue bekommen den kleinsten freien.
  const alt = await plaetze($, repo)
  const pl: Record<string, number> = {}
  for (const [i, w] of wts.entries()) if (i === 0) pl[w.pfad] = 0; else if (alt[w.pfad] !== undefined) pl[w.pfad] = alt[w.pfad]!
  for (const w of wts) if (pl[w.pfad] === undefined) pl[w.pfad] = naechsterPlatz(Object.values(pl))
  if (JSON.stringify(pl) !== JSON.stringify(alt)) await $.store.set(`plaetze:${repo}`, pl)

  const checkouts = await Promise.all(wts.map(async (w, i): Promise<Checkout> => {
    const [st, lr, ct] = await Promise.all([
      git($, w.pfad, ['status', '--porcelain']),
      git($, w.pfad, ['rev-list', '--left-right', '--count', `${basis}...HEAD`]),
      git($, w.pfad, ['log', '-1', '--format=%ct']),
    ])
    const [hinter = 0, vor = 0] = (lr ?? '0 0').trim().split(/\s+/).map(Number)
    const offen = st === null ? 0 : zaehleOffen(st)
    const key = `ungemergt:${w.pfad}`
    if (vor > 0) await $.store.set(key, true)
    const warUngemergt = vor === 0 && (await $.store.get(key)) === true
    const platz = pl[w.pfad] ?? 0
    return {
      pfad: w.pfad, name: i === 0 ? (w.branch ?? 'main') : (w.branch ?? w.pfad.split('/').pop()!), branch: w.branch, head: w.head,
      haupt: i === 0, vor, hinter, offen, alter: ct ? now - Number(ct.trim()) * SEK : 0, platz, ...portsFuer(platz),
      gemergt: i > 0 && warUngemergt && offen === 0, leer: i > 0 && !warUngemergt && vor === 0 && offen === 0,
    }
  }))
  const pfade = checkouts.map(c => c.pfad)
  const server: Server[] = []
  for (const l of await lauscher($)) {
    const pfad = checkoutVon(l.cwd, pfade)
    if (!pfad) continue
    const c = checkouts.find(x => x.pfad === pfad)!
    server.push({ pid: l.pid, port: l.port, cmd: l.cmd, pfad, art: l.port === c.web ? 'web' : l.port === c.api ? 'api' : 'anderer' })
  }
  return {
    repo, name: repo.split('/').pop() ?? repo, basis, checkouts, server,
    sitzungen: await sitzungen($, z, repo, pfade, now), at: now,
  }
}

async function frischeLage($: EngineInterface, z: Zustand, repo = z.repo): Promise<Lage | null> {
  // Noch kein Repo im Blick: das des Sitzungsordners, falls es eins gibt.
  if (!repo && !z.repoCache.has('§cwd')) {
    z.repoCache.set('§cwd', null)
    repo = z.repo = await repoVon($, z, await $.session.cwd())
  }
  if (!repo) return null
  if (z.laedt) return z.laedt
  z.laedt = (async () => {
    try {
      const lage = await ladeLage($, z, repo)
      if (repo === z.repo) {
        z.lage = lage
        zeichne($, z)
      }
      return lage
    } finally {
      z.laedt = null
    }
  })()
  return z.laedt
}

// ---------- Anzeige ----------

export function statusText(lage: Lage | null): string | undefined {
  if (!lage) return undefined
  const teile: string[] = []
  for (const c of lage.checkouts) {
    const s = lage.server.find(x => x.pfad === c.pfad && x.art === 'web')
    if (s) teile.push(`▶ ${c.name} :${s.port}`)
  }
  for (const s of lage.sitzungen) {
    if (s.ich || !s.arbeitet) continue
    const wo = lage.checkouts.find(c => c.pfad === s.checkout)?.name
    teile.push(`👥 „${s.name}“ arbeitet${wo ? ` in ${wo}` : ''}`)
  }
  const weg = lage.checkouts.filter(c => (c.gemergt || c.leer) && !benutzt(lage, c.pfad)).length
  if (weg) teile.push(`🧹 ${weg} zum Aufräumen`)
  return teile.length ? `🛠 ${teile.join(' · ')}` : undefined
}

function zeichne($: EngineInterface, z: Zustand) {
  const text = statusText(z.lage)
  if (text !== z.status) {
    z.status = text
    $.ui.status(text)
  }
  if (z.fensterOffen) $.ui.invalidate('ui.render')
}

/** Arbeitet eine andere Sitzung in diesem Checkout? */
function benutzt(lage: Lage, pfad: string, ausser?: string): Sitzung | undefined {
  return lage.sitzungen.find(s => !s.ich && s.sid !== ausser && s.checkout === pfad)
}

function zeile(lage: Lage, c: Checkout): string {
  const server = lage.server.filter(s => s.pfad === c.pfad)
  const ports = server.length ? server.map(s => `:${s.port}${s.art === 'api' ? ' (api)' : ''}`).join(' ') : '—'
  const stand = c.haupt
    ? (c.hinter ? `${c.hinter} hinter ${lage.basis}` : `= ${lage.basis}`)
    : c.gemergt ? 'gemergt' : c.leer ? 'leer' : `+${c.vor} Commits${c.hinter ? `, ${c.hinter} hinter main` : ''}`
  const offen = c.offen ? `, ${c.offen} Dateien offen` : ''
  const wer = lage.sitzungen.filter(s => s.checkout === c.pfad).map(s => s.ich ? 'diese Sitzung' : `„${s.name}“${s.arbeitet ? ' arbeitet' : ''}`).join(', ')
  return `${server.some(s => s.art === 'web') ? '▶' : c.gemergt ? '✓' : '○'} ${c.name.padEnd(14)} ${ports.padEnd(16)} ${(stand + offen).padEnd(30)} ${wer || (c.alter ? `zuletzt vor ${fmtAlter(c.alter)}` : '')}`
}

export function lageText(lage: Lage): string {
  return [`${lage.name}  (Platz-Ports: Web ${lage.checkouts.map(c => `${c.name}=${c.web}`).join(', ')})`, ...lage.checkouts.map(c => zeile(lage, c))].join('\n')
}

// ---------- Handeln ----------

function finde(lage: Lage, wer?: string): Checkout | undefined {
  if (!wer) return undefined
  const w = wer.trim()
  return lage.checkouts.find(c => c.branch === w || c.name === w || c.pfad === w || c.pfad.endsWith('/' + w) || c.pfad.split('/').pop() === w)
}

async function nachfahren($: EngineInterface, pid: number): Promise<number[]> {
  const kinder = (await lauf($, ['/usr/bin/pgrep', '-P', String(pid)])).stdout.split('\n').map(Number).filter(Boolean)
  const alle: number[] = []
  for (const k of kinder) alle.push(...await nachfahren($, k), k)
  return alle
}

/** Stoppt Server samt Kindern; ein npm darüber, das nur ihn trug, gleich mit. */
async function stoppe($: EngineInterface, server: readonly Server[]) {
  const ziele = new Set<number>()
  for (const s of server) {
    for (const k of await nachfahren($, s.pid)) ziele.add(k)
    ziele.add(s.pid)
    const eltern = (await lauf($, ['/bin/ps', '-o', 'ppid=,command=', '-p', String(s.pid)])).stdout.trim()
    const m = /^(\d+)\s+(.*)$/.exec(eltern)
    if (m) {
      const ppid = Number(m[1])
      const pc = (await lauf($, ['/bin/ps', '-o', 'command=', '-p', String(ppid)])).stdout
      if (/\bnpm\b|npm-cli|\bsh -c .*(vite|wrangler)/.test(pc)) ziele.add(ppid)
    }
  }
  if (ziele.size) await lauf($, ['/bin/kill', '-TERM', ...[...ziele].map(String)])
}

async function wartePort($: EngineInterface, port: number, sekunden = 40): Promise<boolean> {
  const r = await lauf($, ['/bin/sh', '-c',
    `i=0; while [ $i -lt ${sekunden * 2} ]; do /usr/sbin/lsof -nP -iTCP:${port} -sTCP:LISTEN -t >/dev/null 2>&1 && exit 0; sleep 0.5; i=$((i+1)); done; exit 1`],
  undefined, (sekunden + 5) * SEK)
  return r.exitCode === 0
}

async function oeffne($: EngineInterface, url: string): Promise<boolean> {
  try {
    if (!(await $.tool.list()).some(t => t.name === BROWSER)) return false
    const r = await $.tool.call({ tool: BROWSER, url } as never)
    return r.deny === undefined && !r.isError
  } catch {
    return false
  }
}

/** Startet den Dev-Server eines Checkouts auf seinem Platz und stoppt die anderen des Repos. */
async function starte($: EngineInterface, z: Zustand, lage: Lage, c: Checkout, oeffnen: boolean): Promise<string> {
  // Fremde Server bleiben, wo eine andere Sitzung gerade arbeitet.
  const andere = lage.server.filter(s => s.pfad !== c.pfad && !benutzt(lage, s.pfad)?.arbeitet)
  if (andere.length) await stoppe($, andere)
  const laeuft = lage.server.some(s => s.pfad === c.pfad && s.port === c.web)
  const url = `http://localhost:${c.web}/`
  const gestoppt = andere.length ? ` Gestoppt: ${[...new Set(andere.map(s => `${lage.checkouts.find(x => x.pfad === s.pfad)?.name ?? '?'} :${s.port}`))].join(', ')}.` : ''
  if (laeuft) {
    const offen = oeffnen && await oeffne($, url)
    return `${c.name} läuft schon auf ${url}${offen ? ' (in der Vorschau geöffnet)' : ''}.${gestoppt}`
  }
  let scripts: Record<string, string> = {}
  try { scripts = (JSON.parse(await $.fs.read(`${c.pfad}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {} } catch { /* kein Node-Projekt */ }
  const b = startBefehl(scripts, c)
  if (!b.web) return `${c.name}: kein „dev“-Skript in package.json, nichts zu starten.`
  // Ein frischer Worktree hat keine node_modules: der Link auf die von main spart npm install.
  let link = ''
  if (!c.haupt && !(await $.fs.exists(`${c.pfad}/node_modules`)) && await $.fs.exists(`${lage.repo}/node_modules`)) {
    await lauf($, ['/bin/ln', '-s', `${lage.repo}/node_modules`, `${c.pfad}/node_modules`])
    link = ' node_modules von main verlinkt.'
  }
  const logs = `${z.home}/.claude/werkbank/logs`
  const slug = `${lage.name}-${c.platz}`
  const start = (befehl: string, art: string) =>
    lauf($, ['/bin/sh', '-c', `mkdir -p ${q(logs)} && cd ${q(c.pfad)} && (nohup sh -c ${q(befehl)} > ${q(`${logs}/${slug}-${art}.log`)} 2>&1 &)`])
  const apiLaeuft = lage.server.some(s => s.pfad === c.pfad && s.port === c.api)
  if (b.api && !apiLaeuft) await start(b.api, 'api')
  await start(b.web, 'web')
  const ok = await wartePort($, c.web)
  await frischeLage($, z, lage.repo)
  if (!ok) {
    const log = await $.fs.read(`${logs}/${slug}-web.log`).catch(() => '')
    return `${c.name} startet nicht auf :${c.web}.${gestoppt}${link}\nEnde des Logs:\n${log.trim().split('\n').slice(-15).join('\n')}`
  }
  const offen = oeffnen && await oeffne($, url)
  return `${c.name} läuft auf ${url}${b.api ? ` (API :${c.api})` : ''}${offen ? ', in der Vorschau geöffnet' : ''}.${gestoppt}${link}`
}

async function stoppeCheckout($: EngineInterface, z: Zustand, lage: Lage, c: Checkout | 'alle'): Promise<string> {
  const ziel = lage.server.filter(s => c === 'alle' || s.pfad === c.pfad)
  if (!ziel.length) return 'Da läuft nichts.'
  await stoppe($, ziel)
  await frischeLage($, z, lage.repo)
  return `Gestoppt: ${ziel.map(s => `${lage.checkouts.find(x => x.pfad === s.pfad)?.name ?? '?'} :${s.port}`).join(', ')}.`
}

async function wasDrin($: EngineInterface, lage: Lage, c: Checkout): Promise<string> {
  const log = (await git($, c.pfad, ['log', '--format=- %s (%cr)', `${lage.basis}..HEAD`]))?.trim()
  const st = (await git($, c.pfad, ['status', '--short']))?.trim()
  return [
    `${c.name} (${c.pfad})`,
    log ? `Commits, die nicht in ${lage.basis} sind:\n${log}` : `Keine eigenen Commits gegenüber ${lage.basis}.`,
    st ? `Offene Änderungen:\n${st}` : 'Nichts offen.',
  ].join('\n')
}

/** Entfernt einen Worktree samt Branch und Server. `auchUngemergt`: Commits gehen verloren (Rückweg wird genannt). */
async function entferne($: EngineInterface, z: Zustand, lage: Lage, c: Checkout, auchUngemergt: boolean): Promise<string> {
  if (c.haupt) return `${c.name} ist der Hauptordner, der bleibt.`
  const s = benutzt(lage, c.pfad)
  if (s) return `${c.name}: Sitzung „${s.name}“ arbeitet dort, bleibt stehen.`
  if (c.offen) return `${c.name}: ${c.offen} Dateien offen, bleibt stehen (erst committen oder verwerfen).`
  if (c.vor > 0 && !auchUngemergt) return `${c.name}: ${c.vor} Commits nicht gemergt, bleibt stehen (/werkbank weg ${c.name} löscht trotzdem).`
  const server = lage.server.filter(x => x.pfad === c.pfad)
  if (server.length) await stoppe($, server)
  const link = await $.fs.stat(`${c.pfad}/node_modules`).catch(() => null)
  if (link?.isLink) await lauf($, ['/bin/rm', `${c.pfad}/node_modules`])
  const r = await lauf($, ['git', '-C', lage.repo, 'worktree', 'remove', c.pfad])
  if (r.exitCode !== 0) return `${c.name}: git worktree remove ging nicht: ${r.stderr.trim().split('\n')[0]}`
  let zusatz = ''
  if (c.branch && !istHauptbranch(c.branch)) {
    const d = await lauf($, ['git', '-C', lage.repo, 'branch', '-D', c.branch])
    if (d.exitCode === 0) zusatz = c.vor > 0 ? ` Branch gelöscht; zurückholen: git branch ${c.branch} ${c.head.slice(0, 10)}` : ' Branch gelöscht.'
  }
  await $.store.delete(`ungemergt:${c.pfad}`)
  return `${c.name} entfernt${server.length ? ' (Server gestoppt)' : ''}.${zusatz}`
}

/** Gemergte (und auf Wunsch leere) Worktrees weg; der Rest mit Begründung. */
async function aufraeumen($: EngineInterface, z: Zustand, lage: Lage, auchLeere: boolean): Promise<string[]> {
  const aus: string[] = []
  for (const c of lage.checkouts) {
    if (c.haupt) continue
    if (c.gemergt || (auchLeere && c.leer)) aus.push(await entferne($, z, lage, c, false))
    else if (auchLeere) aus.push(`${c.name}: ${c.vor ? `${c.vor} Commits nicht gemergt` : ''}${c.vor && c.offen ? ', ' : ''}${c.offen ? `${c.offen} Dateien offen` : ''} – bleibt (/werkbank was ${c.name} zeigt, was drin ist)`)
  }
  await frischeLage($, z, lage.repo)
  return aus
}

// ---------- Das Fenster ----------

function fenster($: EngineInterface, z: Zustand, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const lage = z.lage
  if (!lage) return <Text dimColor>Kein Git-Repo im Blick. Die Werkbank folgt dem Repo, in dem Claude arbeitet.</Text>
  const melde = (p: Promise<string | string[]>) => void p.then(t => {
    z.meldung = Array.isArray(t) ? (t.join('\n') || 'Nichts aufzuräumen.') : t
    $.ui.invalidate('ui.render')
  })
  return (
    <Box flexDirection="column" gap={0}>
      <Box key="kopf" flexDirection="row" gap={2}>
        <Text bold>{lage.name}</Text>
        <Text dimColor>{lage.checkouts[0]?.hinter ? `main ${lage.checkouts[0].hinter} hinter ${lage.basis}` : `main = ${lage.basis}`}</Text>
        <Button key="auf" dimColor onPress={() => melde(aufraeumen($, z, lage, true))}>Aufräumen</Button>
        <Button key="stopp" dimColor onPress={() => melde(stoppeCheckout($, z, lage, 'alle'))}>Alle stoppen</Button>
      </Box>
      {lage.checkouts.map(c => {
        const web = lage.server.find(s => s.pfad === c.pfad && s.art === 'web')
        return (
          <Box key={c.pfad} flexDirection="row" gap={2}>
            <Text>{zeile(lage, c)}</Text>
            {web
              ? <Button key="oe" variant="primary" onPress={() => melde(oeffne($, `http://localhost:${web.port}/`).then(ok => ok ? `${c.name} geöffnet.` : `http://localhost:${web.port}/`))}>Öffnen</Button>
              : <Button key="st" onPress={() => melde(starte($, z, lage, c, true))}>Starten</Button>}
            {web && <Button key="sp" dimColor onPress={() => melde(stoppeCheckout($, z, lage, c))}>Stopp</Button>}
            {!c.haupt && <Button key="was" dimColor onPress={() => melde(wasDrin($, lage, c))}>Was drin?</Button>}
          </Box>
        )
      })}
      {z.meldung && <Text key="meldung" dimColor>{z.meldung}</Text>}
    </Box>
  )
}

// ---------- Für Claude ----------

const WERKZEUG_TEXT = [
  'Die Werkbank des Repos, in dem du arbeitest: jeder Checkout (Hauptordner und git-Worktrees) hat einen festen Port.',
  'Nutze sie, um Dev-Server zu starten oder zu wechseln, statt `npm run dev` per Bash, neuer launch.json-Einträge oder preview_start mit name.',
  'aktion: "lage" zeigt Checkouts, Ports, laufende Server und andere Sitzungen; "dev" startet den Server des Checkouts (Branch- oder Ordnername; leer = wo du gerade arbeitest), stoppt die anderen dieses Repos und öffnet die Vorschau;',
  '"stopp" stoppt ihn ("alle" für alle); "aufraeumen" entfernt gemergte und leere Worktrees samt Branch; "was" zeigt Commits und offene Dateien eines Checkouts.',
].join(' ')

async function werkzeug($: EngineInterface, z: Zustand, aktion: string, wer?: string): Promise<string> {
  const lage = await frischeLage($, z)
  if (!lage) return 'Kein Git-Repo im Blick: erst in einem Repo arbeiten (cd oder git -C).'
  const c = finde(lage, wer) ?? (wer ? undefined : lage.checkouts.find(x => x.pfad === z.meinCheckout) ?? lage.checkouts[0])
  if (wer && !c && wer !== 'alle') return `Keinen Checkout „${wer}“ gefunden.\n${lageText(lage)}`
  if (aktion === 'dev') return starte($, z, lage, c!, true)
  if (aktion === 'stopp') return stoppeCheckout($, z, lage, wer === 'alle' ? 'alle' : c!)
  if (aktion === 'aufraeumen') return (await aufraeumen($, z, lage, true)).join('\n') || 'Nichts aufzuräumen.'
  if (aktion === 'was') return wasDrin($, lage, c!)
  return lageText(lage)
}

// ---------- Hooks ----------

/** Merkt, in welchem Checkout Claude gerade arbeitet, auch für die anderen Sitzungen. */
async function folge($: EngineInterface, z: Zustand, dir: string) {
  const repo = await repoVon($, z, dir)
  if (!repo) return
  if (repo !== z.repo || !z.lage) {
    z.repo = repo
    await frischeLage($, z)
  }
  const checkout = checkoutVon(dir, z.lage?.checkouts.map(c => c.pfad) ?? []) ?? repo
  if (checkout === z.meinCheckout) return
  z.meinCheckout = checkout
  await $.store.set(`sitzung:${z.sid}`, { repo, checkout, at: await $.clock.now() } satisfies SitzungsEintrag)
}


export const register: Register = on => {
  const z: Zustand = {
    home: '', sid: '', repo: null, lage: null, fensterOffen: false, laedt: null, repoCache: new Map(),
    meinCheckout: null, aufraeumenNachZug: new Set(), status: undefined, meldung: '',
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    z.home = (await $.env.get('HOME')) ?? ''
    z.sid = await $.session.id()
    await $.command.register({
      name: 'werkbank',
      description: 'Checkouts, Ports und Dev-Server des Repos (werkbank)',
      argumentHint: '[dev <branch> | stopp [<branch>|alle] | aufräumen | was <branch> | weg <branch>]',
      immediate: true,
    })
    await $.tool.register({
      name: 'werkbank',
      description: WERKZEUG_TEXT,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          aktion: { type: 'string', enum: ['lage', 'dev', 'stopp', 'aufraeumen', 'was'] },
          checkout: { type: 'string', description: 'Branch- oder Ordnername des Checkouts; leer: wo du gerade arbeitest' },
        },
        required: ['aktion'],
      },
    })
    z.repo = await repoVon($, z, e.cwd)
    void frischeLage($, z)
    $.clock.every(FENSTER_MS, () => {
      void $.clock.now().then(t => {
        if (z.repo && (z.fensterOffen || !z.lage || t - z.lage.at >= AUFFRISCHEN_MS)) void frischeLage($, z)
      })
    })
    return r
  })

  on('tool.call', { tool: 'mcp__werkbank__werkbank' }, async ($, e) => {
    const i = e as unknown as { aktion?: string; checkout?: string }
    try {
      return { result: await werkzeug($, z, i.aktion ?? 'lage', i.checkout || undefined) } as never
    } catch (err) {
      return { deny: `werkbank: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // Wo Claude schreibt, da arbeitet diese Sitzung.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const i = e as unknown as { file_path?: string; notebook_path?: string }
    const p = i.file_path ?? i.notebook_path
    if (p && z.home) {
      try { await folge($, z, p.replace(/\/[^/]*$/, '')) } catch { /* nur Beobachtung */ }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    let ort = ''
    let hinweis: string | null = null
    let vorher: Set<string> | null = null
    try {
      ort = befehlsOrt(e.command, await $.session.cwd(), z.home)
      if (/\bgit\b|\bcd\b|\brm\b/.test(e.command)) await folge($, z, ort)
      const lage = await frischeLage($, z)
      if (lage) {
        // Löschschutz: kein Checkout, in dem eine andere Sitzung arbeitet, und nie der Hauptordner.
        for (const ziel of loeschZiele(e.command, ort, z.home)) {
          const c = lage.checkouts.find(x => x.pfad === ziel || x.pfad.startsWith(ziel + '/'))
          if (!c) continue
          if (c.haupt) return { deny: `werkbank: ${ziel} enthält den Hauptordner von ${lage.name}; das lösche ich nicht.` }
          const s = benutzt(lage, c.pfad)
          if (s) return { deny: `werkbank: Im Checkout ${c.name} (${c.pfad}) arbeitet die Sitzung „${s.name}“${s.arbeitet ? ' gerade' : ''}. Nicht löschen; frag Julian.` }
        }
        // Merge-Ampel: nach main, während andere Sitzungen im Repo arbeiten.
        const meins = checkoutVon(ort, lage.checkouts.map(c => c.pfad))
        const branch = lage.checkouts.find(c => c.pfad === meins)?.branch ?? null
        if (zielMain(e.command, branch)) {
          const aktive = lage.sitzungen.filter(s => !s.ich && s.arbeitet)
          const gleich = aktive.find(s => s.checkout === meins)
          if (gleich) return { deny: `werkbank: Die Sitzung „${gleich.name}“ arbeitet gerade im selben Checkout (${meins}). Erst abstimmen: frag Julian, ob du jetzt nach main bringen sollst.` }
          if (aktive.length) {
            hinweis = `werkbank: Gleichzeitig arbeiten im Repo ${aktive.map(s => `„${s.name}“${s.checkout ? ` (in ${lage.checkouts.find(c => c.pfad === s.checkout)?.name})` : ''}`).join(', ')}. Ihre Änderungen sind davon nicht betroffen; erwähne es Julian, falls sie dieselben Dateien anfassen könnten.`
          }
        }
        if (istWorktreeAdd(e.command)) vorher = new Set(lage.checkouts.map(c => c.pfad))
      }
    } catch { /* der Befehl läuft trotzdem */ }
    const r = await next(e)
    if (r.deny !== undefined || r.isError || !z.repo) return r
    const kontext: string[] = hinweis ? [hinweis] : []
    try {
      if (vorher || PUSH.test(e.command) || /\bgit\b[^;&|]*\b(merge|worktree|branch|checkout|switch)\b/.test(e.command)) {
        const lage = await frischeLage($, z)
        if (lage && vorher) {
          for (const c of lage.checkouts.filter(x => !vorher!.has(x.pfad))) {
            kontext.push(`werkbank: Der neue Checkout ${c.name} (${c.pfad}) hat den festen Port ${c.web} (API ${c.api}). Starte seinen Dev-Server mit dem Werkzeug werkbank (aktion "dev", checkout "${c.name}"), nicht per npm run dev oder neuem launch.json-Eintrag.`)
          }
        }
        // Nach einem Push oder Merge: gemergte Worktrees nach diesem Zug wegräumen.
        if (lage && (PUSH.test(e.command) || /\bgit\b[^;&|]*\bmerge\b/.test(e.command))) z.aufraeumenNachZug.add(lage.repo)
      }
    } catch { /* nur Beobachtung */ }
    return kontext.length ? { ...r, context: [...(r.context ?? []), ...kontext] } : r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || !z.aufraeumenNachZug.size) return r
    const repos = [...z.aufraeumenNachZug]
    z.aufraeumenNachZug.clear()
    for (const repo of repos) {
      // Erst nachsehen, was main jetzt enthält (der Push hat origin/main schon bewegt).
      const lage = await frischeLage($, z, repo)
      if (!lage) continue
      // Auch der Worktree, aus dem diese Sitzung gepusht hat: der Zug ist vorbei.
      const fertig = lage.checkouts.filter(c => c.gemergt && !benutzt(lage, c.pfad))
      if (!fertig.length) continue
      const aus = await aufraeumen($, z, { ...lage, checkouts: [lage.checkouts[0]!, ...fertig] }, false)
      if (fertig.some(c => c.pfad === z.meinCheckout)) z.meinCheckout = repo
      const text = `🧹 Werkbank: ${aus.join(' ')}`
      $.ui.toast(text, { timeoutMs: 8 * SEK })
      try {
        await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
      } catch { /* nur Anzeige */ }
    }
    return r
  })

  on('command.run', { command: 'werkbank' }, async ($, e) => {
    const [was = '', ...rest] = String(e.args ?? '').trim().split(/\s+/)
    const wer = rest.join(' ') || undefined
    if (!was) {
      z.fensterOffen = true
      await frischeLage($, z)
      await $.ui.open({ id: PANE, title: 'Werkbank' })
      return { text: z.lage ? lageText(z.lage) : 'Kein Git-Repo im Blick.' }
    }
    const lage = await frischeLage($, z)
    if (!lage) return { text: 'Kein Git-Repo im Blick: die Werkbank folgt dem Repo, in dem Claude arbeitet, sonst dem Ordner der Sitzung.' }
    const c = finde(lage, wer)
    const aktion = was.toLowerCase().replace('ä', 'ae')
    if (aktion === 'aufraeumen') return { text: (await aufraeumen($, z, lage, true)).join('\n') || 'Nichts aufzuräumen.' }
    if (aktion === 'stopp') return { text: await stoppeCheckout($, z, lage, wer === 'alle' || !wer ? 'alle' : c ?? 'alle') }
    if (wer && !c) return { text: `Keinen Checkout „${wer}“ gefunden.\n\n${lageText(lage)}` }
    const ziel = c ?? lage.checkouts.find(x => x.pfad === z.meinCheckout) ?? lage.checkouts[0]!
    if (aktion === 'dev') return { text: await starte($, z, lage, ziel, true) }
    if (aktion === 'was') return { text: await wasDrin($, lage, ziel) }
    if (aktion === 'weg') return { text: c ? await entferne($, z, lage, c, true) : 'Welchen? /werkbank weg <branch>' }
    return { text: `„${was}“ kenne ich nicht.\n\n${lageText(lage)}\n\n/werkbank [dev <branch> | stopp [<branch>|alle] | aufräumen | was <branch> | weg <branch>]` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    z.fensterOffen = false
    z.meldung = ''
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => fenster($, z, e))
}
