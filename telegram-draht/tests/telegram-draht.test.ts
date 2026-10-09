import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, HttpResponse, On, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { alsHtml, auszug, einordnen, istWeg, kuerze, leseLeerlauf, leseZugang, zielSitzung } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const START = 10_000_000

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/Users/j/Code/Tal' }
let zuege = 0
const zug = (durationMs: number, answer = 'Alles erledigt.'): TurnCompleteInput => ({ answer, durationMs, isAborted: false, turnId: 't' + ++zuege, reason: 'answer' })
const befehl = (args: string): CommandRunInput => ({ command: 'telegram', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const frage = {
  question: 'Welche Farbe soll der Knopf haben?',
  header: 'Farbe',
  multiSelect: false,
  options: [{ label: 'Blau', description: 'ruhig' }, { label: 'Rot', description: 'laut' }],
}

type Aufruf = { methode: string; body: Record<string, unknown> }

// Im Test-Kit gibt es kein $.process: der Leerlauf ist dort nie messbar (es gilt die 10-min-Regel).
function welt(on: On, opts: { updates?: unknown[][]; dialog?: Promise<unknown>; env?: string } = {}) {
  mock.store(on, {})
  on('session.id', () => ({ value: 'S1' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  mock.env(on, { HOME: '/Users/j' })
  const tg: Aufruf[] = []
  const prompts: { text: string; asUser?: boolean }[] = []
  const updates = opts.updates ?? []
  let naechsteId = 500
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    prompts.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const dateien: Record<string, string> = { '/Users/j/.claude/telegram.env': opts.env ?? 'TELEGRAM_BOT_TOKEN=123:geheim\nTELEGRAM_CHAT_ID=42\n' }
  on('fs.read', ($, e) => {
    const inhalt = dateien[e.path]
    if (inhalt === undefined) throw new Error('ENOENT')
    return { value: inhalt }
  })
  on('fs.write', ($, e) => { dateien[e.path] = e.text; return { value: undefined } })
  on('http.fetch', ($, e) => {
    const methode = e.url.split('/').pop() ?? ''
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    tg.push({ methode, body })
    const result = methode === 'sendMessage' ? { message_id: ++naechsteId }
      : methode === 'getUpdates' ? (updates.shift() ?? [])
      : methode === 'getMe' ? { username: 'mein_bot' }
      : true
    const value: HttpResponse = { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, result }) }
    return { value }
  })
  const rc: unknown[] = []
  // Der Dialog am Rechner: bleibt offen, bis der Test ihn beantwortet.
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') return (opts.dialog ?? new Promise(() => {})) as never
    if (String(e.tool) === 'mcp__ccd_session_mgmt__set_remote_control') {
      rc.push(e)
      return { result: 'on', text: 'Remote Control: on' } as never
    }
    return { result: { stdout: '', stderr: '' } } as never
  })
  return { tg, prompts, updates, rc, dateien, sent: () => tg.filter(a => a.methode === 'sendMessage') }
}

let uid = 1000
const knopf = (data: string, messageId = 501) =>
  [{ update_id: ++uid, callback_query: { id: 'cq' + uid, data, message: { message_id: messageId, chat: { id: 42 } } } }]
const text = (t: string, antwortAuf?: number) =>
  [{ update_id: ++uid, message: { message_id: 900 + uid, date: START / 1000, chat: { id: 42 }, text: t, ...(antwortAuf ? { reply_to_message: { message_id: antwortAuf } } : {}) } }]

describe('Hilfen', () => {
  test('Zuordnung von Updates', async () => {
    expect(leseZugang('TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=5')).toEqual({ token: '1:a', chat: '5' })
    expect(einordnen(knopf('td:ab12:0:1')[0]!, '42')).toMatchObject({ art: 'knopf', rid: 'ab12', teil: 0, wahl: '1' })
    expect(einordnen(knopf('cw:ab12:warm')[0]!, '42')).toEqual({ art: 'fremd' })
    expect(einordnen(knopf('td:ab12:0:1')[0]!, '99')).toEqual({ art: 'egal' })
    expect(einordnen(text('/start')[0]!, '42')).toEqual({ art: 'egal' })
    const offen = new Map([
      ['A', { rids: ['r1'], msgs: [11, 12], frageZeit: 5, faeden: [], at: 0 }],
      ['B', { rids: [], msgs: [20], frageZeit: 0, faeden: [], at: 0 }],
    ])
    expect(zielSitzung(einordnen(text('ja', 20)[0]!, '42'), offen)).toBe('B')
    expect(zielSitzung(einordnen(text('ja')[0]!, '42'), offen)).toBe('A')
    expect(zielSitzung(einordnen(knopf('td:r9:0:0')[0]!, '42'), offen)).toBe(null)
    expect(kuerze('abcdef', 4)).toBe('abc…')
    expect(leseLeerlauf('    "HIDIdleTime" = 51394028583')).toBe(51394.028583)
    expect(leseLeerlauf('nichts')).toBe(null)
    const lang = ['Ergebnis: alles grün.', ...Array.from({ length: 200 }, (_, i) => `Zeile ${i} mit Einzelheiten`), 'Offen: Doku fehlt.'].join('\n')
    const a = auszug(lang, 100, 300)
    expect(a.startsWith('Ergebnis: alles grün.')).toBe(true)
    expect(a.endsWith('Offen: Doku fehlt.')).toBe(true)
    expect(a).toContain('[…]')
    expect(a.length).toBeLessThan(450)
    expect(auszug('kurz')).toBe('kurz')
    expect(alsHtml('# Ergebnis\n**fertig**, siehe `a<b` und [PR](https://github.com/x/y/pull/1?a=1&b=2)\n- eins\n```\nx > 1\n```'))
      .toBe('<b>Ergebnis</b>\n<b>fertig</b>, siehe <code>a&lt;b</code> und <a href="https://github.com/x/y/pull/1?a=1&amp;b=2">PR</a>\n• eins\n<pre>x &gt; 1</pre>')
  })
})

describe('Fertig-Meldung', () => {
  test('weg oder da: die Regel', async () => {
    // Am Rechner (20 s Leerlauf): nichts, auch nach 25 min Arbeit.
    expect(istWeg(20 * 1000, 3, 25 * MIN)).toBe(false)
    // Seit 4 min nichts angefasst: auch ein 5-min-Auftrag meldet sich.
    expect(istWeg(4 * MIN, 3, 5 * MIN)).toBe(true)
    // „weg aus“: nie.
    expect(istWeg(60 * MIN, 0, 60 * MIN)).toBe(false)
    // Nicht messbar: ab 10 min Laufzeit.
    expect(istWeg(null, 3, 9 * MIN)).toBe(false)
    expect(istWeg(null, 3, 10 * MIN)).toBe(true)
  })

  test('ohne Messung des Leerlaufs: ab 10 min Laufzeit', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on)
    await $.session.start(session)
    await $.turn.start({ text: 'kurz', turnId: 'a' })
    await $.turn.complete(zug(3 * MIN))
    expect(w.sent()).toHaveLength(0)
    await $.turn.start({ text: 'lang', turnId: 'b' })
    await $.turn.complete(zug(23 * MIN, 'Build ist durch, 3 Tests rot.'))
    expect(w.sent()).toHaveLength(1)
    const t = String(w.sent()[0]!.body.text)
    expect(t).toContain('Fertig nach 23 min')
    expect(t).toContain('📁 Tal')
    expect(t).toContain('3 Tests rot')
    expect(w.sent()[0]!.body.parse_mode).toBe('HTML')
  })

  test('hat Claude selbst per tg gemeldet, kommt keine zweite', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on)
    await $.session.start(session)
    await $.turn.start({ text: 'lang', turnId: 'a' })
    await $.tool.call({ tool: 'Bash', command: '~/.claude/bin/tg "fertig"' })
    await $.turn.complete(zug(30 * MIN))
    expect(w.sent()).toHaveLength(0)
  })

  test('eine Antwort darauf wird zur Nachricht in der Sitzung, deren Ergebnis kommt zurück', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { updates: [[], text('Mach noch die Doku', 501)] })
    await $.session.start(session)
    await $.turn.start({ text: 'lang', turnId: 'a' })
    await $.turn.complete(zug(15 * MIN))
    expect(w.sent()).toHaveLength(1)
    await uhr.advance(16 * 1000)
    await uhr.advance(16 * 1000)
    expect(w.prompts).toEqual([{ text: 'Mach noch die Doku', asUser: true }])
    expect(String(w.sent()[1]!.body.text)).toContain('angekommen')
    // Der Zug, den die Antwort auslöst, meldet sich auch, wenn er kurz ist.
    await $.prompt.submit({ text: 'Mach noch die Doku', wait: false, origin: { kind: 'plugin', name: 'telegram-draht', asUser: true } })
    await $.turn.start({ text: 'Mach noch die Doku', turnId: 'b' })
    await $.turn.complete(zug(40 * 1000, 'Doku ergänzt.'))
    expect(String(w.sent()[2]!.body.text)).toContain('Doku ergänzt.')
  })

  test('/telegram test schickt eine Probe', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on)
    await $.session.start(session)
    const r = await $.command.run(befehl('test'))
    expect(r.text).toContain('Testnachricht')
    expect(String(w.sent()[0]!.body.text)).toContain('🧪')
  })
})

describe('In der App weitermachen', () => {
  test('der Knopf unter der Fertig-Meldung schaltet Remote Control ein', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on)
    await $.session.start(session)
    await $.turn.start({ text: 'lang', turnId: 'a' })
    await $.turn.complete(zug(12 * MIN))
    const meldung = w.sent()[0]!
    const knoepfe = (meldung.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    expect(knoepfe[0]![0]!.text).toContain('In der App weitermachen')
    w.updates.push(knopf(knoepfe[0]![0]!.callback_data, 501))
    await uhr.advance(16 * 1000)
    expect(w.rc).toEqual([expect.objectContaining({ session_id: 'self', enabled: true })])
    expect(String(w.sent().at(-1)!.body.text)).toContain('Remote Control ist an')
  })
})

describe('Einrichten', () => {
  test('ohne Token: die Anleitung; mit Token und Nachricht: Chat gefunden und eingetragen', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, { env: '# mein Bot\nTELEGRAM_BOT_TOKEN=777:neu\n', updates: [[], text('hallo')] })
    await $.session.start(session)
    // Erst noch keine Nachricht an den Bot.
    expect((await $.command.run(befehl('einrichten'))).text).toContain('noch keine Nachricht')
    const r = await $.command.run(befehl('einrichten'))
    expect(r.text).toContain('Verbunden mit @mein_bot')
    expect(w.dateien['/Users/j/.claude/telegram.env']).toBe('# mein Bot\nTELEGRAM_BOT_TOKEN=777:neu\nTELEGRAM_CHAT_ID=42\n')
    expect(String(w.sent().at(-1)!.body.text)).toContain('verbunden')
    expect(r.text).not.toContain('777:neu')
  })

  test('ganz ohne Datei: die Anleitung', async ($, on) => {
    mock.clock(on, { now: START })
    welt(on, { env: '' })
    await $.session.start(session)
    expect((await $.command.run(befehl('einrichten'))).text).toContain('@BotFather')
    expect((await $.command.run(befehl('test'))).text).toContain('@BotFather')
  })
})

describe('Rückfragen', () => {
  test('standardmäßig nach 25 s aufs Handy', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on)
    await $.session.start(session)
    void $.tool.call({ tool: 'AskUserQuestion', questions: [frage] })
    await uhr.advance(24 * 1000)
    expect(w.sent()).toHaveLength(0)
    await uhr.advance(2 * 1000)
    expect(w.sent()).toHaveLength(1)
  })

  test('mit Wartezeit: nach einer Minute aufs Handy, Knopf beantwortet sie', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on)
    await $.session.start(session)
    await $.command.run(befehl('fragen 60'))
    const antwort = $.tool.call({ tool: 'AskUserQuestion', questions: [frage] })
    await uhr.advance(30 * 1000)
    expect(w.sent()).toHaveLength(0)
    await uhr.advance(31 * 1000)
    expect(w.sent()).toHaveLength(1)
    const gesendet = w.sent()[0]!.body
    expect(String(gesendet.text)).toContain('Welche Farbe')
    const tasten = (gesendet.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    expect(tasten.map(r => r[0]!.text)).toEqual(['Blau', 'Rot'])
    // Der Knopf trägt die Kennung dieser Rückfrage: erst jetzt bekannt.
    w.updates.push(knopf(tasten[1]![0]!.callback_data))
    await uhr.advance(4 * 1000)
    const r = await antwort
    expect(r).toMatchObject({ result: { answers: { 'Welche Farbe soll der Knopf haben?': 'Rot' } } })
    expect(w.tg.some(a => a.methode === 'editMessageText' && String(a.body.text).includes('✅ Rot'))).toBe(true)
  })

  test('wer am Rechner antwortet, räumt die Nachricht im Handy ab', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    let antworten: (v: unknown) => void = () => {}
    const dialog = new Promise(res => { antworten = res })
    const w = welt(on, { dialog })
    await $.session.start(session)
    const antwort = $.tool.call({ tool: 'AskUserQuestion', questions: [frage] })
    await uhr.advance(61 * 1000)
    expect(w.sent()).toHaveLength(1)
    antworten({ result: { questions: [frage], answers: { [frage.question]: 'Blau' } } })
    const r = await antwort
    expect(r).toMatchObject({ result: { answers: { [frage.question]: 'Blau' } } })
    expect(w.tg.some(a => a.methode === 'editMessageText' && String(a.body.text).includes('Am Rechner beantwortet: Blau'))).toBe(true)
  })

  test('eigener Text beantwortet die offene Rückfrage', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { updates: [text('Grün bitte')] })
    await $.session.start(session)
    const antwort = $.tool.call({ tool: 'AskUserQuestion', questions: [frage] })
    await uhr.advance(26 * 1000)
    await uhr.advance(4 * 1000)
    const r = await antwort
    expect(r).toMatchObject({ result: { answers: { [frage.question]: 'Grün bitte' } } })
    expect(w.prompts).toHaveLength(0)
  })

  test('aus: die Rückfrage bleibt am Rechner', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on)
    await $.session.start(session)
    await $.command.run(befehl('fragen aus'))
    void $.tool.call({ tool: 'AskUserQuestion', questions: [frage] })
    await uhr.advance(5 * MIN)
    expect(w.sent()).toHaveLength(0)
  })
})

describe('Nebeneinander mit cache-waechter', () => {
  test('cw:-Knöpfe bleiben eine Minute liegen, der Offset rückt nicht darüber', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const cw = knopf('cw:abcd:warm')[0]!
    const w = welt(on, { updates: Array.from({ length: 8 }, () => [cw]) })
    await $.session.start(session)
    await $.command.run(befehl('test'))
    await uhr.advance(16 * 1000)
    await uhr.advance(16 * 1000)
    const holen = w.tg.filter(a => a.methode === 'getUpdates').map(a => a.body.offset)
    expect(holen).toEqual([0, 0])
    await uhr.advance(64 * 1000)
    const danach = w.tg.filter(a => a.methode === 'getUpdates').map(a => a.body.offset)
    expect(danach.at(-1)).toBe(cw.update_id + 1)
  })
})

