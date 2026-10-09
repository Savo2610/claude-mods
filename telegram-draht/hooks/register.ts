import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

const SEK = 1000
const MIN = 60 * SEK
// Wer so lange weder Maus noch Tastatur angefasst hat, ist weg: dann meldet sich
// jeder Abschluss, und Rückfragen gehen sofort aufs Handy. Wer am Rechner sitzt,
// bekommt nichts: weg = informiert, da = kein Spam. (Erst 3 min, im Alltag
// waren 1 min besser.)
export const WEG_AB_MIN = 1
// Lässt sich der Leerlauf nicht messen, gilt wieder: ab 10 min Laufzeit melden.
export const FERTIG_OHNE_MESSUNG_MIN = 10
// Wer am Rechner sitzt, antwortet in einer Minute; erst danach geht die Rückfrage
// aufs Handy. (Sofort war zu viel; 25 s waren im Alltag zu knapp.)
export const FRAGEN_NACH_SEK = 60
// Solange eine Rückfrage offen ist, alle 4 s nachsehen: ein Knopfdruck wirkt spürbar sofort.
const POLL_MS = 4 * SEK
// Auf eine Fertig-Meldung antwortet man selten sofort: da reichen 15 s.
const FADEN_POLL_MS = 15 * SEK
// Wie lange man auf eine Fertig-Meldung antworten kann.
const FADEN_MS = 12 * 60 * MIN
// Updates der anderen Mod (cache-waechter, „cw:“) bleiben so lange liegen, bis sie
// sie abholt; danach gelten sie als verwaist und werden quittiert.
const FREMD_GNADE_MS = MIN
const HAENGT_MS = 20 * SEK
const TEXT_MAX = 3500
// Von einer langen Antwort: der Anfang (meist das Ergebnis in einem Satz) und
// das Ende (was offen ist, Rückfragen); die Mitte sind Einzelheiten.
const AUSZUG_KOPF = 700
const AUSZUG_ENDE = 2600
const RC_TOOL = 'mcp__ccd_session_mgmt__set_remote_control'
// Ein Bash-Aufruf dieses Skripts heißt: Claude hat selbst gemeldet.
const TG_SKRIPT = /(^|[\s;&|(])(~|\$HOME|\/Users\/[^/\s]+)\/\.claude\/bin\/tg\b/

type TgZugang = { token: string; chat: string }
type TgNachricht = { message_id: number; date?: number; chat?: { id?: number }; text?: string; reply_to_message?: { message_id: number } }
export type TgUpdate = { update_id: number; message?: TgNachricht; callback_query?: { id: string; data?: string; message?: TgNachricht } }

export type Einordnung =
  | { art: 'knopf'; rid: string; teil: number; wahl: string; cq: string; msg?: number }
  | { art: 'text'; text: string; antwortAuf?: number; msg: number; date: number }
  /** Gehört einer anderen Mod: liegen lassen, bis sie es holt. */
  | { art: 'fremd' }
  /** Interessiert niemanden: quittieren. */
  | { art: 'egal' }

type Teil = {
  frage: string
  kopf: string
  optionen: { label: string; description?: string }[]
  mehrfach: boolean
  gewaehlt: number[]
  messageId: number
  text: string
  antwort?: string
}
type Rueckfrage = {
  id: string
  teile: Teil[]
  gesendet: boolean
  geschlossen: boolean
  zeit: number
  fertig: (antworten: Record<string, string>) => void
}
/** Eine Fertig-Meldung, auf die man antworten kann; `html`: mit parse_mode HTML geschickt. */
type Faden = { messageId: number; bis: number; text: string; html?: boolean }
/** Was eine Sitzung im Store zeigt, damit andere Sitzungen ihr Antworten zustellen können. */
type Offen = { rids: string[]; msgs: number[]; frageZeit: number; faeden: Faden[]; at: number }
type Zug = { start: number; ausTelegram: boolean; selbst: boolean }

type Zustand = {
  sid: string
  projekt: string
  zugang: TgZugang | null | undefined
  /** Ab so vielen Minuten Leerlauf gilt man als weg; 0 = nie. */
  wegAb: number
  /** Zusätzlich: ab so vielen Minuten Laufzeit immer melden; 0 = aus. */
  fertigAb: number
  fragenNach: number
  rueckfragen: Map<string, Rueckfrage>
  faeden: Faden[]
  zug: Zug | null
  naechsterAusTelegram: boolean
  offset: number
  holtSeit: number
  zuletztGeholt: number
  gesehen: number[]
  fremdSeit: Map<number, number>
  tgFehler: string
}

function neuerZustand(): Zustand {
  return {
    sid: '', projekt: '', zugang: undefined, wegAb: WEG_AB_MIN, fertigAb: 0, fragenNach: FRAGEN_NACH_SEK,
    rueckfragen: new Map(), faeden: [], zug: null, naechsterAusTelegram: false,
    offset: 0, holtSeit: 0, zuletztGeholt: 0, gesehen: [], fremdSeit: new Map(), tgFehler: '',
  }
}

function leseWerte(text: string): Record<string, string> {
  const werte: Record<string, string> = {}
  for (const zeile of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)=(.*)$/.exec(zeile)
    if (m?.[1] && m[2] !== undefined) werte[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return werte
}

/** Liest ~/.claude/telegram.env (dieselbe Datei wie cache-waechter und bin/tg). */
export function leseZugang(text: string): TgZugang | null {
  const werte = leseWerte(text)
  const token = werte.TELEGRAM_BOT_TOKEN
  const chat = werte.TELEGRAM_CHAT_ID
  return token && chat ? { token, chat } : null
}

export function fmtDauer(ms: number): string {
  if (ms < MIN) return 'unter 1 min'
  const m = Math.floor(ms / MIN)
  const std = Math.floor(m / 60)
  return std ? `${std} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`
}

export function kuerze(text: string, max = TEXT_MAX): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/** Auszug einer langen Antwort: Anfang und Ende, an Zeilen geschnitten, wo es geht. */
export function auszug(text: string, kopf = AUSZUG_KOPF, ende = AUSZUG_ENDE): string {
  const t = text.trim()
  if (t.length <= kopf + ende + 100) return t
  let a = t.slice(0, kopf)
  const aZeile = a.lastIndexOf('\n')
  if (aZeile > kopf * 0.5) a = a.slice(0, aZeile)
  let b = t.slice(-ende)
  const bZeile = b.indexOf('\n')
  if (bZeile >= 0 && bZeile < ende * 0.3) b = b.slice(bZeile + 1)
  return `${a.trimEnd()}\n\n[…]\n\n${b.trimStart()}`
}

export function escHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Claudes Markdown in das HTML, das Telegram kann: fett, Code, Links,
 * Überschriften als fett, Listen mit •. Tabellen und alles andere bleiben Text.
 */
export function alsHtml(md: string): string {
  const fest: string[] = []
  const merke = (html: string) => `\u0000${fest.push(html) - 1}\u0000`
  let s = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => merke(`<pre>${escHtml(code.trimEnd())}</pre>`))
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => merke(`<code>${escHtml(code)}</code>`))
  s = escHtml(s)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  s = s.replace(/^(\s*)[-*]\s+/gm, '$1• ')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => fest[Number(i)] ?? '')
}

/** Leerlauf aus `ioreg -k HIDIdleTime` (Nanosekunden) in ms; null = nicht lesbar. */
export function leseLeerlauf(ausgabe: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ausgabe)
  return m?.[1] ? Number(m[1]) / 1e6 : null
}

/** Wie lange Maus und Tastatur unberührt sind (macOS); null = unbekannt. */
async function leerlaufMs($: EngineInterface): Promise<number | null> {
  try {
    const r = await $.process.run(['/usr/sbin/ioreg', '-r', '-k', 'HIDIdleTime', '-d', '1'], { timeoutMs: 5000 })
    return r.exitCode === 0 ? leseLeerlauf(r.stdout) : null
  } catch {
    // Kein $.process (außerhalb der CLI) oder kein ioreg (kein Mac).
    return null
  }
}

/** Ob man weg ist; ohne Messung zählt die Laufzeit (ab 10 min). */
export function istWeg(leer: number | null, wegAbMin: number, dauerMs: number): boolean {
  if (leer === null) return dauerMs >= FERTIG_OHNE_MESSUNG_MIN * MIN
  return wegAbMin > 0 && leer >= wegAbMin * MIN
}

export function einordnen(u: TgUpdate, chat: string): Einordnung {
  const cq = u.callback_query
  if (cq) {
    if (String(cq.message?.chat?.id) !== chat) return { art: 'egal' }
    const data = cq.data ?? ''
    if (data.startsWith('td:')) {
      const [, rid = '', teil = '', wahl = ''] = data.split(':')
      return { art: 'knopf', rid, teil: Number(teil), wahl, cq: cq.id, msg: cq.message?.message_id }
    }
    return data.startsWith('cw:') ? { art: 'fremd' } : { art: 'egal' }
  }
  const m = u.message
  if (!m || String(m.chat?.id) !== chat || !m.text || m.text.startsWith('/')) return { art: 'egal' }
  return { art: 'text', text: m.text, antwortAuf: m.reply_to_message?.message_id, msg: m.message_id, date: (m.date ?? 0) * SEK }
}

/** Welche Sitzung ein Knopfdruck oder Text meint; null = keine. */
export function zielSitzung(ein: Einordnung, offen: Map<string, Offen>): string | null {
  if (ein.art === 'knopf') {
    for (const [sid, o] of offen) {
      if (ein.rid === 'rc' ? ein.msg !== undefined && o.msgs.includes(ein.msg) : o.rids.includes(ein.rid)) return sid
    }
    return null
  }
  if (ein.art !== 'text') return null
  if (ein.antwortAuf !== undefined) {
    for (const [sid, o] of offen) if (o.msgs.includes(ein.antwortAuf)) return sid
    return null
  }
  // Ohne „Antworten auf“: an die jüngste offene Rückfrage, nie einfach an eine Sitzung.
  let best: string | null = null
  let zeit = 0
  for (const [sid, o] of offen) if (o.frageZeit > zeit) { zeit = o.frageZeit; best = sid }
  return best
}

function kennung(): string {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

async function zugangLesen($: EngineInterface, z: Zustand): Promise<TgZugang | null> {
  if (z.zugang !== undefined) return z.zugang
  const home = await $.env.get('HOME')
  try {
    z.zugang = home ? leseZugang(await $.fs.read(`${home}/.claude/telegram.env`)) : null
  } catch {
    z.zugang = null
  }
  return z.zugang
}

// Die Fehlermeldung nennt nie den Bot-Token: er steckt in der URL.
async function tg($: EngineInterface, z: Zustand, methode: string, body: object): Promise<unknown> {
  const zg = await zugangLesen($, z)
  if (!zg) throw new Error('keine Zugangsdaten in ~/.claude/telegram.env')
  let r
  try {
    r = await $.http.fetch(`https://api.telegram.org/bot${zg.token}/${methode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const text = (err instanceof Error ? err.message : String(err)).split(zg.token).join('…')
    throw new Error(`Telegram ${methode}: nicht erreichbar (${text})`)
  }
  let d: { ok?: boolean; result?: unknown; description?: string } | null = null
  try { d = JSON.parse(r.text) } catch { /* bleibt null */ }
  if (!d?.ok) throw new Error(`Telegram ${methode}: ${r.status} ${d?.description ?? ''}`.trim())
  z.tgFehler = ''
  return d.result
}

function merkeFehler($: EngineInterface, z: Zustand, err: unknown) {
  const text = err instanceof Error ? err.message : String(err)
  if (text !== z.tgFehler) $.ui.log(`telegram-draht: ${text}`, { to: 'debug' })
  z.tgFehler = text
}

async function tgLeise($: EngineInterface, z: Zustand, methode: string, body: object) {
  try { await tg($, z, methode, body) } catch (err) { merkeFehler($, z, err) }
}

// Fürs Aufräumen: „message is not modified“, „query is too old“ sind erwartbar.
async function tgStill($: EngineInterface, z: Zustand, methode: string, body: object) {
  try { await tg($, z, methode, body) } catch { /* bewusst still */ }
}

// ---------- Was diese Sitzung offen hat, für alle Sitzungen sichtbar ----------

async function speichereOffen($: EngineInterface, z: Zustand) {
  z.sid = await $.session.id()
  const now = await $.clock.now()
  z.faeden = z.faeden.filter(f => f.bis > now)
  const gesendet = [...z.rueckfragen.values()].filter(r => r.gesendet && !r.geschlossen)
  const o: Offen = {
    rids: gesendet.map(r => r.id),
    msgs: [...gesendet.flatMap(r => r.teile.map(t => t.messageId)), ...z.faeden.map(f => f.messageId)],
    frageZeit: Math.max(0, ...gesendet.map(r => r.zeit)),
    faeden: z.faeden,
    at: now,
  }
  const key = `offen:${z.sid}`
  if (o.msgs.length) await $.store.set(key, o)
  else await $.store.delete(key)
}

async function offeneSitzungen($: EngineInterface, now: number): Promise<Map<string, Offen>> {
  const m = new Map<string, Offen>()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('offen:')) continue
    const o = await $.store.get(key) as Offen | undefined
    if (o && now - o.at < FADEN_MS + MIN) m.set(key.slice('offen:'.length), o)
  }
  return m
}

function hatOffenes(z: Zustand): 'frage' | 'faden' | null {
  for (const r of z.rueckfragen.values()) if (r.gesendet && !r.geschlossen) return 'frage'
  return z.faeden.length ? 'faden' : null
}

// ---------- Rückfragen ----------

function teilText(z: Zustand, t: Teil, nr: number, von: number): string {
  const kopf = `❓ Claude fragt${von > 1 ? ` (${nr}/${von})` : ''} · 📁 ${z.projekt || 'Claude Code'}`
  const optionen = t.optionen.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` – ${o.description}` : ''}`)
  const hinweis = t.mehrfach
    ? 'Mehrere antippen, dann „Fertig“. Oder mit eigenem Text antworten.'
    : 'Antippen oder mit eigenem Text antworten.'
  return kuerze([kopf, '', `${t.kopf}: ${t.frage}`, '', ...optionen, '', hinweis].join('\n'))
}

function tastatur(rid: string, nr: number, t: Teil) {
  const reihen = t.optionen.map((o, i) => [{
    text: `${t.mehrfach ? (t.gewaehlt.includes(i) ? '☑️ ' : '☐ ') : ''}${o.label}`.slice(0, 60),
    callback_data: `td:${rid}:${nr}:${i}`,
  }])
  if (t.mehrfach) reihen.push([{ text: '✔️ Fertig', callback_data: `td:${rid}:${nr}:ok` }])
  return { inline_keyboard: reihen }
}

async function sendeRueckfrage($: EngineInterface, z: Zustand, rf: Rueckfrage) {
  if (rf.gesendet || rf.geschlossen) return
  const zg = await zugangLesen($, z)
  if (!zg) return
  try {
    for (const [nr, t] of rf.teile.entries()) {
      t.text = teilText(z, t, nr + 1, rf.teile.length)
      const msg = await tg($, z, 'sendMessage', { chat_id: zg.chat, text: t.text, reply_markup: tastatur(rf.id, nr, t) }) as { message_id: number }
      t.messageId = msg.message_id
    }
    rf.gesendet = true
    rf.zeit = await $.clock.now()
    // Inzwischen am Rechner beantwortet: die eben geschickten Knöpfe gleich wieder abräumen.
    if (rf.geschlossen) {
      for (const t of rf.teile) if (t.messageId) await tgStill($, z, 'editMessageText', { chat_id: zg.chat, message_id: t.messageId, text: `${t.text}\n\n💻 Am Rechner beantwortet.` })
      return
    }
    await speichereOffen($, z)
  } catch (err) {
    merkeFehler($, z, err)
    $.ui.toast('Telegram: Rückfrage ging nicht raus')
  }
}

async function schliesseRueckfrage($: EngineInterface, z: Zustand, rf: Rueckfrage, zusatz: (t: Teil) => string) {
  if (rf.geschlossen) return
  rf.geschlossen = true
  const zg = await zugangLesen($, z)
  if (zg && rf.gesendet) {
    for (const t of rf.teile) {
      if (t.messageId) await tgStill($, z, 'editMessageText', { chat_id: zg.chat, message_id: t.messageId, text: `${t.text}\n\n${zusatz(t)}` })
    }
  }
  await speichereOffen($, z)
}

function antwortenAus(r: ToolCallResult<'AskUserQuestion'>): Record<string, string> {
  if (!('result' in r) || !r.result || typeof r.result !== 'object') return {}
  const a = (r.result as { answers?: unknown }).answers
  return a && typeof a === 'object' ? a as Record<string, string> : {}
}

async function pruefeFertig(rf: Rueckfrage) {
  if (rf.geschlossen || !rf.teile.every(t => t.antwort !== undefined)) return
  rf.fertig(Object.fromEntries(rf.teile.map(t => [t.frage, t.antwort ?? ''])))
}

// ---------- Fertig-Meldungen und Antworten darauf ----------

async function meldeFertig($: EngineInterface, z: Zustand, kopf: string, antwort: string) {
  const zg = await zugangLesen($, z)
  if (!zg) return
  const rumpf = auszug(antwort || '(keine Textantwort)')
  const fuss = '↩️ Antworte hierauf, um Claude weiterzuschreiben.'
  const knopf = { inline_keyboard: [[{ text: '📱 In der App weitermachen', callback_data: 'td:rc:0:0' }]] }
  try {
    let html = true
    let text = [`<b>${escHtml(kopf)}</b>`, '', alsHtml(rumpf), '', escHtml(fuss)].join('\n')
    let msg: { message_id: number }
    try {
      msg = await tg($, z, 'sendMessage', { chat_id: zg.chat, text, parse_mode: 'HTML', reply_markup: knopf }) as { message_id: number }
    } catch (err) {
      // Telegram lehnt kaputtes HTML ab („can't parse entities“): dann als reinen Text.
      if (!/parse entities|too long/i.test(err instanceof Error ? err.message : '')) throw err
      html = false
      text = kuerze([kopf, '', rumpf, '', fuss].join('\n'), 4000)
      msg = await tg($, z, 'sendMessage', { chat_id: zg.chat, text, reply_markup: knopf }) as { message_id: number }
    }
    z.faeden = [...z.faeden.slice(-4), { messageId: msg.message_id, bis: (await $.clock.now()) + FADEN_MS, text, html }]
    await speichereOffen($, z)
  } catch (err) {
    merkeFehler($, z, err)
    $.ui.toast('Telegram: Fertig-Meldung ging nicht raus')
  }
}

async function schliesseFaeden($: EngineInterface, z: Zustand, zusatz: string) {
  if (!z.faeden.length) return
  const zg = await zugangLesen($, z)
  const alt = z.faeden
  z.faeden = []
  await speichereOffen($, z)
  if (!zg) return
  for (const f of alt) {
    await tgStill($, z, 'editMessageText', f.html
      ? { chat_id: zg.chat, message_id: f.messageId, text: `${f.text}\n\n${escHtml(zusatz)}`, parse_mode: 'HTML' }
      : { chat_id: zg.chat, message_id: f.messageId, text: `${f.text}\n\n${zusatz}` })
  }
}

// ---------- Was aus Telegram kommt ----------

async function verarbeite($: EngineInterface, z: Zustand, ein: Einordnung) {
  const zg = await zugangLesen($, z)
  if (!zg) return
  if (ein.art === 'knopf' && ein.rid === 'rc') return fernsteuerung($, z, zg, ein.cq, ein.msg)
  if (ein.art === 'knopf') {
    const rf = z.rueckfragen.get(ein.rid)
    const t = rf?.teile[ein.teil]
    if (!rf || !t || rf.geschlossen || t.antwort !== undefined) {
      await tgStill($, z, 'answerCallbackQuery', { callback_query_id: ein.cq, text: 'Schon erledigt.' })
      return
    }
    if (ein.wahl === 'ok') {
      if (!t.gewaehlt.length) {
        await tgStill($, z, 'answerCallbackQuery', { callback_query_id: ein.cq, text: 'Erst etwas auswählen.' })
        return
      }
      t.antwort = t.gewaehlt.slice().sort((a, b) => a - b).map(i => t.optionen[i]?.label ?? '').join(', ')
    } else {
      const i = Number(ein.wahl)
      const o = t.optionen[i]
      if (!o) return void tgStill($, z, 'answerCallbackQuery', { callback_query_id: ein.cq })
      if (t.mehrfach) {
        t.gewaehlt = t.gewaehlt.includes(i) ? t.gewaehlt.filter(x => x !== i) : [...t.gewaehlt, i]
        await tgStill($, z, 'answerCallbackQuery', { callback_query_id: ein.cq })
        await tgStill($, z, 'editMessageReplyMarkup', { chat_id: zg.chat, message_id: t.messageId, reply_markup: tastatur(rf.id, ein.teil, t) })
        return
      }
      t.antwort = o.label
    }
    await tgStill($, z, 'answerCallbackQuery', { callback_query_id: ein.cq, text: '👍' })
    await tgStill($, z, 'editMessageText', { chat_id: zg.chat, message_id: t.messageId, text: `${t.text}\n\n✅ ${t.antwort}` })
    return pruefeFertig(rf)
  }
  if (ein.art !== 'text') return
  // Antwort auf eine Rückfrage (oder ohne Bezug: an die jüngste offene).
  const offene = [...z.rueckfragen.values()].filter(r => r.gesendet && !r.geschlossen).sort((a, b) => b.zeit - a.zeit)
  for (const rf of offene) {
    const t = ein.antwortAuf !== undefined
      ? rf.teile.find(x => x.messageId === ein.antwortAuf)
      : rf.teile.find(x => x.antwort === undefined)
    if (!t) continue
    if (t.antwort !== undefined) return
    t.antwort = ein.text
    await tgStill($, z, 'editMessageText', { chat_id: zg.chat, message_id: t.messageId, text: `${t.text}\n\n✏️ ${kuerze(ein.text, 300)}` })
    return pruefeFertig(rf)
  }
  // Antwort auf eine Fertig-Meldung: als neue Nachricht in die Sitzung.
  const f = z.faeden.find(x => x.messageId === ein.antwortAuf)
  if (!f) return
  z.faeden = z.faeden.filter(x => x !== f)
  await speichereOffen($, z)
  z.naechsterAusTelegram = true
  await $.prompt.submit({ text: ein.text, asUser: true })
  await tgStill($, z, 'sendMessage', { chat_id: zg.chat, text: '📨 Ist bei Claude angekommen.', reply_to_message_id: ein.msg })
}

/**
 * Schaltet Remote Control für diese Sitzung ein, damit es in der Claude-App
 * weitergeht. In der Desktop-App über ihr Werkzeug (ohne Modell, ohne Tokens),
 * im Terminal über den Befehl /remote-control.
 */
async function fernsteuerung($: EngineInterface, z: Zustand, zg: TgZugang, cq: string, msg?: number) {
  await tgStill($, z, 'answerCallbackQuery', { callback_query_id: cq, text: 'Wird eingeschaltet …' })
  let text: string
  try {
    const r = await $.tool.call({ tool: RC_TOOL, session_id: 'self', enabled: true })
    if (r.deny !== undefined) text = `⚠️ Remote Control ging nicht: ${r.deny}`
    else if (r.isError) text = `⚠️ Remote Control ging nicht: ${r.text ?? 'Fehler'}`
    else {
      const stand = /\b(on|connecting|unavailable|off)\b/.exec(r.text ?? '')?.[1] ?? 'on'
      text = stand === 'unavailable' || stand === 'off'
        ? `⚠️ Remote Control ist für diese Sitzung nicht verfügbar (${stand}).`
        : `📱 Remote Control ${stand === 'connecting' ? 'verbindet sich gerade' : 'ist an'}. Öffne die Claude-App → Code → Sitzung in „${z.projekt || 'Claude Code'}“.`
    }
  } catch {
    try {
      await $.command.run({ command: 'remote-control' })
      text = `📱 Remote Control wird gestartet. Öffne gleich die Claude-App → Code → Sitzung in „${z.projekt || 'Claude Code'}“.`
    } catch (err) {
      text = `⚠️ Remote Control ließ sich hier nicht starten: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  await tgStill($, z, 'sendMessage', { chat_id: zg.chat, text, ...(msg ? { reply_to_message_id: msg } : {}) })
}

/** Ob ein fremdes Update lange genug lag, dass seine Mod es offenbar nicht mehr holt. */
function verwaist(z: Zustand, id: number, now: number): boolean {
  const seit = z.fremdSeit.get(id)
  if (seit === undefined) {
    z.fremdSeit.set(id, now)
    return false
  }
  return now - seit >= FREMD_GNADE_MS
}

// Kurzes Abfragen statt Long-Polling (zwei Wartende wirft Telegram mit 409 raus).
// Der Offset rückt nie über ein Update hinaus, das noch jemandem gehört: die
// cache-waechter-Mod liest denselben Bot. Antworten für andere Sitzungen dieser
// Mod landen unter post:<sitzung> im Store.
async function hole($: EngineInterface, z: Zustand) {
  const jetzt = await $.clock.now()
  if (z.holtSeit && jetzt - z.holtSeit < HAENGT_MS) return
  z.holtSeit = jetzt
  z.zuletztGeholt = jetzt
  try {
    const zg = await zugangLesen($, z)
    if (!zg) return
    z.sid = await $.session.id()
    await postAbholen($, z)
    const gemeinsam = await $.store.get('tg:offset')
    z.offset = Math.max(z.offset, typeof gemeinsam === 'number' ? gemeinsam : 0)
    const updates = await tg($, z, 'getUpdates', { offset: z.offset, timeout: 0, allowed_updates: ['message', 'callback_query'] }) as TgUpdate[]
    if (!updates.length) return
    const erledigt = (await $.store.get('tg:erledigt') as number[] | undefined) ?? []
    const offen = await offeneSitzungen($, jetzt)
    let neu = z.offset
    let frei = true
    for (const u of updates) {
      const ein = einordnen(u, zg.chat)
      let weg = true
      if (ein.art === 'fremd') weg = verwaist(z, u.update_id, jetzt)
      else if ((ein.art === 'knopf' || ein.art === 'text') && !erledigt.includes(u.update_id)) {
        erledigt.push(u.update_id)
        const ziel = zielSitzung(ein, offen)
        if (ziel === z.sid) await verarbeite($, z, ein)
        else if (ziel) {
          const liste = (await $.store.get(`post:${ziel}`) as TgUpdate[] | undefined) ?? []
          await $.store.set(`post:${ziel}`, [...liste, u])
        } else if (ein.art === 'knopf') {
          await tgStill($, z, 'answerCallbackQuery', { callback_query_id: ein.cq, text: 'Diese Frage ist schon erledigt.' })
          if (ein.msg) await tgStill($, z, 'editMessageReplyMarkup', { chat_id: zg.chat, message_id: ein.msg, reply_markup: { inline_keyboard: [] } })
        } else if (jetzt - ein.date < 10 * MIN) {
          await tgStill($, z, 'sendMessage', {
            chat_id: zg.chat, reply_to_message_id: ein.msg,
            text: '🤷 Das konnte ich keiner offenen Sitzung zuordnen. Antworte direkt auf eine Fertig-Meldung oder Rückfrage.',
          })
        }
      }
      if (weg && frei) neu = u.update_id + 1
      if (!weg) frei = false
    }
    await $.store.set('tg:erledigt', erledigt.slice(-100))
    if (neu > z.offset) {
      z.offset = neu
      await $.store.set('tg:offset', neu)
    }
    for (const id of z.fremdSeit.keys()) if (id < z.offset) z.fremdSeit.delete(id)
  } catch (err) {
    merkeFehler($, z, err)
  } finally {
    z.holtSeit = 0
  }
}

async function postAbholen($: EngineInterface, z: Zustand) {
  const key = `post:${z.sid}`
  const liste = await $.store.get(key) as TgUpdate[] | undefined
  if (!liste?.length) return
  await $.store.delete(key)
  const zg = await zugangLesen($, z)
  if (!zg) return
  for (const u of liste) {
    if (z.gesehen.includes(u.update_id)) continue
    z.gesehen = [...z.gesehen.slice(-49), u.update_id]
    await verarbeite($, z, einordnen(u, zg.chat))
  }
}

async function aufraeumen($: EngineInterface, now: number) {
  for (const key of await $.store.keys()) {
    if (key.startsWith('offen:')) {
      const o = await $.store.get(key) as Offen | undefined
      if (!o || now - o.at > FADEN_MS + MIN) await $.store.delete(key)
    } else if (key.startsWith('post:')) {
      // Post für Sitzungen, die nichts mehr offen haben.
      if (!(await $.store.get(`offen:${key.slice('post:'.length)}`))) await $.store.delete(key)
    }
  }
}

// ---------- /telegram ----------

const ANLEITUNG = [
  'Einrichten in drei Schritten:',
  '1. In Telegram @BotFather öffnen, /newbot schicken, Namen wählen. Er antwortet mit einem Token.',
  '2. Den Token in die Datei ~/.claude/telegram.env schreiben (eine Zeile, nicht hier in den Chat):',
  '     TELEGRAM_BOT_TOKEN=123456:ABC…',
  '3. Deinem neuen Bot in Telegram eine Nachricht schicken (z. B. „hallo“), dann /telegram einrichten.',
].join('\n')

/**
 * Sucht zum Token in telegram.env den Chat: den, aus dem zuletzt jemand dem Bot
 * geschrieben hat, also den eigenen, direkt vor dem Einrichten. Der Token kommt
 * nie über den Chat, damit er nicht im Verlauf landet.
 */
async function einrichten($: EngineInterface, z: Zustand): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) return 'HOME ist nicht gesetzt.'
  const pfad = `${home}/.claude/telegram.env`
  let roh = ''
  try { roh = await $.fs.read(pfad) } catch { /* gibt es noch nicht */ }
  const werte = leseWerte(roh)
  const token = werte.TELEGRAM_BOT_TOKEN
  if (!token) return `In ${pfad} steht noch kein TELEGRAM_BOT_TOKEN.\n\n${ANLEITUNG}`
  z.zugang = { token, chat: werte.TELEGRAM_CHAT_ID ?? '' }
  try {
    const bot = await tg($, z, 'getMe', {}) as { username?: string }
    const name = bot.username ? `@${bot.username}` : 'deinem Bot'
    const updates = await tg($, z, 'getUpdates', { offset: -20, timeout: 0, allowed_updates: ['message'] }) as TgUpdate[]
    const chat = updates.map(u => u.message?.chat?.id).filter((x): x is number => typeof x === 'number').at(-1)
    if (chat === undefined) {
      z.zugang = werte.TELEGRAM_CHAT_ID ? z.zugang : null
      return `Token ok (${name}), aber noch keine Nachricht an ihn gefunden. Schick ${name} in Telegram eine Nachricht und führe /telegram einrichten noch einmal aus.`
    }
    const zeilen = roh.split('\n').filter(l => l.trim() && !/^\s*(?:export\s+)?TELEGRAM_CHAT_ID=/.test(l))
    await $.fs.write(pfad, [...zeilen, `TELEGRAM_CHAT_ID=${chat}`, ''].join('\n'))
    z.zugang = { token, chat: String(chat) }
    // Was beim Suchen gelesen wurde, gilt als erledigt: sonst käme „hallo“ später als Antwort an.
    const letzte = updates.at(-1)?.update_id
    if (letzte !== undefined) {
      z.offset = Math.max(z.offset, letzte + 1)
      await $.store.set('tg:offset', z.offset)
    }
    await tg($, z, 'sendMessage', { chat_id: chat, text: '✅ Claude Code ist verbunden. Hier kommen ab jetzt Fertig-Meldungen und Rückfragen an.' })
    return `Verbunden mit ${name}, Chat ${chat} steht in ${pfad}. In Telegram sollte eine Bestätigung angekommen sein.`
  } catch (err) {
    z.zugang = undefined
    return `Einrichten ging nicht: ${err instanceof Error ? err.message : String(err)}`
  }
}

function karte(z: Zustand, leer: number | null): string {
  const zugang = z.zugang === null ? '⚠️ noch nicht eingerichtet: /telegram einrichten' : 'ok'
  const offen = [...z.rueckfragen.values()].filter(r => r.gesendet && !r.geschlossen).length
  return [
    'telegram-draht',
    `Weg ab          ${z.wegAb > 0 ? `${z.wegAb} min ohne Maus und Tastatur: dann kommt jeder Abschluss aufs Handy` : 'aus'}`,
    `Immer ab        ${z.fertigAb > 0 ? `${z.fertigAb} min Laufzeit, auch wenn du da bist` : 'aus'}`,
    `Rückfragen      ${z.fragenNach < 0 ? 'aus' : z.fragenNach === 0 ? 'sofort aufs Handy' : `aufs Handy nach ${z.fragenNach} s ohne Antwort, sofort wenn du weg bist`}`,
    `Offen           ${offen} Rückfrage(n), ${z.faeden.length} Fertig-Meldung(en) zum Antworten`,
    `Leerlauf        ${leer === null ? 'nicht messbar, daher: Meldung ab 10 min Laufzeit' : `jetzt ${fmtDauer(leer)} ohne Maus und Tastatur`}`,
    `Zugang          ${zugang}`,
    ...(z.tgFehler ? [`Letzter Fehler  ${z.tgFehler}`] : []),
    '',
    '/telegram weg <min>|aus · fertig <min>|aus · fragen <sek>|sofort|aus · test · einrichten',
  ].join('\n')
}

export const register: Register = on => {
  const z = neuerZustand()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    z.projekt = e.cwd.replace(/\/+$/, '').split('/').pop() ?? ''
    z.sid = await $.session.id()
    const w = await $.store.get('wegAb')
    if (typeof w === 'number') z.wegAb = w
    const f = await $.store.get('fertigAb')
    if (typeof f === 'number') z.fertigAb = f
    const q = await $.store.get('fragenNach')
    if (typeof q === 'number') z.fragenNach = q
    // Nach dem Neuladen der Mod: offene Fertig-Meldungen gelten weiter.
    const o = await $.store.get(`offen:${z.sid}`) as Offen | undefined
    if (o?.faeden) z.faeden = o.faeden.filter(x => x.bis > now)
    await aufraeumen($, now)
    await $.command.register({
      name: 'telegram',
      description: 'Telegram: Fertig-Meldungen und Rückfragen aufs Handy (telegram-draht)',
      argumentHint: '[weg <min>|aus | fertig <min>|aus | fragen <sek>|sofort|aus | test | einrichten]',
      immediate: true,
    })
    $.clock.every(POLL_MS, () => {
      const was = hatOffenes(z)
      if (!was) return
      void $.clock.now().then(t => {
        if (was === 'frage' || t - z.zuletztGeholt >= FADEN_POLL_MS) void hole($, z)
      })
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    for (const rf of z.rueckfragen.values()) await schliesseRueckfrage($, z, rf, () => '👋 Sitzung beendet.')
    await schliesseFaeden($, z,
      e.reason === 'clear' ? '🧹 Sitzung mit /clear geleert, Antworten gehen nicht mehr.'
        : e.reason === 'resume' ? '↪ Eine andere Sitzung wurde geöffnet.'
        : '👋 Sitzung beendet, Antworten gehen nicht mehr.')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'telegram-draht') z.naechsterAusTelegram = true
    return next(e)
  })

  // turn.start kommt nur für den Hauptverlauf.
  on('turn.start', async ($, e, next) => {
    const ausTelegram = z.naechsterAusTelegram
    z.naechsterAusTelegram = false
    z.zug = { start: await $.clock.now(), ausTelegram, selbst: false }
    if (!ausTelegram) await schliesseFaeden($, z, '💬 Du hast in der Sitzung weitergeschrieben.')
    return next(e)
  })

  // Hat Claude selbst per ~/.claude/bin/tg gemeldet, kommt keine zweite Meldung.
  // Im Hintergrund angehängt (befehl; tg …) zählt nicht: das meldet erst später.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool === 'Bash' && !e.agentId && z.zug && !e.run_in_background && TG_SKRIPT.test(e.command) && !/nohup|&\s*$/.test(e.command)) z.zug.selbst = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const zug = z.zug
    z.zug = null
    if (!zug || e.reason === 'aborted') return r
    const weg = istWeg(await leerlaufMs($), z.wegAb, e.durationMs)
    const lang = z.fertigAb > 0 && e.durationMs >= z.fertigAb * MIN
    if (!zug.ausTelegram && (!(weg || lang) || zug.selbst)) return r
    const ort = `📁 ${z.projekt || 'Claude Code'}`
    const kopf = e.reason === 'answer'
      ? (zug.ausTelegram && !weg && !lang ? `💬 Claude antwortet · ${ort}` : `✅ Fertig nach ${fmtDauer(e.durationMs)} · ${ort}`)
      : `⚠️ Mit Fehler beendet nach ${fmtDauer(e.durationMs)} · ${ort}`
    await meldeFertig($, z, kopf, e.answer)
    return r
  })

  // Die Rückfrage läuft am Rechner wie immer. Bleibt sie unbeantwortet, geht sie
  // zusätzlich aufs Handy; wer zuerst antwortet, gilt. Kommt die Antwort aus
  // Telegram, schließt das Zurückgeben ohne next den Dialog am Rechner.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion' || z.fragenNach < 0 || !(await zugangLesen($, z))) return next(e)
    let fertig: (a: Record<string, string>) => void = () => {}
    const perTelegram = new Promise<Record<string, string>>(res => { fertig = res })
    const rf: Rueckfrage = {
      id: kennung(),
      teile: e.questions.map(q => ({
        frage: q.question, kopf: q.header, mehrfach: q.multiSelect, gewaehlt: [], messageId: 0, text: '',
        optionen: q.options.map(o => ({ label: o.label, description: o.description })),
      })),
      gesendet: false, geschlossen: false, zeit: 0, fertig: a => fertig(a),
    }
    z.rueckfragen.set(rf.id, rf)
    const lokal = next(e)
    // Ohne Messung wird hier nicht geraten: dann gilt die Wartezeit.
    const weg = istWeg(await leerlaufMs($), z.wegAb, 0)
    const wecker = $.clock.after(weg ? 1 : Math.max(1, z.fragenNach * SEK), () => void sendeRueckfrage($, z, rf))
    try {
      const lokalFertig = lokal.then(res => ({ lokal: res }))
      const sieger = await Promise.race([lokalFertig, perTelegram.then(antworten => ({ antworten }))])
      if ('lokal' in sieger) {
        const a = antwortenAus(sieger.lokal)
        await schliesseRueckfrage($, z, rf, t => a[t.frage] ? `💻 Am Rechner beantwortet: ${a[t.frage]}` : '💻 Am Rechner erledigt.')
        return sieger.lokal
      }
      lokalFertig.catch(() => { /* der Dialog wird verworfen */ })
      await schliesseRueckfrage($, z, rf, t => `✅ ${t.antwort ?? ''}`)
      $.ui.toast('Rückfrage per Telegram beantwortet')
      return { result: { questions: e.questions, answers: sieger.antworten } }
    } finally {
      wecker.cancel()
      if (!rf.geschlossen) await schliesseRueckfrage($, z, rf, () => '✖️ Abgebrochen.')
      z.rueckfragen.delete(rf.id)
    }
  })

  on('command.run', { command: 'telegram' }, async ($, e) => {
    const [was = '', wert = ''] = String(e.args ?? '').trim().toLowerCase().split(/\s+/)
    await zugangLesen($, z)
    if (was === 'einrichten') return { text: await einrichten($, z) }
    if (was === 'weg') {
      const n = wert === 'aus' ? 0 : Number(wert)
      if (!Number.isFinite(n) || n < 0 || (wert !== 'aus' && !wert)) return { text: 'Weg ab: Minuten ohne Maus und Tastatur (z. B. 3) oder aus?' }
      z.wegAb = n
      await $.store.set('wegAb', n)
      return { text: n ? `Nach ${n} min ohne Maus und Tastatur giltst du als weg: dann kommt jeder Abschluss aufs Handy.` : 'Abwesenheit wird nicht mehr beachtet.' }
    }
    if (was === 'fertig') {
      const n = wert === 'aus' ? 0 : Number(wert)
      if (!Number.isFinite(n) || n < 0 || (wert !== 'aus' && !wert)) return { text: 'Fertig-Meldung: Minuten (z. B. 10) oder aus?' }
      z.fertigAb = n
      await $.store.set('fertigAb', n)
      return { text: n ? `Zusätzlich meldet sich jeder Auftrag ab ${n} min Laufzeit, auch wenn du da bist.` : 'Nur noch melden, wenn du weg bist.' }
    }
    if (was === 'fragen') {
      const n = wert === 'aus' ? -1 : wert === 'sofort' ? 0 : Number(wert)
      if (!Number.isFinite(n) || (wert !== 'aus' && wert !== 'sofort' && !wert)) return { text: 'Rückfragen: Sekunden (z. B. 60), sofort oder aus?' }
      z.fragenNach = n
      await $.store.set('fragenNach', n)
      return { text: n < 0 ? 'Rückfragen bleiben am Rechner.' : n === 0 ? 'Rückfragen gehen sofort aufs Handy.' : `Rückfragen gehen nach ${n} s ohne Antwort aufs Handy.` }
    }
    if (was === 'test') {
      if (!z.zugang) return { text: ANLEITUNG }
      await meldeFertig($, z, `🧪 Test · 📁 ${z.projekt || 'Claude Code'}`,
        'So sieht eine Fertig-Meldung aus. Antworte auf diese Nachricht: dein Text landet als neue Nachricht in dieser Sitzung.')
      return { text: z.tgFehler ? `Ging nicht: ${z.tgFehler}` : 'Testnachricht geschickt. Antworte in Telegram darauf.' }
    }
    const unbekannt = was && was !== 'status' && was !== 'hilfe' ? `„${String(e.args).trim()}“ kenne ich nicht.\n\n` : ''
    return { text: unbekannt + karte(z, await leerlaufMs($)) }
  })
}
