// Agregações do dashboard. Este arquivo roda em dois lugares: no Node (testes e `encode`)
// e dentro da página, onde é embutido sem os `export`. Por isso não importa nada.

export const TOKEN_TYPES = ['in', 'out', 'cr', 'cw']
export const NO_TOPIC = '(não classificado)'
export const NO_TITLE = '(sem título)'
export const NO_PROJECT = '(sem projeto)'

/** Compacta o resultado de `loadAll()`: tabelas de nomes + uma linha (array) por evento. */
export function encode({ events, sessions, machines }) {
  const table = (seed = []) => {
    const list = [...seed]
    const index = new Map(list.map((v, i) => [v, i]))
    return {
      list,
      of(v) {
        if (v == null) return -1
        if (!index.has(v)) index.set(v, list.push(v) - 1)
        return index.get(v)
      },
    }
  }
  const mach = table(machines)
  const models = table()
  const tools = table()
  const skills = table()
  const mcps = table()

  const sessionIndex = new Map()
  const sessionRows = []
  const sessionOf = (sid, machine) => {
    if (!sessionIndex.has(sid)) {
      const s = sessions[sid] || {}
      sessionIndex.set(sid, sessionRows.length)
      sessionRows.push([
        s.title || null,
        s.topic || null,
        s.project || null,
        mach.of(s.machine || machine),
        s.start || null,
        s.end || null,
      ])
    }
    return sessionIndex.get(sid)
  }

  const rows = events.map((ev) => [
    sessionOf(ev.s, ev.machine),
    Date.parse(ev.t),
    models.of(ev.m),
    ev.in || 0,
    ev.out || 0,
    ev.cr || 0,
    ev.cw || 0,
    mach.of(ev.machine),
    ev.agent ? 1 : 0,
    skills.of(ev.skill),
    mcps.of(ev.mcp),
    (ev.tools || []).map((t) => tools.of(t)),
  ])

  return {
    machines: mach.list,
    models: models.list,
    tools: tools.list,
    skills: skills.list,
    mcps: mcps.list,
    sessions: sessionRows,
    events: rows,
  }
}

export function decode(data) {
  const sessions = data.sessions.map(([title, topic, project, machine, start, end]) => ({
    title: title || NO_TITLE,
    topic: topic || NO_TOPIC,
    project: project || NO_PROJECT,
    machine: data.machines[machine],
    start: start ? Date.parse(start) : null,
    end: end ? Date.parse(end) : null,
  }))
  const events = data.events.map((r) => ({
    s: r[0],
    ts: r[1],
    m: data.models[r[2]],
    in: r[3],
    out: r[4],
    cr: r[5],
    cw: r[6],
    total: r[3] + r[4] + r[5] + r[6],
    machine: data.machines[r[7]],
    agent: r[8] === 1,
    skill: r[9] < 0 ? null : data.skills[r[9]],
    mcp: r[10] < 0 ? null : data.mcps[r[10]],
    tools: r[11].map((i) => data.tools[i]),
  }))
  return { events, sessions, machines: data.machines }
}

export function bucket() {
  return { in: 0, out: 0, cr: 0, cw: 0, total: 0, n: 0 }
}

export function add(b, ev) {
  b.in += ev.in
  b.out += ev.out
  b.cr += ev.cr
  b.cw += ev.cw
  b.total += ev.total
  b.n++
  return b
}

/** `from` inclusivo e `to` exclusivo, em ms; `machine` vazio = todas. */
export function filterEvents(events, { from = null, to = null, machine = '' } = {}) {
  return events.filter(
    (ev) =>
      (from == null || ev.ts >= from) && (to == null || ev.ts < to) && (!machine || ev.machine === machine),
  )
}

export function totals(events) {
  const all = bucket()
  const agent = bucket()
  const sessions = new Set()
  for (const ev of events) {
    add(all, ev)
    if (ev.agent) add(agent, ev)
    sessions.add(ev.s)
  }
  return { ...all, sessions: sessions.size, agent }
}

/**
 * Agrupa por chave. `keyFn` pode devolver uma lista (ferramentas): aí o evento inteiro
 * entra em cada chave e a soma dos grupos passa do total. `null`/lista vazia = fora.
 */
export function groupBy(events, keyFn) {
  const groups = new Map()
  for (const ev of events) {
    const k = keyFn(ev)
    if (k == null) continue
    for (const key of Array.isArray(k) ? k : [k]) {
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { key, ...bucket(), seen: new Set() }))
      add(g, ev)
      g.seen.add(ev.s)
    }
  }
  return [...groups.values()].map(({ seen, ...g }) => ({ ...g, sessions: seen.size }))
}

export function sortBy(rows, measure) {
  return rows.sort((a, b) => b[measure] - a[measure] || String(a.key).localeCompare(String(b.key)))
}

/** Início (ms, fuso local) do dia/semana/mês que contém `ts`. Semana começa na segunda. */
export function periodStart(ts, unit) {
  const d = new Date(ts)
  if (unit === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const back = unit === 'week' ? (d.getDay() + 6) % 7 : 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()
}

function nextPeriod(start, unit) {
  const d = new Date(start)
  if (unit === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (unit === 'week' ? 7 : 1)).getTime()
}

export function pickUnit(minTs, maxTs) {
  const days = (maxTs - minTs) / 86400000
  return days <= 62 ? 'day' : days <= 400 ? 'week' : 'month'
}

/** Série temporal no fuso local, sem buracos: [{ start, total: bucket, series: { chave: bucket } }]. */
export function timeSeries(events, keyFn, unit) {
  if (!events.length) return { unit: unit || 'day', points: [] }
  let min = Infinity
  let max = -Infinity
  for (const ev of events) {
    if (ev.ts < min) min = ev.ts
    if (ev.ts > max) max = ev.ts
  }
  unit ||= pickUnit(min, max)
  const points = new Map()
  const last = periodStart(max, unit)
  for (let t = periodStart(min, unit); t <= last; t = nextPeriod(t, unit)) {
    points.set(t, { start: t, total: bucket(), series: {} })
  }
  for (const ev of events) {
    const p = points.get(periodStart(ev.ts, unit))
    add(p.total, ev)
    const key = keyFn(ev)
    add((p.series[key] ||= bucket()), ev)
  }
  return { unit, points: [...points.values()] }
}

/** Matriz [dia da semana][hora] no fuso local. Linha 0 = segunda, 6 = domingo. */
export function heatmap(events) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, bucket))
  for (const ev of events) {
    const d = new Date(ev.ts)
    add(grid[(d.getDay() + 6) % 7][d.getHours()], ev)
  }
  return grid
}

/** Uma linha por sessão com eventos no filtro; os tokens são só os do filtro. */
export function sessionRows(events, sessions) {
  const rows = new Map()
  for (const ev of events) {
    let r = rows.get(ev.s)
    if (!r) {
      const s = sessions[ev.s]
      const dur = s.start != null && s.end != null ? s.end - s.start : 0
      rows.set(ev.s, (r = { ...s, machine: s.machine || ev.machine, dur, ...bucket() }))
    }
    add(r, ev)
  }
  return [...rows.values()]
}

/** Teto "redondo" para o eixo e o passo entre as marcas. */
export function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 1 }
  const raw = max / ticks
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) * pow
  return { max: Math.ceil(max / step) * step, step }
}
