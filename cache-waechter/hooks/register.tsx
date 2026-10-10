import type { EngineInterface, Register } from 'claude-code'

const MIN = 60 * 1000
// Abo-Sitzungen bekommen für den Hauptverlauf eine Stunde Cache (Doku
// „Which TTL each request gets“). Mit API-Schlüssel wären es 5 min, dann
// promptCacheTtl auf "1h" setzen, sonst stimmt hier nichts.
export const TTL_MS = 60 * MIN
// Angehalten wird erst ab 150k: darunter kostet ein Neuaufbau zu wenig, als
// dass sich das Anhalten lohnt (so gewählt am 09.10., vorher 50k).
export const WARN_AB = 150_000
// Die Anzeige „knapp“ meldet sich schon ab 50k: sehen schadet nicht, anhalten nervt.
export const ANZEIGE_AB = 50_000
// Telegram nur, wo es um richtig viel geht: sonst wird das Handy zum Wecker.
// (09.10.: von 100k auf 200k angehoben, wie gewünscht.)
export const TELEGRAM_AB = 200_000
// 50 min nach der letzten Anfrage fragen lässt 10 min zum Antworten.
export const FRAGE_NACH_MS = 50 * MIN
// Wer erst kurz vor Schluss dran wäre (Mod neu geladen, Telegram eben erst an),
// bekommt keine Frage mehr: in unter 2 min antwortet niemand.
const FRAGE_MIN_REST_MS = 2 * MIN
// „knapp“ zeigt die Angabe ab 25 min Restzeit: früh genug, um noch etwas
// Größeres zu Ende zu bringen, aber nicht die ganze Stunde lang.
export const KNAPP_MS = 25 * MIN
// Alle 4 s nachsehen: ein Knopfdruck wirkt spürbar sofort, und das Abholen
// läuft nur, solange eine Frage offen ist (höchstens 10 min).
const POLL_MS = 4000
// Bei einem Ausfall (am 09.10. ein 502 von Telegram) hing ein Abholen bis zu
// 30 s; nach 20 s gilt es als verloren und das nächste darf los.
const HAENGT_MS = 20 * 1000
// Ist Telegram nicht erreichbar, erst nach einer Minute neu senden, nicht alle 4 s.
const NEUVERSUCH_MS = MIN
const TICK_MS = 30 * 1000
const PING_PROMPT = 'Antworte nur mit dem Wort: warm'
// Ab 400k wird ohne Antwort komprimiert: ein kalter Neuaufbau kostet dann mehr
// als die Zusammenfassung (10.10., wie gewünscht). Erst 3 min vor dem Abkühlen,
// solange der Cache noch warm ist: dann liest auch das Komprimieren aus ihm.
export const AUTO_KOMPAKT_AB = 400_000
const AUTO_REST_MS = 3 * MIN
// Länger warmhalten: alle 55 min ein Ping, 5 min Luft vor dem Abkühlen.
export const WARM_PING_MS = 55 * MIN
export const WARM_STUNDEN = [3, 8] as const

export type Anzeige = 'aus' | 'knapp' | 'immer'
// „unten“: klein rechts in der Fußzeile, nah an der Verbrauchsanzeige der App
// (in die selbst darf eine Mod nicht zeichnen). „oben“: die breite Zeile über der Eingabe.
export type Ort = 'unten' | 'oben'
type Aktion = 'kompakt' | 'warm' | 'warm3' | 'warm8' | 'nichts'
const AKTIONEN: readonly string[] = ['kompakt', 'warm', 'warm3', 'warm8', 'nichts']

export type Lage = {
  /** Wann die Hauptsitzung zuletzt ans Modell ging (ms); 0 = noch nie. */
  letzteAnfrage: number
  /** Tokens, die die nächste Anfrage mitschickt. */
  ctx: number
  /** Nach /compact steht erst die Zusammenfassung im Cache, die kostet wenig. */
  kompaktiert: boolean
}

export function istKalt(l: Lage, now: number): boolean {
  return l.letzteAnfrage > 0 && !l.kompaktiert && now - l.letzteAnfrage >= TTL_MS
}

// Abgerundet: „noch 5 min“ heißt mindestens fünf, nie weniger als gezeigt.
export function fmtDauer(ms: number): string {
  if (ms < MIN) return 'unter 1 min'
  const m = Math.floor(ms / MIN)
  const std = Math.floor(m / 60)
  return std ? `${std} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`
}

export function fmtTok(n: number): string {
  // Ab 999,5k rundet „k“ auf 1000k: dann lieber gleich Millionen.
  if (n >= 999_500) return (n / 1e6).toFixed(1).replace('.', ',') + ' Mio.'
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

/** Die Zeile über der Eingabe, oder null, wenn sie nichts zu sagen hat. */
export function bandText(l: Lage, now: number, anzeige: Anzeige): string | null {
  if (anzeige === 'aus') return null
  // Nach /compact gibt es keinen Ablauf zu zählen: der Cache entsteht erst mit der
  // nächsten Nachricht neu. Bei „immer“ sagt die Zeile das, statt einfach zu verschwinden.
  if (l.kompaktiert) return anzeige === 'immer' ? `Cache komprimiert auf ${fmtTok(l.ctx)} Tokens · baut sich mit der nächsten Nachricht neu auf` : null
  if (!l.letzteAnfrage || !l.ctx) return null
  if (anzeige === 'knapp' && l.ctx < ANZEIGE_AB) return null
  if (istKalt(l, now)) return `Cache kalt seit ${fmtDauer(now - l.letzteAnfrage - TTL_MS)} · die nächste Nachricht liest ${fmtTok(l.ctx)} Tokens neu ein`
  const rest = l.letzteAnfrage + TTL_MS - now
  if (anzeige === 'knapp' && rest > KNAPP_MS) return null
  return `Cache warm · noch ${fmtDauer(rest)} · ${fmtTok(l.ctx)} Tokens`
}

/** Kästchen für die Stunde: voll gerade erst benutzt, leer kurz vorm Abkühlen. */
export function balken(rest: number, zellen = 10): string {
  const voll = Math.max(0, Math.min(zellen, Math.ceil((rest / TTL_MS) * zellen)))
  return '▰'.repeat(voll) + '▱'.repeat(zellen - voll)
}

/** Die kurze Angabe für die Fußzeile; dieselben Regeln wie bandText, nur knapper. */
export function modusText(l: Lage, now: number, anzeige: Anzeige): string | null {
  if (!bandText(l, now, anzeige)) return null
  if (l.kompaktiert) return 'Cache 🗜 komprimiert'
  if (istKalt(l, now)) return `❄ Cache kalt · ${fmtTok(l.ctx)}`
  // Fünf Kästchen: die Fußzeile ist schmal, und eins steht für 12 min.
  const rest = l.letzteAnfrage + TTL_MS - now
  return `Cache ${balken(rest, 5)} ${fmtDauer(rest)}`
}

/** Grün mit Luft, gelb in den letzten 15 min: so wenig Farbe wie möglich. */
export function farbe(rest: number): 'success' | 'warning' {
  return rest > 15 * MIN ? 'success' : 'warning'
}

type TgZugang = { token: string; chat: string }
type TgUpdate = {
  update_id: number
  callback_query?: { id: string; data?: string; message?: { message_id?: number; chat?: { id?: number } } }
  message?: { text?: string }
}
type Frage = { kennung: string; messageId: number; bis: number; text: string }

/** Was eine Sitzung im Store hinterlässt, damit ein Neuladen der Mod nahtlos weitermacht. */
type Merk = { zeit: number; kompakt: boolean; gefragt: number; frage: Frage | null; at: number; warmBis?: number; verzicht?: number }

/** Liest ~/.claude/telegram.env, dieselbe Datei wie telegram-draht und ~/.claude/bin/tg. */
export function leseZugang(text: string): TgZugang | null {
  const werte: Record<string, string> = {}
  for (const zeile of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)=(.*)$/.exec(zeile)
    if (m?.[1] && m[2] !== undefined) werte[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  const token = werte.TELEGRAM_BOT_TOKEN
  const chat = werte.TELEGRAM_CHAT_ID
  return token && chat ? { token, chat } : null
}

type Angehalten = { kaltSeit: number; ctx: number; probe: boolean; at: number }

type Zustand = {
  lage: Lage
  anzeige: Anzeige
  ort: Ort
  warnung: boolean
  telegram: boolean
  /** Die Zeit der letzten Anfrage, deren Warnung schon gezeigt wurde: die zweite Eingabe geht durch. */
  quittiert: number
  laeuft: boolean
  projekt: string
  zugang: TgZugang | null | undefined
  offset: number
  frage: Frage | null
  fragt: boolean
  /** Die letzte Anfrage, zu der schon gefragt wurde: „Nichts“ heißt nichts, auch nach einem Neuladen. */
  gefragt: number
  /** Nach einem Sendefehler erst ab dann wieder versuchen. */
  naechsterVersuch: number
  /** Seit wann ein Abholen läuft; 0 = keins. */
  holtSeit: number
  tgFehler: string
  /** Schon beantwortete Knopfdrücke: zwei Sitzungen können denselben abholen. */
  erledigt: string[]
  /** Seit wann ein Update für telegram-draht liegt (nach update_id). */
  fremdSeit: Map<number, number>
  /** Die nächste Eingabe wird zur Probe angehalten, auch bei warmem Cache. */
  warnTest: boolean
  /** Die zuletzt angehaltene Nachricht: die Karte über der Eingabe zeigt sie. */
  angehalten: Angehalten | null
  /** Ob die letzte Messung Abo-Limits kannte; null = noch keine Messung. */
  abo: boolean | null
  /** Ab 400k ohne Antwort komprimieren. */
  auto: boolean
  /** Bis wann der Cache von selbst warmgehalten wird; 0 = nicht. */
  warmBis: number
  /** Die letzte Anfrage, zu der „Nichts“ gewählt wurde: dann auch nicht von selbst komprimieren. */
  verzicht: number
  /** Die letzte Anfrage, zu der schon von selbst komprimiert wurde. */
  autoVersucht: number
  /** Ein Ping oder Komprimieren läuft gerade. */
  arbeitet: boolean
}

function neuerZustand(): Zustand {
  return {
    lage: { letzteAnfrage: 0, ctx: 0, kompaktiert: false }, anzeige: 'knapp', ort: 'unten', warnung: true, telegram: true,
    quittiert: 0, laeuft: false, projekt: '', zugang: undefined, offset: 0, frage: null, fragt: false,
    gefragt: 0, naechsterVersuch: 0, holtSeit: 0, tgFehler: '', erledigt: [], fremdSeit: new Map(), warnTest: false, angehalten: null, abo: null,
    auto: true, warmBis: 0, verzicht: 0, autoVersucht: 0, arbeitet: false,
  }
}

/** Alles, was zu genau einer Unterhaltung gehört; nach /clear beginnt es neu. */
function vergiss(z: Zustand) {
  z.lage = { letzteAnfrage: 0, ctx: 0, kompaktiert: false }
  z.quittiert = 0
  z.gefragt = 0
  z.angehalten = null
  z.warmBis = 0
  z.verzicht = 0
  z.autoVersucht = 0
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

// Erst nachdem das Feld geleert ist, den Text zurücklegen. Wo es kein Feld
// gibt, das sich füllen lässt, steht er wenigstens zum Kopieren im Verlauf.
function haltAn($: EngineInterface, text: string) {
  $.clock.after(150, () => {
    void $.prompt.fill({ text }).then(r => {
      if (!r.isFilled) $.ui.log(`Dein angehaltener Text:\n${text}`)
    })
  })
}

// /clear und Fortsetzen wechseln die Sitzungskennung im selben Prozess:
// deshalb jedes Mal frisch fragen statt sie beim Start zu merken.
async function merkKey($: EngineInterface): Promise<string> {
  return `sitzung:${await $.session.id()}`
}

async function speichern($: EngineInterface, z: Zustand) {
  const m: Merk = {
    zeit: z.lage.letzteAnfrage, kompakt: z.lage.kompaktiert, gefragt: z.gefragt, frage: z.frage, at: await $.clock.now(),
    warmBis: z.warmBis, verzicht: z.verzicht,
  }
  await $.store.set(await merkKey($), m)
}

/** Holt zurück, was diese Sitzung vor dem Neuladen wusste. */
async function laden($: EngineInterface, z: Zustand, now: number) {
  const m = await $.store.get(await merkKey($)) as Merk | undefined
  if (!m) {
    // Die erste Fassung der Mod merkte sich nur die Zeit, unter eigenem Schlüssel.
    const alt = await $.store.get(`zeit:${await $.session.id()}`)
    if (typeof alt === 'number' && !z.lage.letzteAnfrage) z.lage.letzteAnfrage = alt
    return
  }
  if (m.zeit && !z.lage.letzteAnfrage) z.lage.letzteAnfrage = m.zeit
  z.lage.kompaktiert = m.kompakt
  z.gefragt = m.gefragt
  z.warmBis = m.warmBis ?? 0
  z.verzicht = m.verzicht ?? 0
  if (m.frage && m.frage.bis > now) z.frage = m.frage
}

async function aufraeumen($: EngineInterface, now: number) {
  for (const key of await $.store.keys()) {
    // Was eine frühere Fassung der Mod hinterließ.
    if (key === 'diag' || key === 'blick' || key === 'blickOben' || /^(zeit|kompakt|frage):/.test(key)) await $.store.delete(key)
    else if (key.startsWith('antwort:') || key.startsWith('sitzung:')) {
      const v = await $.store.get(key) as { at?: number } | undefined
      // Antworten, die keine Sitzung abgeholt hat, und Sitzungen von gestern.
      const alt = key.startsWith('antwort:') ? 2 * TTL_MS : 24 * TTL_MS
      if (!v?.at || now - v.at > alt) await $.store.delete(key)
    }
  }
}

// Die Fehlermeldung nennt nie den Bot-Token: er steckt in der URL, und manche
// Netzfehler zitieren sie.
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

async function tgLeise($: EngineInterface, z: Zustand, methode: string, body: object) {
  try { await tg($, z, methode, body) } catch (err) { merkeFehler($, z, err) }
}

// Fürs Aufräumen fremder oder doppelter Knöpfe: dort ist ein Fehler
// („query is too old“, „message is not modified“) erwartbar und kein Befund.
async function tgStill($: EngineInterface, z: Zustand, methode: string, body: object) {
  try { await tg($, z, methode, body) } catch { /* bewusst still */ }
}

function merkeFehler($: EngineInterface, z: Zustand, err: unknown) {
  const text = err instanceof Error ? err.message : String(err)
  if (text !== z.tgFehler) $.ui.log(`cache-waechter: ${text}`, { to: 'debug' })
  z.tgFehler = text
}

function neuZeichnen($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

async function schliesseFrage($: EngineInterface, z: Zustand, zusatz: string) {
  const f = z.frage
  if (!f) return
  z.frage = null
  // Erst die Nachricht: beim Beenden bleibt nur gut eine Sekunde.
  const zg = await zugangLesen($, z)
  if (zg) await tgLeise($, z, 'editMessageText', { chat_id: zg.chat, message_id: f.messageId, text: `${f.text}\n\n${zusatz}` })
  await speichern($, z)
}

/** Ob jetzt die Frage vor dem Abkühlen fällig ist; der Abholtakt fragt das alle 4 s. */
function faellig(z: Zustand, now: number): boolean {
  const l = z.lage
  if (!z.telegram || z.laeuft || z.frage || z.fragt || l.kompaktiert || l.ctx < TELEGRAM_AB || !l.letzteAnfrage) return false
  if (z.gefragt === l.letzteAnfrage || now < z.naechsterVersuch || warmGedeckt(z)) return false
  const alter = now - l.letzteAnfrage
  return alter >= FRAGE_NACH_MS && TTL_MS - alter >= FRAGE_MIN_REST_MS
}

/** Ob der nächste Ping noch in die gewählte Warmhaltezeit fällt: dann wird nicht gefragt. */
function warmGedeckt(z: Zustand): boolean {
  return z.lage.letzteAnfrage > 0 && z.warmBis >= z.lage.letzteAnfrage + WARM_PING_MS
}

/** Ob gerade nichts anderes läuft, das ein Ping oder Komprimieren stören würde. */
function frei(z: Zustand): boolean {
  return !z.laeuft && !z.arbeitet && !z.holtSeit && !z.lage.kompaktiert && z.lage.letzteAnfrage > 0
}

/** Ob jetzt der Ping fällig ist, der den Cache über die gewählte Zeit warmhält. */
function warmFaellig(z: Zustand, now: number): boolean {
  if (!frei(z) || !warmGedeckt(z)) return false
  const alter = now - z.lage.letzteAnfrage
  // Schon kalt (Mod zu spät geladen): ein Ping würde alles neu schreiben, das ist kein Warmhalten.
  return alter >= WARM_PING_MS && alter < TTL_MS - 30 * 1000
}

/** Ob jetzt von selbst komprimiert wird: ab 400k, ohne Antwort, kurz vor dem Abkühlen. */
function autoFaellig(z: Zustand, now: number): boolean {
  const l = z.lage
  if (!z.auto || !frei(z) || l.ctx < AUTO_KOMPAKT_AB || warmGedeckt(z)) return false
  if (z.verzicht === l.letzteAnfrage || z.autoVersucht === l.letzteAnfrage) return false
  const alter = now - l.letzteAnfrage
  return alter >= TTL_MS - AUTO_REST_MS && alter < TTL_MS
}

async function autoKompakt($: EngineInterface, z: Zustand) {
  z.autoVersucht = z.lage.letzteAnfrage
  z.arbeitet = true
  // Die Frage beiseite: ein Knopfdruck während des Komprimierens gilt als erledigt.
  const f = z.frage
  z.frage = null
  let ergebnis: string
  try {
    ergebnis = await kompaktiere($, z)
  } catch (err) {
    merkeFehler($, z, err)
    ergebnis = `⚠️ Ging nicht: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    z.arbeitet = false
  }
  $.ui.toast(`Cache-Wächter: ab ${fmtTok(AUTO_KOMPAKT_AB)} ohne Antwort komprimiert`)
  if (!f) return
  z.frage = f
  await schliesseFrage($, z, `⏱ Keine Antwort, daher von selbst: ${ergebnis}`)
}

async function autoWarm($: EngineInterface, z: Zustand) {
  z.arbeitet = true
  let text: string
  try {
    text = await halteWarm($, z)
  } catch (err) {
    merkeFehler($, z, err)
    text = `⚠️ Warmhalten ging nicht: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    z.arbeitet = false
  }
  if (!text.startsWith('⚠️')) return
  // Kein Endlos-Versuch alle 4 s: die Warmhaltezeit endet, ab dann gilt wieder Frage bzw. Komprimieren.
  z.warmBis = 0
  await speichern($, z)
  const zg = z.telegram ? await zugangLesen($, z) : null
  if (zg) await tgLeise($, z, 'sendMessage', { chat_id: zg.chat, text: `${text}\n📁 ${z.projekt || 'Claude Code'}` })
}

/** Ein Takt für alles: von selbst komprimieren, warmhalten, fragen, Antworten abholen. */
async function takt($: EngineInterface, z: Zustand) {
  const t = await $.clock.now()
  if (autoFaellig(z, t)) return autoKompakt($, z)
  if (warmFaellig(z, t)) return autoWarm($, z)
  if (z.frage) return hole($, z)
  if (faellig(z, t)) await stelleFrage($, z, false)
}

async function stelleFrage($: EngineInterface, z: Zustand, test: boolean): Promise<string> {
  if (z.fragt) return 'Eine Frage wird gerade geschickt.'
  const zg = await zugangLesen($, z)
  if (!zg) return 'Keine Zugangsdaten: ~/.claude/telegram.env braucht TELEGRAM_BOT_TOKEN und TELEGRAM_CHAT_ID.'
  z.fragt = true
  try {
    if (z.frage) await schliesseFrage($, z, 'Ersetzt durch eine neue Frage.')
    const now = await $.clock.now()
    const id = kennung()
    const rest = z.lage.letzteAnfrage && !istKalt(z.lage, now) ? z.lage.letzteAnfrage + TTL_MS - now : 0
    const auto = !test && z.auto && z.lage.ctx >= AUTO_KOMPAKT_AB && rest > AUTO_REST_MS
    const text = [
      test ? '🧪 Testfrage, die Knöpfe wirken echt' : `🧊 Cache kühlt in ${fmtDauer(rest)} ab`,
      `📁 ${z.projekt || 'Claude Code'} · ${fmtTok(z.lage.ctx)} Tokens`,
      '',
      auto ? `Was soll passieren? Ohne Antwort komprimiere ich in ${fmtDauer(rest - AUTO_REST_MS)}.` : 'Was soll passieren?',
    ].join('\n')
    const msg = await tg($, z, 'sendMessage', {
      chat_id: zg.chat,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🗜 Komprimieren', callback_data: `cw:${id}:kompakt` },
            { text: '🔥 1 h warm', callback_data: `cw:${id}:warm` },
            { text: 'Nichts', callback_data: `cw:${id}:nichts` },
          ],
          WARM_STUNDEN.map(h => ({ text: `🔥 ${h} h warm`, callback_data: `cw:${id}:warm${h}` })),
        ],
      },
    }) as { message_id: number }
    // Die Testfrage gilt zehn Minuten, eine echte bis der Cache kalt ist.
    z.frage = { kennung: id, messageId: msg.message_id, bis: test || !rest ? now + 10 * MIN : now + rest, text }
    if (!test) z.gefragt = z.lage.letzteAnfrage
    await speichern($, z)
    return 'Frage geschickt.'
  } catch (err) {
    merkeFehler($, z, err)
    z.naechsterVersuch = (await $.clock.now()) + NEUVERSUCH_MS
    return err instanceof Error ? err.message : String(err)
  } finally {
    z.fragt = false
  }
}

/** Ob irgendeine Sitzung diese Frage noch offen hat. */
async function offenAnderswo($: EngineInterface, id: string, now: number): Promise<boolean> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('sitzung:')) continue
    const m = await $.store.get(key) as Merk | undefined
    if (m?.frage?.kennung === id && m.frage.bis > now) return true
  }
  return false
}

// Kurzes Abfragen statt Long-Polling: zwei Sitzungen, die gleichzeitig lange
// warten, wirft Telegram mit 409 raus. Der Offset liegt im gemeinsamen Store,
// damit keine Sitzung Knopfdrücke abholt, die eine andere schon erledigt hat;
// Antworten für andere Sitzungen landen dort ebenfalls.
async function hole($: EngineInterface, z: Zustand) {
  const jetzt = await $.clock.now()
  if (!z.frage || z.arbeitet || (z.holtSeit && jetzt - z.holtSeit < HAENGT_MS)) return
  z.holtSeit = jetzt
  try {
    const zg = await zugangLesen($, z)
    if (!zg) return
    const gemeinsam = await $.store.get('tg:offset')
    z.offset = Math.max(z.offset, typeof gemeinsam === 'number' ? gemeinsam : 0)
    const updates = await tg($, z, 'getUpdates', { offset: z.offset, timeout: 0 }) as TgUpdate[]
    let frei = true
    for (const u of updates) {
      // Knöpfe und Texte der Mod telegram-draht („td:“, Antworten) liegen
      // lassen, bis sie sie holt: der Offset quittiert alles darunter für alle.
      const fuerDraht = u.callback_query?.data?.startsWith('td:') || u.message?.text !== undefined
      if (fuerDraht && !verwaist(z, u.update_id, jetzt)) frei = false
      if (frei) z.offset = Math.max(z.offset, u.update_id + 1)
      if (fuerDraht) continue
      const cq = u.callback_query
      if (!cq?.data?.startsWith('cw:') || String(cq.message?.chat?.id) !== zg.chat) continue
      if (z.erledigt.includes(cq.id)) continue
      z.erledigt = [...z.erledigt.slice(-19), cq.id]
      const [, id = '', aktion = ''] = cq.data.split(':')
      if (!AKTIONEN.includes(aktion)) continue
      const now = await $.clock.now()
      if (z.frage && id === z.frage.kennung) await beantworte($, z, aktion as Aktion, cq.id)
      else if (await offenAnderswo($, id, now)) await $.store.set(`antwort:${id}`, { aktion, cq: cq.id, at: now })
      else await alterKnopf($, z, zg, cq.id, cq.message?.message_id)
    }
    if (updates.length) await $.store.set('tg:offset', z.offset)
    for (const id of z.fremdSeit.keys()) if (id < z.offset) z.fremdSeit.delete(id)
    if (z.frage) {
      const key = `antwort:${z.frage.kennung}`
      const fremd = await $.store.get(key) as { aktion: Aktion; cq: string } | undefined
      if (fremd) {
        await $.store.delete(key)
        await beantworte($, z, fremd.aktion, fremd.cq)
      }
    }
    if (z.frage && (await $.clock.now()) >= z.frage.bis) await schliesseFrage($, z, '❄ Abgekühlt, ohne Antwort.')
  } catch (err) {
    merkeFehler($, z, err)
  } finally {
    z.holtSeit = 0
  }
}

/** Ob ein Update für telegram-draht schon eine Minute liegt: dann holt es offenbar niemand mehr. */
function verwaist(z: Zustand, id: number, now: number): boolean {
  const seit = z.fremdSeit.get(id)
  if (seit === undefined) {
    z.fremdSeit.set(id, now)
    return false
  }
  return now - seit >= MIN
}

// Ein Knopf unter einer Frage, die keine Sitzung mehr hat (beendet, doppelt
// gedrückt): sonst dreht er auf dem Handy ewig und wirkt kaputt.
async function alterKnopf($: EngineInterface, z: Zustand, zg: TgZugang, cqId: string, messageId?: number) {
  await tgStill($, z, 'answerCallbackQuery', { callback_query_id: cqId, text: 'Diese Frage ist schon erledigt.' })
  if (messageId) await tgStill($, z, 'editMessageReplyMarkup', { chat_id: zg.chat, message_id: messageId, reply_markup: { inline_keyboard: [] } })
}

async function beantworte($: EngineInterface, z: Zustand, aktion: Aktion, cqId: string) {
  const f = z.frage
  if (!f) return
  z.frage = null
  // Sofort quittieren: Telegram lässt den Knopf sonst drehen, und Komprimieren dauert.
  await tgStill($, z, 'answerCallbackQuery', { callback_query_id: cqId, text: aktion === 'nichts' ? 'Okay' : 'Wird erledigt …' })
  let ergebnis: string
  const now = await $.clock.now()
  const stunden = aktion === 'warm3' ? 3 : aktion === 'warm8' ? 8 : 0
  // Jede Antwort ersetzt eine frühere Warmhaltezeit; „Nichts“ verbietet auch das Komprimieren von selbst.
  z.warmBis = stunden ? now + stunden * 60 * MIN : 0
  if (aktion === 'nichts') z.verzicht = z.lage.letzteAnfrage
  try {
    ergebnis = aktion === 'kompakt' ? await kompaktiere($, z)
      : aktion === 'nichts' ? '👍 Okay, er darf abkühlen.'
      : await halteWarm($, z)
    if (ergebnis.startsWith('⚠️')) z.warmBis = 0
  } catch (err) {
    z.warmBis = 0
    // Was auch schiefgeht: die Nachricht bekommt eine Antwort und die Frage wird geschlossen.
    merkeFehler($, z, err)
    ergebnis = `⚠️ Ging nicht: ${err instanceof Error ? err.message : String(err)}`
  }
  z.frage = f
  await schliesseFrage($, z, ergebnis)
}

/** Nach dem Komprimieren: keine Uhr mehr, bis der nächste Zug den Cache neu aufbaut. */
async function merkeKompakt($: EngineInterface, z: Zustand, nachher: number | undefined) {
  z.lage.kompaktiert = true
  z.warmBis = 0
  if (nachher) z.lage.ctx = nachher
  await speichern($, z)
  neuZeichnen($)
}

async function kompaktiere($: EngineInterface, z: Zustand): Promise<string> {
  if (z.laeuft) return 'Gerade läuft eine Antwort, der Cache bleibt dadurch ohnehin warm.'
  const vorher = z.lage.ctx
  let r
  try {
    r = await $.session.compact()
  } catch {
    // Die Desktop-App läuft als SDK-Sitzung („not available in a headless
    // session“): dort komprimiert nur der Befehl /compact. Als Prompt
    // eingereicht lehnt die Engine ihn ab (Text mit „/“ vorn).
    await $.command.run({ command: 'compact' })
    // Der Befehl meldet sein Ergebnis über session.compact, das merkeKompakt aufruft.
    return z.lage.kompaktiert
      ? `✅ Komprimiert: ${fmtTok(vorher)} → ${fmtTok(z.lage.ctx)} Tokens.`
      : `🗜 /compact läuft in der Sitzung (${fmtTok(vorher)} Tokens vorher).`
  }
  if (r.skip !== undefined) return `Nicht komprimiert: ${r.skip}`
  // Nicht auf session.compact verlassen: ob der Hook bei einem Aufruf aus
  // der Mod selbst feuert, ist nicht zugesichert.
  await merkeKompakt($, z, r.tokensAfter)
  return `✅ Komprimiert: ${fmtTok(r.tokensBefore ?? vorher)} → ${fmtTok(r.tokensAfter ?? z.lage.ctx)} Tokens.`
}

async function halteWarm($: EngineInterface, z: Zustand): Promise<string> {
  if (z.laeuft) return 'Gerade läuft eine Antwort, der Cache bleibt dadurch ohnehin warm.'
  // Der Fork schickt die letzte Anfrage des Hauptverlaufs noch einmal, samt
  // ihrer Cache-Marken: so frischt er genau den Eintrag auf, den die Sitzung braucht.
  const r = await $.model.fork({ prompt: PING_PROMPT })
  if (!r.isAnswered) return `⚠️ Warmhalten ging nicht (${r.reason}).`
  const u = r.usage
  const now = await $.clock.now()
  z.lage.letzteAnfrage = now
  await speichern($, z)
  neuZeichnen($)
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const weiter = warmGedeckt(z)
    ? ` Ich halte ihn noch ${fmtDauer(z.warmBis - now)} warm, danach frage ich wieder.`
    : ' In 50 min frage ich wieder.'
  return warm
    ? `🔥 Warmgehalten: ${fmtTok(u.cache_read_input_tokens)} Tokens aus dem Cache gelesen.${weiter}`
    : `🔥 Der Cache war schon weg: ${fmtTok(u.cache_creation_input_tokens)} Tokens neu geschrieben, jetzt ist er wieder warm.${weiter}`
}

function karte(z: Zustand, now: number): string {
  const l = z.lage
  const zustand = !l.letzteAnfrage ? 'noch keine Anfrage in dieser Sitzung'
    : l.kompaktiert ? `komprimiert auf ${fmtTok(l.ctx)} Tokens, die nächste Nachricht baut ihn neu auf`
    : istKalt(l, now) ? `kalt seit ${fmtDauer(now - l.letzteAnfrage - TTL_MS)} · ${fmtTok(l.ctx)} Tokens`
    : `warm, noch ${fmtDauer(l.letzteAnfrage + TTL_MS - now)} · ${fmtTok(l.ctx)} Tokens`
  const anz = z.anzeige === 'knapp' ? `knapp – ab ${fmtTok(ANZEIGE_AB)} Tokens in den letzten ${KNAPP_MS / MIN} min und wenn kalt`
    : z.anzeige === 'immer' ? 'immer' : 'aus'
  const wo = z.anzeige === 'aus' ? '' : z.ort === 'unten' ? ', unten rechts in der Fußzeile' : ', als Zeile über der Eingabe'
  let tele: string
  if (!z.telegram) tele = 'aus'
  else if (z.zugang === null) tele = 'an, aber ~/.claude/telegram.env fehlt oder ist unvollständig'
  else {
    tele = `an – fragt nach 50 min, ab ${fmtTok(TELEGRAM_AB)} Tokens`
    if (z.frage) tele += ` · Frage offen, noch ${fmtDauer(z.frage.bis - now)}`
    else if (l.ctx >= TELEGRAM_AB && !l.kompaktiert && l.letzteAnfrage && z.gefragt !== l.letzteAnfrage && now - l.letzteAnfrage < FRAGE_NACH_MS)
      tele += ` · nächste in ${fmtDauer(l.letzteAnfrage + FRAGE_NACH_MS - now)}`
    if (z.tgFehler) tele += `\n          letzter Fehler: ${z.tgFehler}`
  }
  const auto = z.auto ? `an – ab ${fmtTok(AUTO_KOMPAKT_AB)} Tokens 3 min vor dem Abkühlen, wenn in Telegram nichts gewählt ist` : 'aus'
  const warm = warmGedeckt(z) ? `noch ${fmtDauer(z.warmBis - now)}, Ping alle ${WARM_PING_MS / MIN} min` : 'nein'
  const zeilen = [
    `Cache     ${zustand}`,
    `Anzeige   ${anz}${wo}`,
    `Warnung   ${z.warnung ? `an – hält Nachrichten in einen kalten Cache ab ${fmtTok(WARN_AB)} Tokens einmal an` : 'aus'}`,
    `Telegram  ${tele}`,
    `Auto      ${auto}`,
    `Warm      ${warm}`,
  ]
  // Ohne Abo-Limits ist es vermutlich ein API-Schlüssel: dort gilt die Stunde nur mit promptCacheTtl.
  if (z.abo === false) zeilen.push('', 'Hinweis: kein Abo erkannt. Ohne Abo hält der Cache 5 min, außer promptCacheTtl steht auf "1h".')
  zeilen.push('', '/cache anzeige aus|knapp|immer|unten|oben · warnung an|aus|test · telegram an|aus|test · auto an|aus · warm <h>|aus')
  return zeilen.join('\n')
}

export const register: Register = on => {
  const z = neuerZustand()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    z.projekt = e.cwd.replace(/\/+$/, '').split('/').pop() ?? ''
    const a = await $.store.get('anzeige')
    z.anzeige = a === 'aus' || a === 'immer' ? a : 'knapp'
    z.ort = (await $.store.get('ort')) === 'oben' ? 'oben' : 'unten'
    z.warnung = (await $.store.get('warnung')) !== false
    z.telegram = (await $.store.get('telegram')) !== false
    z.auto = (await $.store.get('auto')) !== false
    // Ein Neuladen der Mod beginnt mit leerem Zustand: die Uhr liegt im Store,
    // den Kontext kennt die Engine (außer nach /compact, da zählt die letzte
    // Antwort noch den alten Verlauf).
    await laden($, z, now)
    const live = (await $.session.usage()).context.tokens
    if (live && live > 0 && !z.lage.kompaktiert) z.lage.ctx = live
    await aufraeumen($, now)
    await $.command.register({
      name: 'cache',
      description: 'Prompt-Cache: Zustand, Anzeige, Warnung und Telegram-Frage (cache-waechter)',
      argumentHint: '[anzeige aus|knapp|immer|unten|oben | warnung an|aus|test | telegram an|aus|test | auto an|aus | warm <h>|aus]',
      immediate: true,
    })
    // Ein Takt für alles Telegram: er stellt die Frage, wenn sie fällig ist, und
    // holt Antworten ab, solange sie offen ist. Er läuft ab Sitzungsstart; einer,
    // den ein Befehl startet, überlebt dessen Ende nicht verlässlich, und ein
    // einmaliger Wecker ginge beim Neuladen der Mod verloren.
    $.clock.every(POLL_MS, () => void takt($, z))
    $.clock.every(TICK_MS, () => {
      if (z.anzeige !== 'aus' || z.angehalten) neuZeichnen($)
    })
    return r
  })

  // /clear: die Unterhaltung endet, der Prozess läuft unter neuer Kennung weiter.
  on('session.end', async ($, e, next) => {
    await schliesseFrage($, z,
      e.reason === 'clear' ? '🧹 Sitzung mit /clear geleert.'
        : e.reason === 'resume' ? '↪ Eine andere Sitzung wurde geöffnet.'
        : '👋 Sitzung beendet.')
    if (e.reason === 'clear' || e.reason === 'resume') vergiss(z)
    neuZeichnen($)
    return next(e)
  })

  // Fortgesetzte Sitzungen bringen ihr Alter mit, bevor der erste Zug läuft.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    if (e.source === 'clear') {
      await schliesseFrage($, z, '🧹 Sitzung mit /clear geleert.')
      vergiss(z)
    } else if (e.source === 'resume' || e.source === 'fork') {
      vergiss(z)
      await laden($, z, now)
      if (typeof e.context_tokens === 'number') z.lage.ctx = e.context_tokens
      if (typeof e.seconds_since_last_response === 'number') z.lage.letzteAnfrage = now - e.seconds_since_last_response * 1000
      z.lage.kompaktiert = false
    }
    neuZeichnen($)
    return r
  })

  // Die Engine misst nach jeder Antwort: so stimmt der Kontext auch zwischen den Zügen.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    const t = e.context.tokens
    if (e.changed.includes('context') && t && t > 0 && !z.lage.kompaktiert) z.lage.ctx = t
    if (e.changed.includes('rateLimits') || z.abo === null) z.abo = e.rateLimits.length > 0
    return r
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const [wort = '', roh = ''] = String(e.args ?? '').trim().toLowerCase().split(/\s+/)
    // Vertipper wie „anzeigen“ oder „einblenden“ meinen dasselbe wie „anzeige“.
    const was = wort === 'anzeigen' || wort === 'einblenden' ? 'anzeige' : wort
    // „anzeige an“ meint „immer“, „ein“ meint „an“.
    const wert = was === 'anzeige' && (roh === 'an' || roh === 'ein') ? 'immer' : roh === 'ein' ? 'an' : roh
    const now = await $.clock.now()
    if (was === 'anzeige') {
      if (wert === 'unten' || wert === 'oben') {
        z.ort = wert
        await $.store.set('ort', wert)
        neuZeichnen($)
        return { text: wert === 'unten' ? 'Anzeige: unten rechts in der Fußzeile' : 'Anzeige: als Zeile über der Eingabe' }
      }
      if (wert !== 'aus' && wert !== 'knapp' && wert !== 'immer') return { text: 'Anzeige: aus, knapp, immer, unten oder oben?' }
      z.anzeige = wert
      await $.store.set('anzeige', wert)
      neuZeichnen($)
      return { text: `Anzeige: ${wert}` }
    }
    if (was === 'warnung') {
      if (wert === 'test') {
        z.warnTest = true
        return { text: 'Die nächste Nachricht wird zur Probe einmal angehalten.' }
      }
      if (wert !== 'an' && wert !== 'aus') return { text: 'Warnung: an, aus oder test?' }
      z.warnung = wert === 'an'
      await $.store.set('warnung', z.warnung)
      return { text: `Warnung: ${wert}` }
    }
    if (was === 'telegram') {
      if (wert === 'test') return { text: await stelleFrage($, z, true) }
      if (wert !== 'an' && wert !== 'aus') return { text: 'Telegram: an, aus oder test?' }
      z.telegram = wert === 'an'
      await $.store.set('telegram', z.telegram)
      if (!z.telegram) await schliesseFrage($, z, 'Telegram-Fragen wurden ausgeschaltet.')
      return { text: `Telegram: ${wert}` }
    }
    if (was === 'auto') {
      if (wert !== 'an' && wert !== 'aus') return { text: 'Automatisch komprimieren: an oder aus?' }
      z.auto = wert === 'an'
      await $.store.set('auto', z.auto)
      return { text: z.auto ? `Ab ${fmtTok(AUTO_KOMPAKT_AB)} Tokens wird ohne Antwort 3 min vor dem Abkühlen komprimiert.` : 'Es wird nie von selbst komprimiert.' }
    }
    if (was === 'warm') {
      const h = wert === 'aus' ? 0 : Number(wert.replace(',', '.').replace(/h$/, ''))
      if (!Number.isFinite(h) || h < 0 || h > 24 || (wert !== 'aus' && !wert)) return { text: 'Warmhalten: Stunden (z. B. 3, höchstens 24) oder aus?' }
      z.warmBis = h ? now + h * 60 * MIN : 0
      await speichern($, z)
      if (!h) return { text: 'Kein Warmhalten mehr: ab jetzt gilt wieder Frage bzw. Komprimieren.' }
      return { text: `Der Cache wird ${fmtDauer(h * 60 * MIN)} lang warmgehalten: alle ${WARM_PING_MS / MIN} min ein kurzer Ping, solange niemand schreibt.` }
    }
    await zugangLesen($, z)
    const unbekannt = was && was !== 'hilfe' && was !== 'help' && was !== 'status' ? `„${String(e.args).trim()}“ kenne ich nicht.\n\n` : ''
    return { text: unbekannt + karte(z, now) }
  })

  // turn.start kommt nur für den Hauptverlauf; Subagenten haben ihren eigenen Cache.
  on('turn.start', async ($, e, next) => {
    z.laeuft = true
    z.angehalten = null
    await schliesseFrage($, z, '💬 Du hast in der Sitzung weitergeschrieben.')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) z.lage.letzteAnfrage = await $.clock.now()
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    z.laeuft = false
    z.quittiert = 0
    // turn.step stempelt die genaue Anfragezeit; fehlt der Stempel, gilt das
    // Zugende. Ein abgebrochener Zug ohne Schritt hat nichts angefragt.
    const ohneStempel = now - z.lage.letzteAnfrage > e.durationMs
    const angefragt = !ohneStempel || e.reason !== 'aborted'
    if (angefragt) {
      if (ohneStempel) z.lage.letzteAnfrage = now
      z.lage.kompaktiert = false
    }
    const live = (await $.session.usage()).context.tokens
    const u = e.usage
    if (!z.lage.kompaktiert) {
      if (live && live > 0) z.lage.ctx = live
      else if (u) z.lage.ctx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    }
    await speichern($, z)
    neuZeichnen($)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || r.skip !== undefined) return r
    await merkeKompakt($, z, r.tokensAfter)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    // Wer nach der Warnung etwas schickt, hat sie gelesen: die Karte geht.
    if (z.angehalten) {
      z.angehalten = null
      neuZeichnen($)
    }
    // Die Probe gilt auch bei ausgeschalteter Warnung: man will ja sehen, wie sie aussähe.
    if (z.warnTest) {
      z.warnTest = false
      z.angehalten = { kaltSeit: 72 * MIN, ctx: Math.max(z.lage.ctx, 310_000), probe: true, at: now }
      haltAn($, e.text)
      neuZeichnen($)
      return { drop: '❄ Probe: angehalten. Der Text liegt wieder im Feld, Enter schickt ihn.' }
    }
    if (!z.warnung || !istKalt(z.lage, now) || z.lage.ctx < WARN_AB) return next(e)
    if (z.quittiert === z.lage.letzteAnfrage) {
      z.quittiert = 0
      return next(e)
    }
    const kalt = `Cache seit ${fmtDauer(now - z.lage.letzteAnfrage - TTL_MS)} kalt, die Nachricht liest ${fmtTok(z.lage.ctx)} Tokens neu ein.`
    // Ein Anhang ließe sich nicht zurück ins Feld legen: dann nur warnen.
    if (e.attachments?.length) {
      $.ui.log(`❄ ${kalt} Mit Anhang geht sie trotzdem raus.`)
      return next(e)
    }
    z.quittiert = z.lage.letzteAnfrage
    z.angehalten = { kaltSeit: now - z.lage.letzteAnfrage - TTL_MS, ctx: z.lage.ctx, probe: false, at: now }
    haltAn($, e.text)
    neuZeichnen($)
    return { drop: `❄ Angehalten: ${kalt} Der Text liegt wieder im Feld, Enter schickt ihn.` }
  })

  // Unten rechts reiht sich die Angabe zu den Modi der Fußzeile („focus & …“):
  // dieselbe Stelle, dieselbe Schrift, nichts Eigenes, das zappelt.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (z.ort !== 'unten') return next(e)
    const text = modusText(z.lage, await $.clock.now(), z.anzeige)
    if (!text) return next(e)
    // Selbst gezeichnet statt die Liste umgeschrieben: die Desktop-App fragte
    // die Fußzeile an, zeigte eine umgeschriebene Liste aber nicht (09.10.).
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{[...e.props.modes, text].join(' & ')}</Text>
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey || e.props.isWorking) return rest
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    // Die Karte nach dem Anhalten: gerahmt, bis die nächste Nachricht kommt (höchstens 10 min).
    const ah = z.angehalten
    if (ah && now - ah.at < 10 * MIN) {
      return (
        <Box flexDirection="column">
          {rest}
          <Box key="karte" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text bold color="warning">{ah.probe ? '❄  Probe: so sieht die Warnung aus' : `❄  Angehalten: der Cache ist seit ${fmtDauer(ah.kaltSeit)} kalt`}</Text>
            <Text>{`Diese Nachricht liest ${fmtTok(ah.ctx)} Tokens neu ein, statt sie aus dem Cache zu holen.`}</Text>
            <Text dimColor>Enter schickt sie trotzdem  ·  günstiger: /clear und in zwei Sätzen sagen, worum es ging</Text>
          </Box>
        </Box>
      )
    }
    if (z.ort !== 'oben' || !bandText(z.lage, now, z.anzeige)) return rest
    if (z.lage.kompaktiert) {
      return (
        <Box flexDirection="column">
          {rest}
          <Box key="cache" flexDirection="row" gap={1}>
            <Text dimColor>Cache</Text>
            <Text color="success">🗜 komprimiert</Text>
            <Text dimColor>{`· ${fmtTok(z.lage.ctx)} Tokens, baut sich mit der nächsten Nachricht neu auf`}</Text>
          </Box>
        </Box>
      )
    }
    if (istKalt(z.lage, now)) {
      return (
        <Box flexDirection="column">
          {rest}
          <Box key="cache" flexDirection="row" gap={1}>
            <Text color="suggestion">{`❄ Cache kalt seit ${fmtDauer(now - z.lage.letzteAnfrage - TTL_MS)}`}</Text>
            <Text dimColor>{`· die nächste Nachricht liest ${fmtTok(z.lage.ctx)} Tokens neu ein`}</Text>
          </Box>
        </Box>
      )
    }
    const bleibt = z.lage.letzteAnfrage + TTL_MS - now
    return (
      <Box flexDirection="column">
        {rest}
        <Box key="cache" flexDirection="row" gap={1}>
          <Text dimColor>Cache</Text>
          <Text color={farbe(bleibt)}>{balken(bleibt)}</Text>
          <Text bold color={farbe(bleibt)}>{fmtDauer(bleibt)}</Text>
          <Text dimColor>{`· ${fmtTok(z.lage.ctx)} Tokens`}</Text>
        </Box>
      </Box>
    )
  })
}
