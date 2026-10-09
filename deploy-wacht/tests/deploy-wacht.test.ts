import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, HttpResponse, On, SessionStartInput, TurnCompleteInput } from 'claude-code'

import {
  BEHEBEN_MAX, KEIN_BUILD_NACH_MS, PUSH, findeBuild, geschoben, leseCf, leseKonfig, leseRefs, logZeilen, mmss, repoOrt, standVon,
} from '../hooks/register'
import type { Build } from '../hooks/register'

tier('user')

const SEK = 1000
const MIN = 60 * SEK
const START = Date.parse('2026-10-09T12:00:00Z')
const REPO = '/Users/j/Code/Tal'
const KONTO = 'a'.repeat(32)
const TAG = 'b'.repeat(32)
const ALT = '1111111111111111111111111111111111111111'
const NEU = '2222222222222222222222222222222222222222'

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: REPO }
let zuege = 0
const zug = (): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++zuege, reason: 'answer' })
const befehl = (args: string): CommandRunInput => ({ command: 'deploy', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const build = (sha: string, status: string, outcome: string | null = null, sek = 0): Build => ({
  build_uuid: 'bu-' + sha.slice(0, 4),
  status,
  build_outcome: outcome,
  created_on: new Date(START).toISOString(),
  stopped_on: status === 'stopped' ? new Date(START + sek * SEK).toISOString() : undefined,
  build_trigger_metadata: { commit_hash: sha, branch: 'main', commit_message: 'Lift schneller\n\nmehr Text' },
})

type Opts = { leer?: number; cfEnv?: string; builds?: Build[][]; remote?: string }

// Die Welt unter der Mod: git, Dateien, Cloudflare und Telegram nach Drehbuch.
function welt(on: On, opts: Opts = {}) {
  mock.store(on, {})
  mock.env(on, { HOME: '/Users/j' })
  const s = mock.session(on)
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  const prompts: string[] = []
  const http: string[] = []
  const tg: string[] = []
  const git = { remote: opts.remote ?? ALT, push: NEU }
  const reihe = opts.builds ?? []
  const dateien: Record<string, string> = {
    [`${REPO}/wrangler.jsonc`]: '{\n  // das Tal\n  "name": "website",\n  "routes": [{ "pattern": "veerka.mp", "custom_domain": true }],\n}',
    '/Users/j/.claude/cloudflare.env': opts.cfEnv ?? `CLOUDFLARE_API_TOKEN=geheim\nCLOUDFLARE_ACCOUNT_ID=${KONTO}\n`,
    '/Users/j/.claude/telegram.env': 'TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_CHAT_ID=42\n',
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: REPO }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const inhalt = dateien[e.path]
    if (inhalt === undefined) throw new Error('ENOENT')
    return { value: inhalt }
  })
  on('fs.write', ($, e) => { dateien[e.path] = e.text; return { value: undefined } })
  on('process.run', ($, e) => {
    const a = e.argv
    const aus = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === '/usr/sbin/ioreg') return aus(`"HIDIdleTime" = ${(opts.leer ?? 0) * 1e6}`)
    if (a.includes('--show-toplevel')) return aus(a[2] === REPO || a[2]?.startsWith(REPO + '/') ? REPO + '\n' : '', a[2]?.startsWith(REPO) ? 0 : 128)
    if (a.includes('for-each-ref')) return aus(`origin/HEAD ${git.remote}\norigin/main ${git.remote}\n`)
    return aus('', 1)
  })
  on('http.fetch', ($, e) => {
    http.push(e.url)
    const ok = (result: unknown): { value: HttpResponse } => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ success: true, result }) } })
    if (e.url.startsWith('https://api.telegram.org/')) {
      tg.push(String((JSON.parse(e.init?.body ?? '{}') as { text?: string }).text))
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true,"result":{}}' } }
    }
    if (e.url === 'https://veerka.mp/') return { value: { status: 200, ok: true, headers: {}, text: '<html>' } }
    if (e.url.endsWith('/workers/scripts')) return ok([{ id: 'website', tag: TAG }])
    if (e.url.includes(`/builds/workers/${TAG}/builds`)) return ok(reihe.length > 1 ? reihe.shift() : (reihe[0] ?? []))
    // Wie die echte API (09.10. gegen den Build von jf geprüft): [zeit, text], seitenweise mit cursor.
    if (e.url.endsWith('/logs')) return ok({ lines: [[1, 'npm run build'], [2, 'npm WARN alt']], truncated: true, cursor: 'WzAsMl0' })
    if (e.url.endsWith('/logs?cursor=WzAsMl0')) return ok({ lines: [[3, '\u001b[31mError: Cannot find module ./lift.js\u001b[0m'], [4, '']], truncated: false, cursor: 'WzAsNF0' })
    if (e.url.endsWith('/user/tokens/verify')) return ok({ status: 'active' })
    if (e.url.endsWith('/accounts')) return ok([{ id: KONTO, name: 'Julian' }])
    return { value: { status: 404, ok: false, headers: {}, text: '{"success":false,"errors":[{"message":"nicht da"}]}' } }
  })
  // Der Push selbst: bewegt origin/main, wenn er „gelingt“.
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && PUSH.test(e.command)) git.remote = git.push
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  const setzeBuilds = (b: Build[]) => { reihe.length = 0; reihe.push(b) }
  return { status, toasts, prompts, http, tg, dateien, session: s, git, setzeBuilds, zuletzt: () => status.at(-1) }
}

describe('Hilfen', () => {
  test('Push erkennen und den Ort finden', () => {
    expect(PUSH.test('git push origin main')).toBe(true)
    expect(PUSH.test('npm test && git push')).toBe(true)
    expect(PUSH.test('git -C "/a b/c" push')).toBe(true)
    expect(PUSH.test('git log --grep push')).toBe(false)
    expect(PUSH.test('echo "git pushen"')).toBe(false)
    expect(repoOrt('git push', '/w', '/h')).toBe('/w')
    expect(repoOrt('cd ../main && git merge x && git push origin main', '/w/wt', '/h')).toBe('/w/wt/../main')
    expect(repoOrt('git -C ~/Code/Tal push', '/w', '/h')).toBe('/h/Code/Tal')
    expect(repoOrt("cd '/a b' && git push; cd /c", '/w', '/h')).toBe('/a b')
  })

  test('wrangler-Konfiguration lesen', () => {
    const jsonc = '{\n  // Kommentar mit "name": "falsch"\n  "name": "website", /* block */\n  "account_id": "k1",\n  "main": "https://x//y",\n  "routes": [{ "pattern": "veerka.mp/*", "custom_domain": true },],\n}'
    expect(leseKonfig('wrangler.jsonc', jsonc)).toEqual({ name: 'website', konto: 'k1', domain: 'veerka.mp' })
    const toml = 'name = "kurz"\naccount_id = "k2"\nroutes = [ { pattern = "kurz.veerka.mp", custom_domain = true } ]\n\n[vars]\nname = "nicht das"\n'
    expect(leseKonfig('wrangler.toml', toml)).toEqual({ name: 'kurz', konto: 'k2', domain: 'kurz.veerka.mp' })
    expect(leseKonfig('wrangler.json', '{"name":"x","route":"*.veerka.mp/*"}')).toEqual({ name: 'x', konto: undefined, domain: undefined })
    expect(leseCf('CLOUDFLARE_API_TOKEN="t"\n')).toEqual({ token: 't', konto: undefined })
    expect(leseCf('')).toBe(null)
  })

  test('Refs, Builds und Log', () => {
    const vorher = leseRefs(`origin/HEAD ${ALT}\norigin/main ${ALT}\norigin/raupe ${ALT}\n`)
    expect([...vorher.keys()]).toEqual(['origin/main', 'origin/raupe'])
    const nachher = leseRefs(`origin/main ${NEU}\norigin/raupe ${ALT}\norigin/neu ${ALT}\n`)
    expect(geschoben(vorher, nachher)).toEqual([{ branch: 'main', sha: NEU }, { branch: 'neu', sha: ALT }])
    expect(findeBuild([build(ALT, 'stopped', 'success'), build(NEU, 'running')], NEU)?.status).toBe('running')
    expect(findeBuild([{ build_uuid: 'x', build_trigger_metadata: { commit_hash: NEU.slice(0, 7) } }], NEU)?.build_uuid).toBe('x')
    expect(findeBuild([build(ALT, 'running')], NEU)).toBe(undefined)
    expect(standVon(build(NEU, 'queued'))).toBe('wartet')
    expect(standVon(build(NEU, 'initializing'))).toBe('baut')
    expect(standVon(build(NEU, 'stopped', 'success'))).toBe('live')
    expect(standVon(build(NEU, 'stopped', 'fail'))).toBe('fehler')
    expect(standVon(build(NEU, 'stopped', 'cancelled'))).toBe('abgebrochen')
    expect(logZeilen({ lines: [[1, 'a'], [2, '\u001b[32mb\u001b[0m'], [3, '']] })).toEqual(['a', 'b'])
    expect(logZeilen({ lines: ['x', { message: 'y' }] })).toEqual(['x', 'y'])
    expect(logZeilen(null)).toEqual([])
    expect(mmss(161 * SEK)).toBe('2:41')
  })
})

describe('Nach dem Push', () => {
  test('grün: Statuszeile, Hinweis an Claude, Notiz nach dem Zug, kein Telegram am Rechner', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { builds: [[build(ALT, 'stopped', 'success')], [build(NEU, 'running'), build(ALT, 'stopped', 'success')], [build(NEU, 'stopped', 'success', 161)]] })
    await $.session.start(session)
    await $.turn.start({ text: 'bring es live', turnId: 'a' })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(r.context?.[0]).toContain('beobachtet den Cloudflare-Build von „website“')
    expect(w.zuletzt()).toContain('🚀 website: wartet auf Build 0:00')
    await uhr.advance(11 * SEK)
    expect(w.zuletzt()).toContain('wartet auf Build 0:1')
    await uhr.advance(10 * SEK)
    expect(w.zuletzt()).toContain('🚀 website baut')
    await uhr.advance(10 * SEK)
    expect(w.zuletzt()).toBe('✅ website live (2:41)')
    expect(w.toasts.at(-1)).toContain('ist live auf veerka.mp')
    expect(w.http).toContain('https://veerka.mp/')
    // Während des Zugs keine Notiz, danach eine.
    expect(w.session.appended()).toHaveLength(0)
    await $.turn.complete(zug())
    expect(JSON.stringify(w.session.appended()[0]?.message)).toContain('ist durch, die Änderung ist live auf veerka.mp')
    expect(w.tg).toHaveLength(0)
    // Nach 5 min verschwindet die Zeile, die Uhr schläft.
    await uhr.advance(5 * MIN + 2 * SEK)
    expect(w.zuletzt()).toBe(undefined)
  })

  test('rot: Claude bekommt das Log, aufs Handy wenn weg, höchstens zweimal hintereinander', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { leer: 5 * MIN, builds: [[build(NEU, 'stopped', 'fail', 50)]] })
    await $.session.start(session)
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await uhr.advance(11 * SEK)
    expect(w.zuletzt()).toBe('❌ website: Build fehlgeschlagen')
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('ist fehlgeschlagen')
    expect(w.prompts[0]).toContain('Error: Cannot find module ./lift.js')
    expect(w.prompts[0]).not.toContain('\u001b')
    expect(w.prompts[0]).toContain('behebe sie')
    expect(w.tg[0]).toContain('❌ Build fehlgeschlagen · website')
    expect(w.tg[0]).toContain('Claude schaut nach.')
    // Weitere rote Pushes: bis BEHEBEN_MAX bekommt Claude sie, danach nur eine Notiz.
    for (let i = 0; i < BEHEBEN_MAX; i++) {
      w.git.push = String(3 + i).repeat(40)
      w.setzeBuilds([build(w.git.push, 'stopped', 'fail', 40)])
      await $.tool.call({ tool: 'Bash', command: 'git push' })
      await uhr.advance(11 * SEK)
    }
    expect(w.prompts).toHaveLength(BEHEBEN_MAX)
    expect(JSON.stringify(w.session.appended())).toContain('nicht selbst weiterpushen')
    // Ein grüner Build setzt den Zähler zurück.
    w.git.push = '9'.repeat(40)
    w.setzeBuilds([build(w.git.push, 'stopped', 'success', 40)])
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await uhr.advance(11 * SEK)
    w.git.push = '8'.repeat(40)
    w.setzeBuilds([build(w.git.push, 'stopped', 'fail', 40)])
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await uhr.advance(11 * SEK)
    expect(w.prompts).toHaveLength(BEHEBEN_MAX + 1)
  })

  test('kein Build nach 3 min: Hinweis', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { builds: [[]] })
    await $.session.start(session)
    await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    await uhr.advance(KEIN_BUILD_NACH_MS + 11 * SEK)
    expect(w.zuletzt()).toContain('⚠️ website: kein Build zu 2222222')
    expect(JSON.stringify(w.session.appended())).toContain('keinen Build gestartet')
  })

  test('ein Push, der nichts bewegt, oder ein Repo ohne wrangler: nichts', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on)
    w.git.push = ALT
    await $.session.start(session)
    const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(r.context).toBe(undefined)
    w.git.push = NEU
    const r2 = await $.tool.call({ tool: 'Bash', command: 'git -C /anderswo push' })
    expect(r2.context).toBe(undefined)
    expect(w.status).toHaveLength(0)
  })

  test('ohne Token: ein Hinweis, kein Beobachten', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, { cfEnv: '' })
    await $.session.start(session)
    const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(r.context).toBe(undefined)
    expect(w.toasts[0]).toContain('/deploy einrichten')
  })
})

describe('/deploy', () => {
  test('einrichten trägt das Konto ein und prüft die Builds', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, { cfEnv: '# nur lesen\nCLOUDFLARE_API_TOKEN=geheim\n', builds: [[build(NEU, 'stopped', 'fail')]] })
    await $.session.start(session)
    const r = await $.command.run(befehl('einrichten'))
    expect(r.text).toContain('Verbunden: 1 Workers sichtbar, Builds lesbar. Konto-ID eingetragen.')
    expect(w.dateien['/Users/j/.claude/cloudflare.env']).toBe(`# nur lesen\nCLOUDFLARE_API_TOKEN=geheim\nCLOUDFLARE_ACCOUNT_ID=${KONTO}\n`)
    expect(r.text).not.toContain('geheim')
    // Der Status zeigt den letzten Build des Projekts samt Log, wenn er rot war.
    const k = await $.command.run(befehl(''))
    expect(k.text).toContain('Letzter Build  website: fehler')
    expect(k.text).toContain('Cannot find module')
  })

  test('ohne Datei: die Anleitung', async ($, on) => {
    mock.clock(on, { now: START })
    welt(on, { cfEnv: '' })
    await $.session.start(session)
    expect((await $.command.run(befehl('einrichten'))).text).toContain('Benutzer-Token')
  })

  test('fehler melden: Claude bekommt nur eine Notiz', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, { builds: [[build(NEU, 'stopped', 'fail')]] })
    await $.session.start(session)
    await $.command.run(befehl('fehler melden'))
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await uhr.advance(11 * SEK)
    expect(w.prompts).toHaveLength(0)
    expect(JSON.stringify(w.session.appended())).toContain('Erklär mir kurz')
  })
})
