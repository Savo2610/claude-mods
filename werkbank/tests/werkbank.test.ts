import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, FsEntry, On, ProcessRunResult, SessionStartInput, TurnCompleteInput } from 'claude-code'

import {
  befehlsOrt, checkoutVon, leseCwds, leseLauscher, leseWorktrees, loeschZiele, naechsterPlatz, portsFuer, startBefehl,
  zaehleOffen, zielMain,
} from '../hooks/rein'

tier('user')

const MIN = 60 * 1000
const START = Date.parse('2026-10-09T14:00:00Z')
const H = '/Users/j'
const R = '/c/Tal'

describe('Hilfen', () => {
  test('git, lsof und ps lesen', () => {
    const wl = `worktree ${R}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${R}-raupe\nHEAD bbb\nbranch refs/heads/raupe\n\nworktree /c/x\nHEAD ccc\ndetached\n`
    expect(leseWorktrees(wl)).toEqual([
      { pfad: R, head: 'aaa', branch: 'main' }, { pfad: `${R}-raupe`, head: 'bbb', branch: 'raupe' }, { pfad: '/c/x', head: 'ccc', branch: null },
    ])
    expect(leseLauscher('p10\ncnode\nn127.0.0.1:5173\nn[::1]:5173\np11\ncworkerd\nn*:8787\n')).toEqual([
      { pid: 10, cmd: 'node', port: 5173 }, { pid: 11, cmd: 'workerd', port: 8787 },
    ])
    expect(leseCwds('p10\nfcwd\nn/c/Tal\np11\nfcwd\nn/c/Tal-raupe/.wrangler\n')).toEqual(new Map([[10, '/c/Tal'], [11, '/c/Tal-raupe/.wrangler']]))
    expect(zaehleOffen(' M a.js\n?? node_modules\n?? neu.js\n')).toBe(2)
    expect(checkoutVon('/c/Tal-raupe/src/x.js', [R, `${R}-raupe`])).toBe(`${R}-raupe`)
    expect(checkoutVon('/c/Talent', [R])).toBe(undefined)
  })

  test('Befehle deuten', () => {
    expect(befehlsOrt('cd ../Tal-raupe && npm test', R, H)).toBe('/c/Tal-raupe')
    expect(befehlsOrt('git -C ~/x push', R, H)).toBe('/Users/j/x')
    expect(befehlsOrt('ls', R, H)).toBe(R)
    expect(zielMain('git push origin main', 'raupe')).toBe(true)
    expect(zielMain('git push origin raupe:main', 'raupe')).toBe(true)
    expect(zielMain('git push -u origin raupe', 'raupe')).toBe(false)
    expect(zielMain('git push', 'main')).toBe(true)
    expect(zielMain('git push', 'raupe')).toBe(false)
    expect(zielMain('git merge raupe', 'main')).toBe(true)
    expect(zielMain('git merge main', 'raupe')).toBe(false)
    expect(zielMain('git log --grep push', 'main')).toBe(false)
    expect(loeschZiele('git worktree remove --force ../Tal-raupe', R, H)).toEqual(['/c/Tal-raupe'])
    expect(loeschZiele('git -C /c/Tal worktree remove /c/Tal-x && rm -rf ../Tal-y dist', R, H)).toEqual(['/c/Tal-x', '/c/Tal-y', '/c/Tal/dist'])
    expect(loeschZiele('rm datei.txt', R, H)).toEqual([])
  })

  test('Plätze und Start', () => {
    expect(naechsterPlatz([0, 1, 3])).toBe(2)
    expect(portsFuer(0)).toEqual({ web: 5173, api: 8787 })
    expect(portsFuer(2)).toEqual({ web: 5175, api: 8802 })
    expect(startBefehl({ dev: 'vite', 'dev:api': 'wrangler dev --port ${API_PORT:-8787}' }, { web: 5174, api: 8801 })).toEqual({
      web: 'API_PORT=8801 npm run dev -- --port 5174 --strictPort', api: 'API_PORT=8801 npm run dev:api',
    })
    expect(startBefehl({ dev: 'next dev' }, { web: 5174, api: 8801 })).toEqual({ web: 'API_PORT=8801 PORT=5174 npm run dev', api: undefined })
    expect(startBefehl({}, { web: 5174, api: 8801 }).web).toBe(undefined)
  })
})

// ---------- Eine nachgebaute Welt: Repo mit Worktrees, Server, Sitzungen ----------

type Wt = { pfad: string; branch: string; vor: number; hinter?: number; offen?: number }
type Opts = { wts?: Wt[]; server?: { pid: number; port: number; cwd: string }[]; andere?: { sid: string; name: string; cwd: string; busy: boolean; checkout?: string }[] }

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: R }
const befehl = (args: string): CommandRunInput => ({ command: 'werkbank', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const zug = (): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' })

function welt(on: On, opts: Opts = {}) {
  const store: Record<string, unknown> = {}
  for (const a of opts.andere ?? []) if (a.checkout) store[`sitzung:${a.sid}`] = { repo: R, checkout: a.checkout, at: START }
  mock.store(on, store)
  mock.env(on, { HOME: H })
  const s = mock.session(on)
  const wts: Wt[] = [{ pfad: R, branch: 'main', vor: 0 }, ...(opts.wts ?? [])]
  const server = [...(opts.server ?? [])]
  const getoetet: number[] = []
  const gestartet: string[] = []
  const entfernt: string[] = []
  const links: string[] = []
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  let naechstePid = 500
  const sitzungen = [{ pid: 1, sessionId: 'ICH', cwd: R, status: 'busy', name: 'diese' }, ...(opts.andere ?? []).map((a, i) => ({ pid: 10 + i, sessionId: a.sid, cwd: a.cwd, status: a.busy ? 'busy' : 'idle', name: a.name }))]
  const dateien: Record<string, string> = {
    [`${R}/package.json`]: JSON.stringify({ scripts: { dev: 'vite', 'dev:api': 'wrangler dev --port ${API_PORT:-8787}' } }),
  }
  for (const w of wts) dateien[`${w.pfad}/package.json`] = dateien[`${R}/package.json`]!
  for (const x of sitzungen) dateien[`${H}/.claude/sessions/${x.pid}.json`] = JSON.stringify(x)
  const da = (p: string) => p === `${R}/node_modules` || wts.some(w => w.pfad === p) || p in dateien || links.includes(p)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'ICH' }))
  on('session.cwd', () => ({ value: R }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__werkbank__${e.name}` } }))
  on('tool.list', () => ({ value: [] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { id: 'werkbank' } }) as never)
  on('fs.exists', ($, e) => ({ value: da(e.path) }))
  on('fs.stat', ($, e) => {
    if (!da(e.path)) throw new Error('ENOENT')
    return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: links.includes(e.path) } }
  })
  on('fs.read', ($, e) => {
    const t = dateien[e.path]
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.list', ($, e) => {
    const vor = e.path + '/'
    const value: FsEntry[] = Object.keys(dateien).filter(p => p.startsWith(vor)).map(p => ({ name: p.slice(vor.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
    return { value }
  })
  on('process.run', ($, e) => {
    const a = [...e.argv]
    const aus = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git') {
      const ort = a[2]!
      const rest = a.slice(3).join(' ')
      const w = wts.find(x => x.pfad === ort)
      if (rest.startsWith('rev-parse --path-format')) return ort.startsWith(R) ? aus(`${R}/.git\n`) : aus('', 128)
      if (rest === 'worktree list --porcelain') return aus(wts.map(x => `worktree ${x.pfad}\nHEAD ${x.branch}0000000\nbranch refs/heads/${x.branch}\n`).join('\n'))
      if (rest.startsWith('rev-parse --verify -q origin/main')) return aus('sha\n')
      if (rest === 'status --porcelain') return aus(Array.from({ length: w?.offen ?? 0 }, (_, i) => ` M f${i}.js`).join('\n'))
      if (rest.startsWith('rev-list --left-right --count')) return aus(`${w?.hinter ?? 0}\t${w?.vor ?? 0}\n`)
      if (rest.startsWith('log -1')) return aus(`${(START - 3 * MIN) / 1000}\n`)
      if (rest.startsWith('worktree remove')) {
        const p = a.at(-1)!
        entfernt.push(p)
        wts.splice(wts.findIndex(x => x.pfad === p), 1)
        return aus('')
      }
      if (rest.startsWith('branch -D')) return aus('')
      return aus('', 1)
    }
    if (a[0] === '/usr/sbin/lsof' && a.includes('-iTCP')) {
      return aus(server.map(x => `p${x.pid}\ncnode\nn127.0.0.1:${x.port}`).join('\n'))
    }
    if (a[0] === '/usr/sbin/lsof') return aus(server.map(x => `p${x.pid}\nfcwd\nn${x.cwd}`).join('\n'))
    if (a[0] === '/bin/ps' && a[2] === 'pid=') return aus(sitzungen.map(x => x.pid).join('\n'))
    if (a[0] === '/bin/ps' && a[2] === 'ppid=,command=') return aus('1 node vite')
    if (a[0] === '/bin/ps') return aus('/sbin/launchd')
    if (a[0] === '/usr/bin/pgrep') return aus('', 1)
    if (a[0] === '/bin/kill') {
      for (const p of a.slice(2).map(Number)) {
        getoetet.push(p)
        const i = server.findIndex(x => x.pid === p)
        if (i >= 0) server.splice(i, 1)
      }
      return aus('')
    }
    if (a[0] === '/bin/ln') { links.push(a[3]!); return aus('') }
    if (a[0] === '/bin/rm') return aus('')
    if (a[0] === '/bin/sh') {
      const skript = a[2]!
      if (skript.includes('nohup')) {
        gestartet.push(skript)
        const cwd = /cd '([^']+)'/.exec(skript)![1]!
        const port = Number(/--port (\d+)/.exec(skript)?.[1] ?? /API_PORT=(\d+)/.exec(skript)![1])
        server.push({ pid: naechstePid++, port, cwd })
        return aus('')
      }
      const port = Number(/-iTCP:(\d+)/.exec(skript)?.[1])
      return aus('', server.some(x => x.port === port) ? 0 : 1)
    }
    return aus('', 127)
  })
  // Was der Befehl in der Welt bewirkt, bevor er „fertig“ ist.
  const nachBefehl: ((befehl: string) => void)[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') for (const f of nachBefehl.splice(0)) f(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  return { nachBefehl, wts, server, getoetet, gestartet, entfernt, links, status, toasts, session: s, store, zuletzt: () => status.at(-1) }
}

describe('Lage', () => {
  test('Statuszeile: laufender Server, eine andere Sitzung, nichts zum Aufräumen', async ($, on) => {
    const uhr = mock.clock(on, { now: START })
    const w = welt(on, {
      wts: [{ pfad: `${R}-raupe`, branch: 'raupe', vor: 3 }],
      server: [{ pid: 77, port: 5173, cwd: R }],
      andere: [{ sid: 'B', name: 'Kabelsee-Wertung', cwd: R, busy: true, checkout: `${R}-raupe` }],
    })
    await $.session.start(session)
    await uhr.advance(4000)
    expect(w.zuletzt()).toBe('🛠 ▶ main :5173 · 👥 „Kabelsee-Wertung“ arbeitet in raupe')
    const r = await $.command.run(befehl(''))
    expect(r.text).toContain('raupe')
    expect(r.text).toContain('+3 Commits')
    expect(r.text).toContain('„Kabelsee-Wertung“ arbeitet')
  })

  test('neuer Worktree: Claude erfährt seinen festen Port', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, { wts: [{ pfad: `${R}-raupe`, branch: 'raupe', vor: 1 }] })
    await $.session.start(session)
    await $.command.run(befehl(''))
    w.nachBefehl.push(() => w.wts.push({ pfad: `${R}-tiere`, branch: 'tiere', vor: 0 }))
    const r = await $.tool.call({ tool: 'Bash', command: 'git worktree add -b tiere ../Tal-tiere origin/main' })
    expect(r.context?.join('\n')).toContain('Der neue Checkout tiere (/c/Tal-tiere) hat den festen Port 5175 (API 8802)')
  })
})

describe('Schutz', () => {
  test('kein Löschen, wo eine andere Sitzung arbeitet, und nie den Hauptordner', async ($, on) => {
    mock.clock(on, { now: START })
    welt(on, {
      wts: [{ pfad: `${R}-raupe`, branch: 'raupe', vor: 2 }, { pfad: `${R}-alt`, branch: 'alt', vor: 0 }],
      andere: [{ sid: 'B', name: 'Raupe', cwd: R, busy: false, checkout: `${R}-raupe` }],
    })
    await $.session.start(session)
    const r1 = await $.tool.call({ tool: 'Bash', command: 'git worktree remove --force ../Tal-raupe' })
    expect(r1.deny).toContain('arbeitet die Sitzung „Raupe“')
    const r2 = await $.tool.call({ tool: 'Bash', command: 'rm -rf /c/Tal' })
    expect(r2.deny).toContain('Hauptordner')
    const r3 = await $.tool.call({ tool: 'Bash', command: 'git worktree remove ../Tal-alt' })
    expect(r3.deny).toBe(undefined)
  })

  test('Merge-Ampel: anhalten im selben Checkout, sonst nur ein Hinweis', async ($, on) => {
    mock.clock(on, { now: START })
    const andere = [{ sid: 'B', name: 'Tiere', cwd: R, busy: true, checkout: R }]
    welt(on, { wts: [{ pfad: `${R}-raupe`, branch: 'raupe', vor: 2 }], andere })
    await $.session.start(session)
    const r1 = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(r1.deny).toContain('„Tiere“ arbeitet gerade im selben Checkout')
    const r2 = await $.tool.call({ tool: 'Bash', command: 'git -C /c/Tal-raupe push origin raupe:main' })
    expect(r2.deny).toBe(undefined)
    expect(r2.context?.join()).toContain('Gleichzeitig arbeiten im Repo „Tiere“ (in main)')
  })
})

describe('Dev-Server', () => {
  test('/werkbank dev raupe: main stoppen, Link anlegen, API und Web auf festen Ports', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, { wts: [{ pfad: `${R}-raupe`, branch: 'raupe', vor: 1 }], server: [{ pid: 77, port: 5173, cwd: R }] })
    await $.session.start(session)
    const r = await $.command.run(befehl('dev raupe'))
    expect(r.text).toContain('raupe läuft auf http://localhost:5174/ (API :8801)')
    expect(r.text).toContain('Gestoppt: main :5173')
    expect(r.text).toContain('node_modules von main verlinkt')
    expect(w.getoetet).toContain(77)
    expect(w.links).toEqual([`${R}-raupe/node_modules`])
    expect(w.gestartet[0]).toContain("API_PORT=8801 npm run dev:api")
    expect(w.gestartet[1]).toContain('npm run dev -- --port 5174 --strictPort')
    expect(w.gestartet[1]).toContain(`${H}/.claude/werkbank/logs/Tal-1-web.log`)
    // Ein zweites Mal: läuft schon, nichts Neues.
    expect((await $.command.run(befehl('dev raupe'))).text).toContain('läuft schon')
    expect(w.gestartet).toHaveLength(2)
  })

  test('der Server einer arbeitenden Sitzung bleibt stehen', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, {
      wts: [{ pfad: `${R}-raupe`, branch: 'raupe', vor: 1 }, { pfad: `${R}-tiere`, branch: 'tiere', vor: 1 }],
      server: [{ pid: 78, port: 5175, cwd: `${R}-tiere` }],
      andere: [{ sid: 'B', name: 'Tiere', cwd: R, busy: true, checkout: `${R}-tiere` }],
    })
    await $.session.start(session)
    await $.command.run(befehl('dev raupe'))
    expect(w.getoetet).not.toContain(78)
  })
})

describe('Aufräumen', () => {
  test('nach Push und Zug: gemergter Worktree weg, ungemergter bleibt', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, { wts: [{ pfad: `${R}-grenze`, branch: 'grenze', vor: 2 }, { pfad: `${R}-schnee`, branch: 'schnee', vor: 5 }] })
    await $.session.start(session)
    await $.command.run(befehl(''))
    // Gemergt: grenze hat keine eigenen Commits mehr gegenüber origin/main.
    w.nachBefehl.push(() => { w.wts.find(x => x.branch === 'grenze')!.vor = 0 })
    await $.tool.call({ tool: 'Bash', command: 'git -C /c/Tal-grenze push origin grenze:main' })
    expect(w.entfernt).toHaveLength(0)
    await $.turn.complete(zug())
    expect(w.entfernt).toEqual([`${R}-grenze`])
    expect(w.toasts.at(-1)).toContain('grenze entfernt')
    expect(JSON.stringify(w.session.appended())).toContain('grenze entfernt')
  })

  test('/werkbank aufräumen: leere auch, der Rest mit Begründung', async ($, on) => {
    mock.clock(on, { now: START })
    const w = welt(on, { wts: [{ pfad: `${R}-leer`, branch: 'leer', vor: 0 }, { pfad: `${R}-schnee`, branch: 'schnee', vor: 5, offen: 2 }] })
    await $.session.start(session)
    const r = await $.command.run(befehl('aufräumen'))
    expect(w.entfernt).toEqual([`${R}-leer`])
    expect(r.text).toContain('schnee: 5 Commits nicht gemergt, 2 Dateien offen')
  })

  test('/werkbank weg: auch ungemergt, mit Rückweg', async ($, on) => {
    mock.clock(on, { now: START })
    welt(on, { wts: [{ pfad: `${R}-schnee`, branch: 'schnee', vor: 5 }] })
    await $.session.start(session)
    const r = await $.command.run(befehl('weg schnee'))
    expect(r.text).toContain('schnee entfernt')
    expect(r.text).toContain('zurückholen: git branch schnee schnee0000')
  })
})
