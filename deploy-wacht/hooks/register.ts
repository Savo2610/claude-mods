import type { EngineInterface, Register } from 'claude-code'

const SEK = 1000
const MIN = 60 * SEK
// Ein Build von veerka.mp dauert 1–3 min: alle 10 s nachsehen reicht, die
// Statuszeile tickt trotzdem jede Sekunde.
const POLL_MS = 10 * SEK
// Taucht so lange kein Build zum Commit auf, hat Cloudflare den Push nicht gebaut
// (kein Trigger für den Branch, Pfad ausgeschlossen, Repo nicht verbunden).
export const KEIN_BUILD_NACH_MS = 3 * MIN
const AUFGEBEN_NACH_MS = 25 * MIN
// So lange bleibt das Ergebnis unter dem Prompt stehen.
const ERGEBNIS_ZEIGEN_MS = 5 * MIN
const LOG_ZEILEN = 60
// Höchstens so oft hintereinander bekommt Claude einen roten Build zum Beheben:
// danach nur noch melden, damit keine Schleife aus Fix, Push, Fehler entsteht.
export const BEHEBEN_MAX = 2
// Wer so lange weder Maus noch Tastatur angefasst hat, ist weg (wie telegram-draht).
const WEG_AB_MS = MIN
const API = 'https://api.cloudflare.com/client/v4'
// git push, auch als git -C <pfad> push, irgendwo in einer Befehlskette.
export const PUSH = /(^|[\s;&|(])git\s+(?:-[Cc]\s+("[^"]+"|'[^']+'|\S+)\s+)*push\b/
const PRODUKTION = new Set(['main', 'master'])

type CfZugang = { token: string; konto?: string }
type TgZugang = { token: string; chat: string }
export type Build = {
  build_uuid: string
  status?: string
  build_outcome?: string | null
  created_on?: string
  stopped_on?: string
  build_trigger_metadata?: { commit_hash?: string; branch?: string; commit_message?: string }
}
export type Stand = 'wartet' | 'baut' | 'live' | 'fehler' | 'abgebrochen' | 'kein-build' | 'aufgegeben'
export type Konfig = { name?: string; konto?: string; domain?: string }
export type Geschoben = { branch: string; sha: string }

type Wache = {
  repo: string
  projekt: string
  worker: string
  konto?: string
  domain?: string
  branch: string
  sha: string
  start: number
  stand: Stand
  build?: string
  nachricht?: string
  dauer?: number
  ende?: number
  hinweis?: string
}

type Zustand = {
  cf: CfZugang | null | undefined
  tg: TgZugang | null | undefined
  wachen: Wache[]
  /** beheben: Claude bekommt einen roten Build als Nachricht; melden: nur Hinweis. */
  fehlerArt: 'beheben' | 'melden'
  telegram: boolean
  /** Wie oft hintereinander Claude pro Repo schon beheben sollte. */
  behoben: Map<string, number>
  /** Für Claude, sobald kein Zug mehr läuft. */
  notizen: string[]
  zugLaeuft: boolean
  ticker: { cancel(): void } | null
  zuletztGeholt: number
  holt: boolean
  status: string | undefined
  ohneTokenGesagt: boolean
  fehler: string
}

function neuerZustand(): Zustand {
  return {
    cf: undefined, tg: undefined, wachen: [], fehlerArt: 'beheben', telegram: true, behoben: new Map(),
    notizen: [], zugLaeuft: false, ticker: null, zuletztGeholt: 0, holt: false, status: undefined,
    ohneTokenGesagt: false, fehler: '',
  }
}

// ---------- Reine Hilfen (getestet) ----------

function leseWerte(text: string): Record<string, string> {
  const werte: Record<string, string> = {}
  for (const zeile of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)=(.*)$/.exec(zeile)
    if (m?.[1] && m[2] !== undefined) werte[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return werte
}

/** Liest ~/.claude/cloudflare.env. */
export function leseCf(text: string): CfZugang | null {
  const w = leseWerte(text)
  return w.CLOUDFLARE_API_TOKEN ? { token: w.CLOUDFLARE_API_TOKEN, konto: w.CLOUDFLARE_ACCOUNT_ID || undefined } : null
}

/** Liest ~/.claude/telegram.env (dieselbe Datei wie telegram-draht). */
export function leseTg(text: string): TgZugang | null {
  const w = leseWerte(text)
  return w.TELEGRAM_BOT_TOKEN && w.TELEGRAM_CHAT_ID ? { token: w.TELEGRAM_BOT_TOKEN, chat: w.TELEGRAM_CHAT_ID } : null
}

// Entfernt Zeilen- und Blockkommentare aus JSONC; Zeichenketten bleiben unberührt (https://…).
export function ohneKommentare(text: string): string {
  let aus = ''
  let inText = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inText) {
      aus += c
      if (c === '\\') aus += text[++i] ?? ''
      else if (c === '"') inText = false
    } else if (c === '"') {
      inText = true
      aus += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      aus += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else aus += c
  }
  return aus
}

function domainAus(muster: unknown): string | undefined {
  const host = typeof muster === 'string' ? muster.split('/')[0] : undefined
  return host && !host.includes('*') ? host : undefined
}

/** Name, Konto und (erste feste) Domain aus wrangler.jsonc/.json/.toml. */
export function leseKonfig(datei: string, text: string): Konfig {
  if (datei.endsWith('.toml')) {
    const kopf = text.split(/^\s*\[/m)[0] ?? ''
    const wert = (s: string, k: string) => new RegExp(`^\\s*${k}\\s*=\\s*["']([^"']+)["']`, 'm').exec(s)?.[1]
    const route = /pattern\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? wert(kopf, 'route')
    return { name: wert(kopf, 'name'), konto: wert(kopf, 'account_id'), domain: domainAus(route) }
  }
  try {
    const j = JSON.parse(ohneKommentare(text).replace(/,(\s*[}\]])/g, '$1')) as {
      name?: string; account_id?: string; route?: string | { pattern?: string }; routes?: (string | { pattern?: string })[]
    }
    const r = j.routes?.[0] ?? j.route
    return { name: j.name, konto: j.account_id, domain: domainAus(typeof r === 'string' ? r : r?.pattern) }
  } catch {
    return { name: /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1] }
  }
}

/** Ausgabe von git for-each-ref refs/remotes: Remote-Branch → Commit. */
export function leseRefs(ausgabe: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const zeile of ausgabe.split('\n')) {
    const [name, sha] = zeile.trim().split(/\s+/)
    if (name && sha && name.includes('/') && !name.endsWith('/HEAD')) m.set(name, sha)
  }
  return m
}

/** Was ein Push bewegt hat: Remote-Branches mit neuem Commit. */
export function geschoben(vorher: Map<string, string>, nachher: Map<string, string>): Geschoben[] {
  const aus: Geschoben[] = []
  for (const [name, sha] of nachher) {
    if (vorher.get(name) !== sha) aus.push({ branch: name.slice(name.indexOf('/') + 1), sha })
  }
  return aus
}

function pfad(p: string, cwd: string, home: string): string {
  const q = p.replace(/^(['"])(.*)\1$/, '$2')
  if (q === '~' || q.startsWith('~/')) return home + q.slice(1)
  return q.startsWith('/') ? q : `${cwd.replace(/\/+$/, '')}/${q}`
}

/** In welchem Ordner der Push lief: git -C <pfad>, sonst das letzte cd davor, sonst cwd. */
export function repoOrt(befehl: string, cwd: string, home: string): string {
  const m = PUSH.exec(befehl)
  if (!m) return cwd
  const c = /-C\s+("[^"]+"|'[^']+'|\S+)/.exec(m[0])
  if (c?.[1]) return pfad(c[1], cwd, home)
  const davor = befehl.slice(0, m.index + m[1]!.length)
  let ort = cwd
  for (const cd of davor.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) ort = pfad(cd[1]!, ort, home)
  return ort
}

export function findeBuild(builds: readonly Build[], sha: string): Build | undefined {
  return builds.find(b => {
    const h = b.build_trigger_metadata?.commit_hash
    return !!h && h.length >= 7 && (sha.startsWith(h) || h.startsWith(sha))
  })
}

export function standVon(b: Build): Stand {
  if (b.status === 'stopped') return b.build_outcome === 'success' ? 'live' : b.build_outcome === 'fail' ? 'fehler' : 'abgebrochen'
  return b.status === 'queued' ? 'wartet' : 'baut'
}

/** Die letzten Zeilen des Build-Logs, ohne Farbcodes; nimmt [zeit, text], {message} oder Text. */
export function logZeilen(result: unknown, n = LOG_ZEILEN): string[] {
  const roh = (result as { lines?: unknown } | null)?.lines ?? result
  if (!Array.isArray(roh)) return []
  return roh
    .map(z => Array.isArray(z) ? String(z.at(-1) ?? '') : typeof z === 'string' ? z : String((z as { message?: unknown })?.message ?? ''))
    // eslint-disable-next-line no-control-regex
    .map(z => z.replace(/\u001b\[[0-9;]*m/g, '').trimEnd())
    .filter(Boolean)
    .slice(-n)
}

/** Ob der Branch live geht (main/master); andere bauen höchstens eine Vorschau. */
export function produktion(w: { branch: string }): boolean {
  return PRODUKTION.has(w.branch)
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / SEK))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Was unter dem Prompt steht: laufende Builds mit Zeit, frische Ergebnisse. */
export function statusText(wachen: readonly Wache[], now: number): string | undefined {
  const teile: string[] = []
  for (const w of wachen) {
    const wer = produktion(w) ? w.worker : `${w.worker} (${w.branch})`
    if (w.stand === 'wartet') teile.push(`🚀 ${wer}: wartet auf Build ${mmss(now - w.start)}`)
    else if (w.stand === 'baut') teile.push(`🚀 ${wer} baut ${mmss(now - w.start)}`)
    else if (w.ende && now - w.ende < ERGEBNIS_ZEIGEN_MS) {
      if (w.stand === 'live') teile.push(`✅ ${wer} live${w.dauer ? ` (${mmss(w.dauer)})` : ''}${w.hinweis ? ` · ⚠️ ${w.hinweis}` : ''}`)
      else if (w.stand === 'fehler') teile.push(`❌ ${wer}: Build fehlgeschlagen`)
      else if (w.stand === 'kein-build') teile.push(`⚠️ ${wer}: kein Build zu ${w.sha.slice(0, 7)}`)
      else if (w.stand === 'abgebrochen') teile.push(`⏹ ${wer}: Build abgebrochen`)
      else teile.push(`⏱ ${wer}: nach ${Math.round(AUFGEBEN_NACH_MS / MIN)} min kein Ergebnis`)
    }
  }
  return teile.length ? `${teile.join(' · ')}` : undefined
}


// ---------- Host: Dateien, git, Netz ----------

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function lies($: EngineInterface, p: string): Promise<string | null> {
  try { return await $.fs.read(p) } catch { return null }
}

async function cfZugang($: EngineInterface, z: Zustand): Promise<CfZugang | null> {
  if (z.cf !== undefined) return z.cf
  const t = await lies($, `${await home($)}/.claude/cloudflare.env`)
  z.cf = t ? leseCf(t) : null
  return z.cf
}

async function tgZugang($: EngineInterface, z: Zustand): Promise<TgZugang | null> {
  if (z.tg !== undefined) return z.tg
  const t = await lies($, `${await home($)}/.claude/telegram.env`)
  z.tg = t ? leseTg(t) : null
  return z.tg
}

async function git($: EngineInterface, ort: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', ort, ...args], { timeoutMs: 10 * SEK })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

async function refs($: EngineInterface, top: string): Promise<Map<string, string> | null> {
  const aus = await git($, top, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes'])
  return aus === null ? null : leseRefs(aus)
}

async function konfig($: EngineInterface, top: string): Promise<Konfig | null> {
  for (const datei of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const t = await lies($, `${top}/${datei}`)
    if (t !== null) return leseKonfig(datei, t)
  }
  return null
}

// Die Fehlermeldung nennt nie den Token: er steht nur im Header.
async function cf<T>($: EngineInterface, z: Zustand, weg: string): Promise<T> {
  const zg = await cfZugang($, z)
  if (!zg) throw new Error('kein Token in ~/.claude/cloudflare.env')
  let r
  try {
    r = await $.http.fetch(`${API}${weg}`, { headers: { authorization: `Bearer ${zg.token}` } })
  } catch (err) {
    throw new Error(`Cloudflare nicht erreichbar (${err instanceof Error ? err.message : String(err)})`)
  }
  let d: { success?: boolean; result?: unknown; errors?: { message?: string }[] } | null = null
  try { d = JSON.parse(r.text) } catch { /* bleibt null */ }
  if (!d?.success) {
    const was = d?.errors?.map(e => e.message).filter(Boolean).join('; ') ?? ''
    throw new Error(`Cloudflare ${weg.split('?')[0]?.replace(/[0-9a-f]{32}/g, '…')}: ${r.status} ${was}`.trim())
  }
  return d.result as T
}

async function konto($: EngineInterface, z: Zustand, ausKonfig?: string): Promise<string> {
  const zg = await cfZugang($, z)
  if (zg?.konto) return zg.konto
  if (ausKonfig) return ausKonfig
  const gemerkt = await $.store.get('konto')
  if (typeof gemerkt === 'string') return gemerkt
  const liste = await cf<{ id: string; name: string }[]>($, z, '/accounts')
  if (liste.length !== 1) throw new Error(`Der Token sieht ${liste.length} Konten: CLOUDFLARE_ACCOUNT_ID in ~/.claude/cloudflare.env eintragen`)
  await $.store.set('konto', liste[0]!.id)
  return liste[0]!.id
}

/** Der Tag des Workers (die Builds-API will ihn statt des Namens), gemerkt im Store. */
async function tagVon($: EngineInterface, z: Zustand, k: string, worker: string): Promise<string> {
  const key = `tag:${k}:${worker}`
  const gemerkt = await $.store.get(key)
  if (typeof gemerkt === 'string') return gemerkt
  const skripte = await cf<{ id: string; tag: string }[]>($, z, `/accounts/${k}/workers/scripts`)
  const tag = skripte.find(s => s.id === worker)?.tag
  if (!tag) throw new Error(`Worker „${worker}“ gibt es im Konto nicht`)
  await $.store.set(key, tag)
  return tag
}

async function builds($: EngineInterface, z: Zustand, w: Wache): Promise<Build[]> {
  const k = await konto($, z, w.konto)
  const tag = await tagVon($, z, k, w.worker)
  return cf<Build[]>($, z, `/accounts/${k}/builds/workers/${tag}/builds?per_page=10`)
}

async function logVon($: EngineInterface, z: Zustand, w: Wache): Promise<string[]> {
  if (!w.build) return []
  try {
    const k = await konto($, z, w.konto)
    // Lange Logs (npm install …) kommen seitenweise; der Fehler steht am Ende.
    let zeilen: string[] = []
    let cursor = ''
    for (let seite = 0; seite < 20; seite++) {
      const r = await cf<{ lines?: unknown; truncated?: boolean; cursor?: string }>($, z,
        `/accounts/${k}/builds/builds/${w.build}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
      zeilen = [...zeilen, ...logZeilen(r, Infinity)].slice(-LOG_ZEILEN)
      if (!r.truncated || !r.cursor || r.cursor === cursor) break
      cursor = r.cursor
    }
    return zeilen
  } catch (err) {
    return [`(Log nicht lesbar: ${err instanceof Error ? err.message : String(err)})`]
  }
}

/** Leerlauf aus `ioreg -k HIDIdleTime` (Nanosekunden) in ms; null = nicht lesbar. */
export function leseLeerlauf(ausgabe: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ausgabe)
  return m?.[1] ? Number(m[1]) / 1e6 : null
}

async function istWeg($: EngineInterface): Promise<boolean> {
  try {
    const r = await $.process.run(['/usr/sbin/ioreg', '-r', '-k', 'HIDIdleTime', '-d', '1'], { timeoutMs: 5 * SEK })
    const leer = r.exitCode === 0 ? leseLeerlauf(r.stdout) : null
    return leer !== null && leer >= WEG_AB_MS
  } catch {
    return false
  }
}

async function telegram($: EngineInterface, z: Zustand, text: string) {
  if (!z.telegram || !(await istWeg($))) return
  const zg = await tgZugang($, z)
  if (!zg) return
  try {
    const r = await $.http.fetch(`https://api.telegram.org/bot${zg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: zg.chat, text, disable_web_page_preview: true }),
    })
    if (!r.ok) merkeFehler($, z, `Telegram: ${r.status}`)
  } catch {
    merkeFehler($, z, 'Telegram nicht erreichbar')
  }
}

function merkeFehler($: EngineInterface, z: Zustand, text: string) {
  if (text !== z.fehler) $.ui.log(`deploy-wacht: ${text}`, { to: 'debug' })
  z.fehler = text
}

// ---------- Beobachten ----------

function zeichne($: EngineInterface, z: Zustand, now: number) {
  const text = statusText(z.wachen, now)
  if (text !== z.status) {
    z.status = text
    $.ui.status(text)
  }
}

function aktiv(w: Wache): boolean {
  return w.stand === 'wartet' || w.stand === 'baut'
}

function wecken($: EngineInterface, z: Zustand) {
  if (z.ticker) return
  z.ticker = $.clock.every(SEK, () => void tick($, z))
}

async function tick($: EngineInterface, z: Zustand) {
  const now = await $.clock.now()
  // Abgelaufene Ergebnisse fallen weg; ohne etwas zu zeigen schläft die Uhr.
  z.wachen = z.wachen.filter(w => aktiv(w) || (w.ende ?? now) + ERGEBNIS_ZEIGEN_MS > now)
  zeichne($, z, now)
  if (!z.wachen.length) {
    z.ticker?.cancel()
    z.ticker = null
    return
  }
  if (z.wachen.some(aktiv) && !z.holt && now - z.zuletztGeholt >= POLL_MS) await pruefe($, z)
}

async function pruefe($: EngineInterface, z: Zustand) {
  z.holt = true
  try {
    const now = await $.clock.now()
    z.zuletztGeholt = now
    const jeWorker = new Map<string, Build[]>()
    for (const w of z.wachen.filter(aktiv)) {
      let liste = jeWorker.get(w.worker)
      if (!liste) {
        try {
          liste = await builds($, z, w)
          z.fehler = ''
        } catch (err) {
          merkeFehler($, z, err instanceof Error ? err.message : String(err))
          liste = []
        }
        jeWorker.set(w.worker, liste)
      }
      const b = findeBuild(liste, w.sha)
      if (b) {
        w.build = b.build_uuid
        w.nachricht ??= b.build_trigger_metadata?.commit_message?.split('\n')[0]
        const stand = standVon(b)
        if (stand === 'wartet' || stand === 'baut') w.stand = stand
        else {
          const a = Date.parse(b.created_on ?? ''), e = Date.parse(b.stopped_on ?? '')
          w.dauer = Number.isFinite(a) && Number.isFinite(e) ? e - a : now - w.start
          await abschliessen($, z, w, stand, now)
        }
      } else if (w.stand === 'wartet' && now - w.start >= KEIN_BUILD_NACH_MS) {
        // Ein Nebenbranch ohne Vorschau-Builds ist normal: dann still aufhören.
        if (produktion(w)) await abschliessen($, z, w, 'kein-build', now)
        else z.wachen = z.wachen.filter(x => x !== w)
      }
      if (aktiv(w) && now - w.start >= AUFGEBEN_NACH_MS) await abschliessen($, z, w, 'aufgegeben', now)
    }
    zeichne($, z, now)
  } finally {
    z.holt = false
  }
}

function beschreibung(w: Wache): string {
  return `„${w.worker}“ (Commit ${w.sha.slice(0, 7)}${w.nachricht ? ` „${w.nachricht}“` : ''}, Branch ${w.branch})`
}

async function abschliessen($: EngineInterface, z: Zustand, w: Wache, stand: Stand, now: number) {
  w.stand = stand
  w.ende = now
  const wer = produktion(w) ? w.worker : `${w.worker} (${w.branch})`
  const ort = `📁 ${w.projekt}`
  if (stand === 'live') {
    z.behoben.delete(w.repo)
    if (w.domain && produktion(w)) {
      try {
        const r = await $.http.fetch(`https://${w.domain}/`)
        if (r.status >= 400) w.hinweis = `${w.domain} antwortet ${r.status}`
      } catch {
        w.hinweis = `${w.domain} nicht erreichbar`
      }
    }
    const wo = w.domain && produktion(w) ? ` auf ${w.domain}` : ''
    const satz = `✅ ${wer} ist live${wo} (Build ${mmss(w.dauer ?? 0)}, Commit ${w.sha.slice(0, 7)})${w.hinweis ? `, aber ⚠️ ${w.hinweis}` : ''}`
    $.ui.toast(satz, { timeoutMs: 8 * SEK })
    await notiz($, z, `deploy-wacht: Der Cloudflare-Build ${beschreibung(w)} ist durch, die Änderung ist live${wo}.${w.hinweis ? ` Achtung: ${w.hinweis}.` : ''}`)
    await telegram($, z, `${satz}\n${w.nachricht ?? ''}\n${ort}`.trim())
    return
  }
  if (stand === 'fehler') {
    const log = await logVon($, z, w)
    $.ui.toast(`❌ ${wer}: Build fehlgeschlagen`, { timeoutMs: 10 * SEK })
    const versuche = z.behoben.get(w.repo) ?? 0
    const beheben = z.fehlerArt === 'beheben' && produktion(w) && versuche < BEHEBEN_MAX
    const text = [
      `deploy-wacht: Der Cloudflare-Build ${beschreibung(w)} ist fehlgeschlagen, live ist weiter der alte Stand.`,
      '',
      'Ende des Build-Logs:',
      '```',
      ...(log.length ? log : ['(kein Log)']),
      '```',
      '',
      beheben
        ? 'Finde die Ursache. Ist die Behebung klein und eindeutig, behebe sie und bring sie wie gewohnt auf main; sonst erkläre mir kurz, was los ist.'
        : `Erklär mir kurz, woran es liegt${versuche >= BEHEBEN_MAX ? ` (schon ${versuche} Behebungen hintereinander, daher nicht selbst weiterpushen)` : ''}.`,
    ].join('\n')
    if (beheben) {
      z.behoben.set(w.repo, versuche + 1)
      void $.prompt.submit({ text })
    } else await notiz($, z, text)
    const letzte = log.slice(-6).join('\n')
    await telegram($, z, `❌ Build fehlgeschlagen · ${wer}\n${w.sha.slice(0, 7)} ${w.nachricht ?? ''}\n${ort}${beheben ? '\nClaude schaut nach.' : ''}${letzte ? `\n\n${letzte}` : ''}`)
    return
  }
  if (stand === 'kein-build') {
    $.ui.toast(`⚠️ ${wer}: Cloudflare hat zu ${w.sha.slice(0, 7)} keinen Build gestartet`, { timeoutMs: 10 * SEK })
    await notiz($, z, `deploy-wacht: Zum Push ${beschreibung(w)} hat Cloudflare nach ${Math.round(KEIN_BUILD_NACH_MS / MIN)} min keinen Build gestartet. Ist das Repo mit Workers Builds verbunden und der Branch im Trigger?`)
    await telegram($, z, `⚠️ Kein Build zu ${w.sha.slice(0, 7)} · ${wer}\n${ort}`)
    return
  }
  if (stand === 'aufgegeben') {
    await notiz($, z, `deploy-wacht: Der Cloudflare-Build ${beschreibung(w)} hatte nach ${Math.round(AUFGEBEN_NACH_MS / MIN)} min kein Ergebnis; die Mod schaut nicht mehr nach.`)
    return
  }
  // abgebrochen: meist überholt von einem neueren Push, also nur die Statuszeile.
}

/** Für Claude: sofort, wenn die Sitzung ruht, sonst nach dem laufenden Zug. */
async function notiz($: EngineInterface, z: Zustand, text: string) {
  z.notizen.push(text)
  if (!z.zugLaeuft) await notizenAbgeben($, z)
}

async function notizenAbgeben($: EngineInterface, z: Zustand) {
  if (!z.notizen.length) return
  const text = z.notizen.join('\n\n')
  z.notizen = []
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (err) {
    merkeFehler($, z, `Notiz an Claude ging nicht: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Nach einem Push: was hat er bewegt, und ist das ein Cloudflare-Projekt? */
async function nachPush($: EngineInterface, z: Zustand, top: string, neu: Geschoben[]): Promise<string | null> {
  const k = await konfig($, top)
  if (!k?.name) return null
  if (!(await cfZugang($, z))) {
    if (!z.ohneTokenGesagt) $.ui.toast('deploy-wacht: kein Cloudflare-Token, /deploy einrichten', { timeoutMs: 8 * SEK })
    z.ohneTokenGesagt = true
    return null
  }
  const now = await $.clock.now()
  const projekt = top.replace(/\/+$/, '').split('/').pop() ?? top
  const neue: Wache[] = []
  for (const g of neu) {
    // Ein neuerer Push auf denselben Branch überholt den alten.
    z.wachen = z.wachen.filter(w => !(w.worker === k.name && w.branch === g.branch && aktiv(w)))
    const w: Wache = ({ repo: top, projekt, worker: k.name, konto: k.konto, domain: k.domain, branch: g.branch, sha: g.sha, start: now, stand: 'wartet' })
    z.wachen.push(w)
    neue.push(w)
  }
  // Die erste Abfrage kommt nach 10 s: so früh gibt es den Build meist noch nicht.
  z.zuletztGeholt = now
  zeichne($, z, now)
  wecken($, z)
  const was = neue.map(w => `${w.branch} (${w.sha.slice(0, 7)})`).join(', ')
  return `deploy-wacht: Push auf ${was} erkannt. Die Mod beobachtet den Cloudflare-Build von „${k.name}“ und meldet das Ergebnis selbst: unter dem Prompt, und bei einem Fehler als neue Nachricht mit dem Build-Log. Warte also nicht selbst auf den Live-Stand und frag ihn nicht per Schleife ab.`
}

// ---------- /deploy ----------

// Die Builds-API nimmt nur Benutzer-Token (Profil → API-Tokens); ein Konto-Token
// (Konto verwalten → Konto-API-Tokens) liest Workers, bekommt bei Builds aber
// „Invalid token“ (so in der Cloudflare-Doku, 09.10. selbst erlebt).
const VORLAGE = 'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=deploy-wacht'
const ANLEITUNG = [
  'Einrichten (einmalig):',
  '1. Einen Benutzer-Token anlegen, kein Konto-Token (den nimmt die Builds-API nicht):',
  `   ${VORLAGE}`,
  '   Die Vorlage setzt „Workers-Skripte · Lesen“; dazu „Workers Builds Configuration · Lesen“',
  '   (auch „Workers CI“ genannt) hinzufügen. Kontoressourcen: dein Konto. Nur Leserechte.',
  '2. Den Token in die Datei ~/.claude/cloudflare.env schreiben, nicht hier in den Chat:',
  '     open -e ~/.claude/cloudflare.env      (Zeile: CLOUDFLARE_API_TOKEN=…)',
  '3. /deploy einrichten',
].join('\n')

const KONTO_TOKEN = 'Das ist offenbar ein Konto-Token: Workers liest er, die Builds-API nimmt aber nur Benutzer-Token (Profil → API-Tokens).'

async function einrichten($: EngineInterface, z: Zustand): Promise<string> {
  z.cf = undefined
  const zg = await cfZugang($, z)
  if (!zg) return `In ~/.claude/cloudflare.env steht noch kein CLOUDFLARE_API_TOKEN.\n\n${ANLEITUNG}`
  try {
    let k = zg.konto
    let zusatz = ''
    if (!k) {
      k = await konto($, z)
      const p = `${await home($)}/.claude/cloudflare.env`
      const roh = (await lies($, p)) ?? ''
      const zeilen = roh.split('\n').filter(l => l.trim() && !/^\s*(?:export\s+)?CLOUDFLARE_ACCOUNT_ID=/.test(l))
      await $.fs.write(p, [...zeilen, `CLOUDFLARE_ACCOUNT_ID=${k}`, ''].join('\n'))
      z.cf = { ...zg, konto: k }
      zusatz = ' Konto-ID eingetragen.'
    }
    const skripte = await cf<{ id: string; tag: string }[]>($, z, `/accounts/${k}/workers/scripts`)
    const probe = skripte[0]
    if (probe) {
      try {
        await cf<Build[]>($, z, `/accounts/${k}/builds/workers/${probe.tag}/builds?per_page=1`)
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        const warum = /invalid token/i.test(text) ? KONTO_TOKEN : 'Fehlt „Workers Builds Configuration · Lesen“?'
        return `Workers sieht der Token (${skripte.length}), aber keine Builds: ${text}\n${warum}${zusatz}\n\n${ANLEITUNG}`
      }
    }
    return `Verbunden: ${skripte.length} Workers sichtbar, Builds lesbar.${zusatz} Ab dem nächsten git push wird beobachtet.`
  } catch (err) {
    return `Einrichten ging nicht: ${err instanceof Error ? err.message : String(err)}\n\n${ANLEITUNG}`
  }
}

async function karte($: EngineInterface, z: Zustand): Promise<string> {
  const now = await $.clock.now()
  const zg = await cfZugang($, z)
  const zeilen = ['deploy-wacht']
  zeilen.push(`Zugang         ${zg ? 'ok' : '⚠️ noch nicht eingerichtet: /deploy einrichten'}`)
  zeilen.push(`Roter Build    ${z.fehlerArt === 'beheben' ? `Claude bekommt das Log und behebt Kleines selbst (höchstens ${BEHEBEN_MAX}× hintereinander)` : 'nur melden'}`)
  zeilen.push(`Telegram       ${z.telegram ? 'wenn du weg bist' : 'aus'}`)
  for (const w of z.wachen) zeilen.push(`Gerade         ${statusText([w], now) ?? w.stand}`)
  // Der letzte Build des Projekts, in dem die Sitzung steht.
  const top = (await git($, await $.session.cwd(), ['rev-parse', '--show-toplevel']))?.trim()
  const k = top ? await konfig($, top) : null
  if (zg && k?.name) {
    try {
      const w: Wache = ({ repo: top!, projekt: '', worker: k.name, konto: k.konto, branch: 'main', sha: '', start: now, stand: 'wartet' })
      const b = (await builds($, z, w))[0]
      if (b) {
        const m = b.build_trigger_metadata
        const stand = standVon(b)
        const wann = Date.parse(b.created_on ?? '')
        zeilen.push(`Letzter Build  ${k.name}: ${stand} · ${m?.branch ?? '?'} ${m?.commit_hash?.slice(0, 7) ?? ''} ${m?.commit_message?.split('\n')[0] ?? ''}${Number.isFinite(wann) ? ` · vor ${Math.round((now - wann) / MIN)} min` : ''}`)
        if (stand === 'fehler') {
          w.build = b.build_uuid
          zeilen.push('', ...(await logVon($, z, w)).slice(-15))
        }
      }
    } catch (err) {
      zeilen.push(`Letzter Build  ${k.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (z.fehler) zeilen.push(`Letzter Fehler ${z.fehler}`)
  zeilen.push('', '/deploy einrichten · fehler beheben|melden · telegram an|aus')
  return zeilen.join('\n')
}

// ---------- Hooks ----------

export const register: Register = on => {
  const z = neuerZustand()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const art = await $.store.get('fehlerArt')
    if (art === 'beheben' || art === 'melden') z.fehlerArt = art
    const tg = await $.store.get('telegram')
    if (typeof tg === 'boolean') z.telegram = tg
    await $.command.register({
      name: 'deploy',
      description: 'Cloudflare-Builds nach git push beobachten (deploy-wacht)',
      argumentHint: '[einrichten | fehler beheben|melden | telegram an|aus]',
      immediate: true,
    })
    return r
  })

  on('turn.start', async ($, e, next) => {
    z.zugLaeuft = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    z.zugLaeuft = false
    await notizenAbgeben($, z)
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash' || e.run_in_background || !PUSH.test(e.command)) return next(e)
    // Der Push selbst darf an der Mod nie scheitern: alles Eigene ist abgefangen.
    let top: string | undefined
    let vorher: Map<string, string> | null = null
    try {
      const ort = repoOrt(e.command, await $.session.cwd(), await home($))
      top = (await git($, ort, ['rev-parse', '--show-toplevel']))?.trim()
      vorher = top ? await refs($, top) : null
    } catch (err) {
      merkeFehler($, z, `vor dem Push: ${err instanceof Error ? err.message : String(err)}`)
    }
    const r = await next(e)
    if (!top || !vorher || r.deny !== undefined || r.isError) return r
    try {
      const nachher = await refs($, top)
      const neu = nachher ? geschoben(vorher, nachher) : []
      const hinweis = neu.length ? await nachPush($, z, top, neu) : null
      return hinweis ? { ...r, context: [...(r.context ?? []), hinweis] } : r
    } catch (err) {
      merkeFehler($, z, `nach dem Push: ${err instanceof Error ? err.message : String(err)}`)
      return r
    }
  })

  on('command.run', { command: 'deploy' }, async ($, e) => {
    const [was = '', wert = ''] = String(e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (was === 'einrichten') return { text: await einrichten($, z) }
    if (was === 'fehler') {
      if (wert !== 'beheben' && wert !== 'melden') return { text: 'Roter Build: beheben oder melden?' }
      z.fehlerArt = wert
      await $.store.set('fehlerArt', wert)
      return { text: wert === 'beheben' ? 'Bei einem roten Build bekommt Claude das Log und behebt Kleines selbst.' : 'Rote Builds werden nur gemeldet.' }
    }
    if (was === 'telegram') {
      if (wert !== 'an' && wert !== 'aus') return { text: 'Telegram: an oder aus?' }
      z.telegram = wert === 'an'
      await $.store.set('telegram', z.telegram)
      return { text: z.telegram ? 'Ergebnisse kommen aufs Handy, wenn du weg bist.' : 'Keine Telegram-Meldungen mehr.' }
    }
    const unbekannt = was && was !== 'status' ? `„${String(e.args).trim()}“ kenne ich nicht.\n\n` : ''
    return { text: unbekannt + await karte($, z) }
  })
}
