import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, HttpResponse, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { bandText, fmtDauer, fmtTok, leseZugang } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const START = 10_000_000

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/Users/j/Code/Tal' }
let zuege = 0
const zug = (): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++zuege, reason: 'answer' })
const eingabe = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const befehl = (args: string): CommandRunInput => ({ command: 'cache', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 75, scroll: { offset: 0, bodyRows: 10 }, view: {} }

type Aufruf = { methode: string; body: Record<string, unknown> }

// Die Welt unter der Mod: Kontextgröße, Telegram-Server und Modell nach Drehbuch.
type Opts = { ctx: number; updates?: unknown[][]; store?: Record<string, unknown>; fillOk?: boolean; netzWeg?: () => boolean }

function welt(on: On, opts: Opts = { ctx: 300_000 }) {
  mock.store(on, opts.store ?? {})
  const sitzung = { id: 'S1' }
  on('session.id', () => ({ value: sitzung.id }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  mock.env(on, { HOME: '/Users/j' })
  const tg: Aufruf[] = []
  const fills: string[] = []
  const logs: string[] = []
  const forks: number[] = []
  const compacts: number[] = []
  const entered: string[] = []
  const updates = opts.updates ?? []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1_000_000, tokens: opts.ctx }, rateLimits: [] } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('prompt.fill', ($, e) => { fills.push(e.text); return { isFilled: opts.fillOk ?? true } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  const modi: string[][] = []
  on('ui.render', ($, e) => {
    if (e.component === 'SessionMode') modi.push([...(e.props as { modes: readonly string[] }).modes])
    return $.ui.resolve(e).Text({ children: [''] })
  })
  on('fs.read', () => ({ value: 'TELEGRAM_BOT_TOKEN=123:geheim\nTELEGRAM_CHAT_ID=42\n' }))
  on('http.fetch', ($, e) => {
    // So zitiert ein echter Netzfehler die URL, samt Token.
    if (opts.netzWeg?.()) throw new Error(`connect ETIMEDOUT ${e.url}`)
    const methode = e.url.split('/').pop() ?? ''
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    tg.push({ methode, body })
    const result = methode === 'sendMessage' ? { message_id: 7 } : methode === 'getUpdates' ? (updates.shift() ?? []) : true
    const value: HttpResponse = { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, result }) }
    return { value }
  })
  on('model.fork', () => {
    forks.push(1)
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 40 } }
    return { value }
  })
  on('session.compact', () => {
    compacts.push(1)
    return { messages: [{ role: 'user', text: 'Zusammenfassung', toolUses: [] }], tokensBefore: 300_000, tokensAfter: 20_000 } })
  return { tg, fills, logs, forks, compacts, entered, sitzung, modi }
}

let knoepfe = 100
const knopf = (aktion: string, kennung: string) => {
  const n = ++knoepfe
  return [{ update_id: n, callback_query: { id: 'cq' + n, data: `cw:${kennung}:${aktion}`, message: { message_id: 9, chat: { id: 42 } } } }]
}

describe('Hilfen', () => {
  test('Zugangsdaten und Dauer', async () => {
    expect(leseZugang('export TELEGRAM_BOT_TOKEN="1:a"\nTELEGRAM_CHAT_ID=5')).toEqual({ token: '1:a', chat: '5' })
    expect(leseZugang('TELEGRAM_CHAT_ID=5')).toBe(null)
    expect(fmtDauer(75 * MIN)).toBe('1 h 15 min')
    expect(fmtDauer(20 * 1000)).toBe('unter 1 min')
    // Abgerundet: 59,6 min sind „59 min“, nicht schon „1 h 00 min“.
    expect(fmtDauer(59.6 * MIN)).toBe('59 min')
    expect(fmtTok(999_700)).toBe('1,0 Mio.')
  })

  test('knapp schweigt, bis es eng wird', async () => {
    const lage = { letzteAnfrage: START, ctx: 300_000, kompaktiert: false }
    expect(bandText(lage, START + 30 * MIN, 'knapp')).toBe(null)
    expect(bandText(lage, START + 36 * MIN, 'knapp')).toContain('noch 24 min')
    expect(bandText(lage, START + 55 * MIN, 'knapp')).toContain('noch 5 min')
    expect(bandText(lage, START + 70 * MIN, 'knapp')).toContain('kalt seit 10 min')
    expect(bandText(lage, START + 30 * MIN, 'immer')).toContain('noch 30 min')
    expect(bandText(lage, START + 70 * MIN, 'aus')).toBe(null)
    expect(bandText({ ...lage, ctx: 20_000 }, START + 70 * MIN, 'knapp')).toBe(null)
    expect(bandText({ ...lage, kompaktiert: true, ctx: 20_000 }, START + 5 * MIN, 'immer')).toContain('komprimiert auf 20k')
    expect(bandText({ ...lage, kompaktiert: true }, START + 55 * MIN, 'knapp')).toBe(null)
  })
})

describe('Warnung', () => {
  test('kalte große Sitzung: erste Eingabe zurück ins Feld, zweite geht durch', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { ctx: 300_000 })
    await $.session.start(session)
    await $.command.run(befehl('telegram aus'))
    await $.turn.complete(zug())
    await uhr.advance(70 * MIN)
    const erst = await $.prompt.submit(eingabe('fass zusammen'))
    expect(erst.drop).toContain('300k Tokens')
    await uhr.advance(1000)
    expect(w.fills).toEqual(['fass zusammen'])
    const zweit = await $.prompt.submit(eingabe('fass zusammen'))
    expect(zweit.drop).toBe(undefined)
    expect(w.entered).toEqual(['fass zusammen'])
  })

  test('kleiner Kontext, warmer Cache und Befehle gehen ohne Warnung durch', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    welt(on, { ctx: 140_000 })
    await $.session.start(session)
    await $.turn.complete(zug())
    await uhr.advance(70 * MIN)
    // Erst ab 150k wird angehalten.
    expect((await $.prompt.submit(eingabe('hallo'))).drop).toBe(undefined)
  })

  test('Befehle werden nie aufgehalten', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    welt(on, { ctx: 300_000 })
    await $.session.start(session)
    await $.turn.complete(zug())
    await uhr.advance(70 * MIN)
    expect((await $.prompt.submit(eingabe('/clear'))).drop).toBe(undefined)
  })
})

describe('Desktop-App', () => {
  test('ohne füllbares Feld steht der Text im Verlauf', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { ctx: 300_000, fillOk: false })
    await $.session.start(session)
    await $.command.run(befehl('warnung test'))
    expect((await $.prompt.submit(eingabe('mein langer Text'))).drop).toContain('Probe')
    await uhr.advance(1000)
    expect(w.logs.some(l => l.includes('mein langer Text'))).toBe(true)
    expect((await $.prompt.submit(eingabe('mein langer Text'))).drop).toBe(undefined)
  })

  test('nach dem Neuladen gelten Kontext und Uhr weiter', async ($, on) => {
    const uhr = mock.clock(on, { now: START + 70 * MIN })
    welt(on, { ctx: 300_000, store: { 'sitzung:S1': { zeit: START, kompakt: false, gefragt: 0, frage: null, at: START } } })
    await $.session.start(session)
    await uhr.advance(0)
    expect((await $.prompt.submit(eingabe('hallo'))).drop).toContain('300k')
  })
})

describe('Anzeige', () => {
  test('die Zeile erscheint erst in den letzten 25 Minuten', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    welt(on, { ctx: 300_000 })
    await $.session.start(session)
    await $.command.run(befehl('telegram aus'))
    await $.command.run(befehl('anzeige oben'))
    await $.turn.complete(zug())
    const ui = await $.ui.mount({ plugin: 'cache-waechter', surface: 'terminal', component: 'AbovePrompt', props: band })
    await uhr.advance(30 * MIN)
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await uhr.advance(25 * MIN)
    expect((await ui.find({ type: 'Text', text: /▰/ }))?.text).toBe('▰▱▱▱▱▱▱▱▱▱')
    expect(await ui.find({ type: 'Text', text: '5 min' })).toBeDefined()
    await ui.unmount()
    for (const surface of ['desktop'] as const) {
      const d = await $.ui.mount({ plugin: 'cache-waechter', surface, component: 'AbovePrompt', props: band })
      expect(await d.find({ type: 'Text', text: '5 min' })).toBeDefined()
      await d.unmount()
    }
    await uhr.advance(10 * MIN)
    const k = await $.ui.mount({ plugin: 'cache-waechter', surface: 'desktop', component: 'AbovePrompt', props: band })
    expect((await k.find({ type: 'Text', text: /kalt seit/ }))?.text).toContain('kalt seit 5 min')
    await k.unmount()
  })

  test('standardmäßig steht die Angabe unten rechts bei den Modi', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { ctx: 300_000 })
    await $.session.start(session)
    await $.command.run(befehl('telegram aus'))
    await $.command.run(befehl('anzeige immer'))
    await $.turn.complete(zug())
    await uhr.advance(18 * MIN)
    for (const surface of ['terminal', 'desktop'] as const) {
      const fuss = await $.ui.mount({ plugin: 'cache-waechter', surface, component: 'SessionMode', props: { modes: ['focus'] } })
      expect(await fuss.find({ type: 'Text', text: 'focus & Cache ▰▰▰▰▱ 42 min' })).toBeDefined()
      await fuss.unmount()
      // Oben bleibt dann frei.
      const oben = await $.ui.mount({ plugin: 'cache-waechter', surface, component: 'AbovePrompt', props: band })
      expect(await oben.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
      await oben.unmount()
    }
    await uhr.advance(50 * MIN)
    const kalt = await $.ui.mount({ plugin: 'cache-waechter', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    expect(await kalt.find({ type: 'Text', text: '❄ Cache kalt · 300k' })).toBeDefined()
    await kalt.unmount()
    // „knapp“ schweigt unten genauso, solange es nichts zu sagen gibt.
    await $.command.run(befehl('anzeige knapp'))
    await $.turn.complete(zug())
    await $.ui.mount({ plugin: 'cache-waechter', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    expect(w.modi.at(-1)).toEqual([])
  })

  test('die Warnkarte steht gerahmt über der Eingabe, bis die nächste Nachricht kommt', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    welt(on, { ctx: 300_000 })
    await $.session.start(session)
    await $.command.run(befehl('telegram aus'))
    await $.turn.complete(zug())
    await uhr.advance(70 * MIN)
    await $.prompt.submit(eingabe('hallo'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'cache-waechter', surface, component: 'AbovePrompt', props: band })
      expect((await ui.find({ type: 'Text', text: /Angehalten/ }))?.text).toContain('seit 10 min kalt')
      expect(await ui.find({ type: 'Text', text: /300k Tokens neu/ })).toBeDefined()
      await ui.unmount()
    }
    await $.prompt.submit(eingabe('hallo'))
    const ui = await $.ui.mount({ plugin: 'cache-waechter', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /Angehalten/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('Telegram', () => {
  async function bisZurFrage($: Engine, on: On, updates: unknown[][] = [], ctx = 300_000) {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { ctx, updates })
    await $.session.start(session)
    await $.turn.complete(zug())
    await uhr.advance(50 * MIN + 1000)
    const send = w.tg.find(a => a.methode === 'sendMessage')
    const kb = (send?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] } | undefined)?.inline_keyboard[0] ?? []
    const kennung = kb[0]?.callback_data.split(':')[1] ?? ''
    return { uhr, w, send, kb, kennung }
  }

  test('nach 50 min kommt eine Frage mit drei Knöpfen', async ($, on) => {
    const { send, kb } = await bisZurFrage($, on)
    expect(send?.body.chat_id).toBe('42')
    expect(String(send?.body.text)).toContain('Tal')
    expect(kb.map(k => k.callback_data.split(':')[2])).toEqual(['kompakt', 'warm', 'nichts'])
  })

  test('Warmhalten pingt und fragt 50 min später wieder', async ($, on) => {
    const updates: unknown[][] = []
    const { uhr, w, kennung } = await bisZurFrage($, on, updates)
    updates.push(knopf('warm', kennung))
    await uhr.advance(5000)
    expect(w.forks.length).toBe(1)
    const edit = w.tg.find(a => a.methode === 'editMessageText')
    expect(String(edit?.body.text)).toContain('Warmgehalten')
    await uhr.advance(50 * MIN)
    expect(w.tg.filter(a => a.methode === 'sendMessage').length).toBe(2)
  })

  test('Komprimieren komprimiert', async ($, on) => {
    const updates: unknown[][] = []
    const { uhr, w, kennung } = await bisZurFrage($, on, updates)
    updates.push(knopf('kompakt', kennung))
    await uhr.advance(5000)
    expect(w.compacts.length).toBe(1)
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toContain('300k → 20k')
    // Bei „immer“ bleibt die Zeile nach dem Komprimieren stehen und sagt, was los ist.
    await $.command.run(befehl('anzeige immer'))
    const fuss = await $.ui.mount({ plugin: 'cache-waechter', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    expect(await fuss.find({ type: 'Text', text: 'Cache 🗜 komprimiert' })).toBeDefined()
    await fuss.unmount()
  })

  test('ab 400k wird ohne Antwort kurz vor dem Abkühlen komprimiert', async ($, on) => {
    const { uhr, w, send } = await bisZurFrage($, on, [], 450_000)
    expect(String(send?.body.text)).toContain('Ohne Antwort komprimiere ich in 7 min')
    const zweite = (send?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[1] ?? []
    expect(zweite.map(k => k.callback_data.split(':')[2])).toEqual(['warm3', 'warm8'])
    await uhr.advance(5 * MIN)
    expect(w.compacts.length).toBe(0)
    await uhr.advance(2 * MIN)
    expect(w.compacts.length).toBe(1)
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toContain('Keine Antwort, daher von selbst')
    await uhr.advance(10 * MIN)
    expect(w.compacts.length).toBe(1)
  })

  test('unter 400k wird nie von selbst komprimiert', async ($, on) => {
    const { uhr, w } = await bisZurFrage($, on, [], 350_000)
    await uhr.advance(15 * MIN)
    expect(w.compacts.length).toBe(0)
  })

  test('„Nichts“ verbietet auch das Komprimieren von selbst', async ($, on) => {
    const updates: unknown[][] = []
    const { uhr, w, kennung } = await bisZurFrage($, on, updates, 450_000)
    updates.push(knopf('nichts', kennung))
    await uhr.advance(15 * MIN)
    expect(w.compacts.length).toBe(0)
  })

  test('/cache auto aus schaltet es ab', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { ctx: 450_000 })
    await $.session.start(session)
    await $.command.run(befehl('auto aus'))
    await $.turn.complete(zug())
    await uhr.advance(65 * MIN)
    expect(w.compacts.length).toBe(0)
  })

  test('3 h warm: pingt alle 55 min ohne zu fragen, danach kommt wieder die Frage', async ($, on) => {
    const updates: unknown[][] = []
    const { uhr, w, kennung } = await bisZurFrage($, on, updates, 450_000)
    updates.push(knopf('warm3', kennung))
    await uhr.advance(5000)
    expect(w.forks.length).toBe(1)
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toMatch(/noch (2 h 59|3 h 00) min warm/)
    // Pings bei +55, +110 und +165 min liegen in den 3 h; komprimiert oder gefragt wird nicht.
    await uhr.advance(3 * 55 * MIN + 10_000)
    expect(w.forks.length).toBe(4)
    expect(w.compacts.length).toBe(0)
    expect(w.tg.filter(a => a.methode === 'sendMessage').length).toBe(1)
    // Der nächste Ping läge nach den 3 h: also wieder die Frage nach 50 min.
    await uhr.advance(50 * MIN)
    expect(w.tg.filter(a => a.methode === 'sendMessage').length).toBe(2)
    expect(w.forks.length).toBe(4)
  })

  test('/cache warm hält auch ohne Telegram warm', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { ctx: 450_000 })
    await $.session.start(session)
    await $.command.run(befehl('telegram aus'))
    await $.turn.complete(zug())
    expect((await $.command.run(befehl('warm 2'))).text).toContain('2 h 00 min')
    await uhr.advance(56 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.compacts.length).toBe(0)
  })

  test('eine offene Frage übersteht das Neuladen der Mod', async ($, on) => {
    const updates: unknown[][] = [knopf('nichts', 'abcd1234')]
    const uhr = mock.clock(on, { now: START })
    const frage = { kennung: 'abcd1234', messageId: 7, bis: START + 10 * MIN, text: 'Frage' }
    const w = welt(on, { ctx: 300_000, updates, store: { 'sitzung:S1': { zeit: START - 50 * MIN, kompakt: false, gefragt: START - 50 * MIN, frage, at: START } } })
    await $.session.start(session)
    await uhr.advance(5000)
    expect(w.tg.some(a => a.methode === 'answerCallbackQuery')).toBe(true)
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toContain('abkühlen')
  })

  test('wer weiterschreibt, schließt die Frage', async ($, on) => {
    const { w } = await bisZurFrage($, on)
    await $.turn.start({ text: 'weiter', turnId: 'x' })
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toContain('weitergeschrieben')
  })

  test('ohne Antwort endet die Frage, wenn der Cache kalt ist', async ($, on) => {
    const { uhr, w } = await bisZurFrage($, on)
    await uhr.advance(11 * MIN)
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toContain('Abgekühlt')
    expect(w.forks.length + w.compacts.length).toBe(0)
  })

  test('kleine Sitzungen bekommen keine Frage', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    // Unter 200k fragt Telegram nicht.
    const w = welt(on, { ctx: 190_000 })
    await $.session.start(session)
    await $.turn.complete(zug())
    await uhr.advance(55 * MIN)
    expect(w.tg.length).toBe(0)
  })

  test('„Nichts“ heißt nichts: keine zweite Frage zur selben Anfrage', async ($, on) => {
    const updates: unknown[][] = []
    const { uhr, w, kennung } = await bisZurFrage($, on, updates)
    updates.push(knopf('nichts', kennung))
    await uhr.advance(5000)
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toContain('abkühlen')
    await uhr.advance(8 * MIN)
    expect(w.tg.filter(a => a.methode === 'sendMessage').length).toBe(1)
  })

  test('nach dem Neuladen kommt die Frage trotzdem pünktlich', async ($, on) => {
    const uhr = mock.clock(on, { now: START + 30 * MIN })
    const w = welt(on, { ctx: 300_000, store: { 'sitzung:S1': { zeit: START, kompakt: false, gefragt: 0, frage: null, at: START } } })
    await $.session.start(session)
    await uhr.advance(19 * MIN)
    expect(w.tg.some(a => a.methode === 'sendMessage')).toBe(false)
    await uhr.advance(1 * MIN + 5000)
    expect(String(w.tg.find(a => a.methode === 'sendMessage')?.body.text)).toMatch(/kühlt in (9|10) min ab/)
  })

  test('ein Knopf unter einer erledigten Frage dreht nicht ewig', async ($, on) => {
    const updates: unknown[][] = []
    const { uhr, w, kennung } = await bisZurFrage($, on, updates)
    // Erst ein Knopf einer längst beendeten Sitzung, dann der echte.
    updates.push([...knopf('warm', 'alt00000'), ...knopf('nichts', kennung)])
    await uhr.advance(5000)
    const antworten = w.tg.filter(a => a.methode === 'answerCallbackQuery').map(a => String(a.body.text))
    expect(antworten).toEqual(['Diese Frage ist schon erledigt.', 'Okay'])
    expect(w.tg.some(a => a.methode === 'editMessageReplyMarkup')).toBe(true)
    expect(w.forks.length).toBe(0)
  })

  test('Antworten für telegram-draht bleiben eine Minute liegen', async ($, on) => {
    const updates: unknown[][] = []
    const { uhr, w, kennung } = await bisZurFrage($, on, updates)
    const text = { update_id: 50, message: { message_id: 3, chat: { id: 42 }, text: 'Grün bitte' } }
    const draht = { update_id: 51, callback_query: { id: 'cqd', data: 'td:ab12:0:1', message: { message_id: 4, chat: { id: 42 } } } }
    const offsets = () => w.tg.filter(a => a.methode === 'getUpdates').map(a => a.body.offset)
    updates.push([text, draht], [text, draht])
    await uhr.advance(4000)
    await uhr.advance(4000)
    // Der Offset bleibt vor dem Text stehen, und nichts davon wird beantwortet.
    expect(offsets().at(-1)).not.toBe(52)
    expect(w.tg.some(a => a.methode === 'answerCallbackQuery')).toBe(false)
    // Nach einer Minute holt sie offenbar niemand mehr: dann quittiert.
    for (let i = 0; i < 16; i++) updates.push([text, draht])
    await uhr.advance(MIN)
    expect(offsets().at(-1)).toBe(52)
    // Der eigene Knopf wirkt die ganze Zeit.
    updates.length = 0
    updates.push(knopf('nichts', kennung))
    await uhr.advance(4000)
    expect(w.tg.filter(a => a.methode === 'answerCallbackQuery').map(a => String(a.body.text))).toEqual(['Okay'])
  })

  test('/clear schließt die Frage und vergisst die alte Unterhaltung', async ($, on) => {
    const { w } = await bisZurFrage($, on)
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    expect(String(w.tg.find(a => a.methode === 'editMessageText')?.body.text)).toContain('/clear')
    w.sitzung.id = 'S2'
    await $.command.run(befehl('anzeige immer'))
    await $.command.run(befehl('anzeige oben'))
    const ui = await $.ui.mount({ plugin: 'cache-waechter', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
    // Die neue Unterhaltung beginnt mit voller Stunde.
    await $.turn.complete(zug())
    const neu = await $.ui.mount({ plugin: 'cache-waechter', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect((await neu.find({ type: 'Text', text: /▰/ }))?.text).toBe('▰▰▰▰▰▰▰▰▰▰')
    await neu.unmount()
  })

  test('ohne Netz: Fehler ohne Token, neuer Versuch erst nach einer Minute', async ($, on) => {
    let weg = true
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { ctx: 300_000, netzWeg: () => weg })
    await $.session.start(session)
    const test = await $.command.run(befehl('telegram test'))
    expect(test.text).toContain('nicht erreichbar')
    expect(test.text).not.toContain('geheim')
    await $.turn.complete(zug())
    await uhr.advance(50 * MIN + 30 * 1000)
    weg = false
    expect(w.tg.length).toBe(0)
    await uhr.advance(MIN)
    expect(w.tg.filter(a => a.methode === 'sendMessage').length).toBe(1)
  })
})
