import { loadAll } from '../store.js'

const DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

export default async function report(args, _config) {
  const opts = parseArgs(args)
  const { events: all, sessions, machines } = loadAll()
  if (!all.length) throw new Error('nenhum dado ainda. Rode "ptm collect" primeiro.')

  const since = opts.days ? new Date(Date.now() - opts.days * 86400e3).toISOString() : ''
  const events = all.filter((ev) => ev.t >= since && (!opts.machine || ev.machine === opts.machine))
  if (!events.length) throw new Error('nenhum evento no período/máquina escolhidos.')

  const total = sum(events)
  const period = opts.days ? `últimos ${opts.days} dias` : 'todo o período'
  console.log(`\nUso de tokens — ${period} — ${opts.machine || `${machines.length} máquina(s)`}`)
  console.log(`${events[0].t.slice(0, 10)} a ${events.at(-1).t.slice(0, 10)}\n`)

  console.log(
    table(
      [['total', 'entrada', 'saída', 'cache lido', 'cache escrito', 'respostas', 'sessões']],
      [[fmt(total.total), fmt(total.in), fmt(total.out), fmt(total.cr), fmt(total.cw), total.n, new Set(events.map((e) => e.s)).size]],
    ),
  )

  const sessionOf = (ev) => sessions[ev.s] || {}
  section('Por máquina', events, (ev) => ev.machine, total, opts.top)
  section('Por assunto', events, (ev) => sessionOf(ev).topic || '(não classificado)', total, opts.top)
  section('Por projeto', events, (ev) => sessionOf(ev).project || '(desconhecido)', total, opts.top)
  section('Por modelo', events, (ev) => ev.m, total, opts.top)
  section('Conversa principal x subagentes', events, (ev) => (ev.agent ? 'subagentes' : 'principal'), total, opts.top)

  // Uma resposta pode usar várias ferramentas; os tokens dela contam para cada uma.
  const toolEvents = events.flatMap((ev) => (ev.tools || []).map((tool) => ({ ...ev, tool })))
  if (toolEvents.length) {
    section('Por ferramenta (respostas que a usaram; as linhas se sobrepõem)', toolEvents, (ev) => ev.tool, total, opts.top)
  }

  hours(events)
  topSessions(events, sessions, opts.top)
}

function parseArgs(args) {
  const opts = { days: 30, top: 10, machine: null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') opts.days = Number(args[++i])
    else if (args[i] === '--all') opts.days = 0
    else if (args[i] === '--top') opts.top = Number(args[++i])
    else if (args[i] === '--machine') opts.machine = args[++i]
    else throw new Error(`opção desconhecida: ${args[i]} (use --days N, --all, --top N, --machine NOME)`)
  }
  if (!Number.isFinite(opts.days) || !Number.isFinite(opts.top)) throw new Error('--days e --top precisam de um número')
  return opts
}

function sum(events) {
  const acc = { in: 0, out: 0, cr: 0, cw: 0, n: 0 }
  for (const ev of events) {
    acc.in += ev.in
    acc.out += ev.out
    acc.cr += ev.cr
    acc.cw += ev.cw
    acc.n++
  }
  acc.total = acc.in + acc.out + acc.cr + acc.cw
  return acc
}

function groupBy(events, keyFn) {
  const groups = new Map()
  for (const ev of events) {
    const key = keyFn(ev)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(ev)
  }
  return [...groups].map(([key, evs]) => ({ key, ...sum(evs) })).sort((a, b) => b.total - a.total)
}

function section(title, events, keyFn, total, top) {
  const groups = groupBy(events, keyFn)
  const rows = groups.slice(0, top).map((g) => [
    g.key,
    fmt(g.total),
    pct(g.total, total.total),
    fmt(g.out),
    fmt(g.cr),
    fmt(g.cw),
    g.n,
  ])
  console.log(`\n${title}`)
  console.log(table([['', 'total', '%', 'saída', 'cache lido', 'cache escrito', 'respostas']], rows))
  if (groups.length > top) console.log(`  … e mais ${groups.length - top}`)
}

function hours(events) {
  const byHour = Array.from({ length: 24 }, () => 0)
  const byDay = Array.from({ length: 7 }, () => 0)
  for (const ev of events) {
    const d = new Date(ev.t) // horário local desta máquina
    const tokens = ev.in + ev.out + ev.cr + ev.cw
    byHour[d.getHours()] += tokens
    byDay[d.getDay()] += tokens
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  console.log(`\nPor horário (${tz})`)
  bars(byHour.map((v, h) => [`${String(h).padStart(2, '0')}h`, v]))
  console.log('\nPor dia da semana')
  bars(byDay.map((v, d) => [DAYS[d], v]))
}

function bars(rows) {
  const max = Math.max(...rows.map(([, v]) => v), 1)
  for (const [label, v] of rows) {
    console.log(`  ${label}  ${'█'.repeat(Math.round((v / max) * 40)).padEnd(40)}  ${v ? fmt(v) : ''}`)
  }
}

function topSessions(events, sessions, top) {
  const rows = groupBy(events, (ev) => ev.s)
    .slice(0, top)
    .map((g) => {
      const s = sessions[g.key] || {}
      return [
        clip(s.title || '(sem título)', 44),
        s.topic || '-',
        clip(s.project || '-', 28),
        s.machine || '-',
        (s.start || '').slice(0, 10),
        fmt(g.total),
        fmt(g.out),
        g.n,
      ]
    })
  console.log(`\nSessões que mais gastaram`)
  console.log(table([['sessão', 'assunto', 'projeto', 'máquina', 'início', 'total', 'saída', 'respostas']], rows, 5))
}

function table(head, rows, textCols = 1) {
  const all = [...head, ...rows].map((r) => r.map(String))
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => r[i].length)))
  // colunas de texto à esquerda; números à direita
  const line = (r) => '  ' + r.map((c, i) => (i < textCols ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  return all.map(line).join('\n')
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function pct(part, whole) {
  return whole ? ((part / whole) * 100).toFixed(1) + '%' : '-'
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
