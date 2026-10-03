// Código da página. É embutido no HTML logo depois de core.js, então as funções de lá
// (decode, filterEvents, groupBy, ...) já existem aqui como globais.

const RAW = JSON.parse(document.getElementById('ptm-data').textContent)
const DATA = decode(RAW)

const MEASURE = { total: 'Total', in: 'Entrada', out: 'Saída', cr: 'Cache lido', cw: 'Cache escrito' }
const UNIT = { day: 'dia', week: 'semana', month: 'mês' }
const DAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
const DAYS_LONG = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']
const OTHER = 'Outros'
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'

const nfCompact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
const nfFull = new Intl.NumberFormat('pt-BR')
const nfPct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 })
const dfShort = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' })
const dfMonth = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' })
const dfLong = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
const dfDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
const dfStamp = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const compact = (v) => nfCompact.format(v)
const full = (v) => nfFull.format(v)
const pct = (v, total) => (!(total > 0) ? '–' : v > 0 && v / total < 0.001 ? '< 0,1%' : nfPct.format(v / total))
const $ = (id) => document.getElementById(id)

function h(tag, attrs, ...kids) {
  return fill(document.createElement(tag), attrs, kids)
}

function svg(tag, attrs, ...kids) {
  return fill(document.createElementNS('http://www.w3.org/2000/svg', tag), attrs, kids)
}

// Nomes vêm dos dados (títulos, projetos, ferramentas): sempre como texto, nunca innerHTML.
function fill(el, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid)
  return el
}

function duration(ms) {
  const min = Math.round(ms / 60000)
  if (min < 1) return '< 1min'
  if (min < 60) return `${min}min`
  const hours = Math.floor(min / 60)
  if (hours < 48) return `${hours}h ${String(min % 60).padStart(2, '0')}min`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function toInput(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fromInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null
}

function addDays(ts, days) {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

function periodLabel(start, unit) {
  if (unit === 'month') return dfMonth.format(start)
  if (unit === 'week') return `semana de ${dfDate.format(start)}`
  return dfLong.format(start)
}

// ---------------------------------------------------------------- estado

const bounds = (() => {
  let min = Infinity
  let max = -Infinity
  for (const ev of DATA.events) {
    if (ev.ts < min) min = ev.ts
    if (ev.ts > max) max = ev.ts
  }
  return { min: periodStart(min, 'day'), max: periodStart(max, 'day') }
})()

const state = {
  preset: 'all',
  from: bounds.min,
  to: bounds.max,
  machine: '',
  measure: 'total',
  split: 'model',
  sort: { col: 'total', dir: -1 },
  limit: 20,
  expanded: {},
  tables: {},
}

// A cor acompanha a entidade, não a posição: é decidida uma vez, sobre todos os dados,
// e não muda quando o filtro muda. Da 8ª em diante vira "Outros".
function assignSlots(keyFn) {
  const slots = new Map()
  sortBy(groupBy(DATA.events, keyFn), 'total').forEach((g, i) => slots.set(g.key, i < 7 ? i + 1 : 0))
  return slots
}
const SPLIT = {
  model: { key: (ev) => ev.m, slots: assignSlots((ev) => ev.m), label: 'modelo' },
  machine: { key: (ev) => ev.machine, slots: assignSlots((ev) => ev.machine), label: 'máquina' },
}
const slotColor = (slot) => (slot ? `var(--s${slot})` : 'var(--other)')

function currentEvents() {
  return filterEvents(DATA.events, { from: state.from, to: addDays(state.to, 1), machine: state.machine })
}

// ---------------------------------------------------------------- tooltip

const tip = $('tip')

function showTip(x, y, nodes) {
  tip.replaceChildren(...nodes)
  tip.hidden = false
  const r = tip.getBoundingClientRect()
  let left = x + 14
  if (left + r.width > innerWidth - 8) left = x - r.width - 14
  let top = y + 14
  if (top + r.height > innerHeight - 8) top = y - r.height - 14
  tip.style.left = `${Math.max(8, left)}px`
  tip.style.top = `${Math.max(8, top)}px`
}

function hideTip() {
  tip.hidden = true
}

/** `rows`: { label, value, color? } ou '-' para um separador. O valor vem em destaque. */
function tipNodes(title, rows) {
  return [
    h('div', { class: 'tip-title' }, title),
    ...rows.map((r) =>
      r === '-'
        ? h('div', { class: 'tip-sep' })
        : h(
            'div',
            { class: 'tip-row' },
            h('span', { class: 'tip-key' }, r.color && h('i', { style: `background:${r.color}` }), r.label),
            h('b', null, r.value),
          ),
    ),
  ]
}

function tipFor(el, build, onToggle) {
  const at = (e) => {
    onToggle?.(true)
    showTip(e.clientX, e.clientY, build())
  }
  el.addEventListener('pointerenter', at)
  el.addEventListener('pointermove', at)
  el.addEventListener('pointerleave', (e) => {
    onToggle?.(false)
    // no toque o dedo sai logo depois de encostar; o tooltip fica até o próximo toque ou rolagem
    if (e.pointerType !== 'touch') hideTip()
  })
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect()
    showTip(r.left + Math.min(r.width, 160), r.top + r.height / 2, build())
  })
  el.addEventListener('blur', hideTip)
}

addEventListener('scroll', hideTip, { capture: true, passive: true })

function bucketRows(b) {
  return [
    ...['in', 'out', 'cr', 'cw'].map((k) => ({ label: MEASURE[k], value: full(b[k]) })),
    { label: 'Total', value: full(b.total) },
    '-',
    { label: 'Respostas', value: full(b.n) },
    b.sessions != null && { label: 'Sessões', value: full(b.sessions) },
  ].filter(Boolean)
}

// ---------------------------------------------------------------- KPIs

function renderKpis(t) {
  const m = state.measure
  const tile = (label, value, detail, measure) =>
    h(
      measure ? 'button' : 'div',
      {
        class: 'kpi',
        type: measure && 'button',
        'aria-pressed': measure && String(measure === m),
        title: measure && `Usar "${label}" como medida dos gráficos`,
        onclick: measure && (() => setMeasure(measure)),
      },
      h('span', { class: 'label' }, label),
      h('span', { class: 'value' }, value),
      h('span', { class: 'detail' }, detail),
    )
  $('kpis').replaceChildren(
    tile('Tokens (total)', compact(t.total), full(t.total), 'total'),
    ...['in', 'out', 'cr', 'cw'].map((k) => tile(MEASURE[k], compact(t[k]), `${pct(t[k], t.total)} do total`, k)),
    tile('Sessões', full(t.sessions), t.sessions ? `${compact(t[m] / t.sessions)} por sessão` : ''),
    tile('Respostas', full(t.n), t.n ? `${compact(t[m] / t.n)} por resposta` : ''),
    tile('Subagentes', pct(t.agent[m], t[m]), `${compact(t.agent[m])} · ${full(t.agent.n)} respostas`),
  )
  $('kpi-note').textContent =
    m === 'total'
      ? 'Médias e a fatia dos subagentes usam o total de tokens. Clique num tipo para mudar a medida.'
      : `Médias e a fatia dos subagentes usam a medida "${MEASURE[m]}".`
}

// ---------------------------------------------------------------- tokens ao longo do tempo

function renderTime(events) {
  const m = state.measure
  const split = SPLIT[state.split]
  const nameOf = (ev) => (split.slots.get(split.key(ev)) ? split.key(ev) : OTHER)
  const ts = timeSeries(events, nameOf)
  const series = [...split.slots].filter(([, slot]) => slot).map(([key, slot]) => ({ key, color: slotColor(slot) }))
  series.push({ key: OTHER, color: slotColor(0) })
  const present = series.filter((s) => ts.points.some((p) => p.series[s.key]?.[m] > 0))

  $('time-title').textContent = `${MEASURE[m]} por ${UNIT[ts.unit]}, por ${split.label}`
  $('time-legend').replaceChildren(
    ...(present.length > 1
      ? present.map((s) => h('span', null, h('i', { class: 'swatch', style: `background:${s.color}` }), s.key))
      : []),
  )
  const box = $('time-chart')
  if (!ts.points.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Sem dados neste filtro.'))

  if (state.tables.time) {
    return box.replaceChildren(
      table(
        ['Período', ...present.map((s) => s.key), 'Total'],
        ts.points.map((p) => [
          periodLabel(p.start, ts.unit),
          ...present.map((s) => full(p.series[s.key]?.[m] || 0)),
          full(p.total[m]),
        ]),
      ),
    )
  }

  const W = Math.max(box.clientWidth, 260)
  const H = 264
  const pad = { l: 46, r: 8, t: 20, b: 24 }
  const plotW = W - pad.l - pad.r
  const plotH = H - pad.t - pad.b
  const scale = niceScale(Math.max(...ts.points.map((p) => p.total[m])))
  const y = (v) => pad.t + plotH - (v / scale.max) * plotH
  const band = plotW / ts.points.length
  const bw = band >= 4 ? Math.min(24, band - 2) : band * 0.75
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': $('time-title').textContent })

  for (let v = 0; v <= scale.max + scale.step / 2; v += scale.step) {
    root.append(
      svg('line', { class: v === 0 ? 'baseline' : 'gridline', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }),
      svg('text', { x: pad.l - 6, y: y(v), dy: '0.32em', 'text-anchor': 'end' }, compact(v)),
    )
  }

  const peak = ts.points.reduce((a, b) => (b.total[m] > a.total[m] ? b : a))
  const every = Math.ceil(46 / band)
  ts.points.forEach((p, i) => {
    const x = pad.l + i * band + (band - bw) / 2
    const parts = present.map((s) => ({ ...s, v: p.series[s.key]?.[m] || 0 })).filter((s) => s.v > 0)
    let acc = 0
    parts.forEach((s, j) => {
      const bottom = y(acc)
      acc += s.v
      const top = y(acc)
      // 2px da cor do fundo separam os segmentos; a ponta arredondada fica só no topo da pilha
      const base = j > 0 && bottom - top > 3 ? bottom - 2 : bottom
      const r = j === parts.length - 1 ? Math.min(4, bw / 2, base - top) : 0
      root.append(
        svg('path', {
          fill: s.color,
          d: `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z`,
        }),
      )
    })
    if (i % every === 0) {
      const label = ts.unit === 'month' ? dfMonth.format(p.start) : dfShort.format(p.start)
      root.append(svg('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }, label))
    }
    if (p === peak && p.total[m] > 0) {
      const cx = x + bw / 2
      const anchor = cx < pad.l + 30 ? 'start' : cx > W - pad.r - 30 ? 'end' : 'middle'
      root.append(svg('text', { class: 'peak', x: cx, y: y(p.total[m]) - 6, 'text-anchor': anchor }, compact(p.total[m])))
    }
    const hit = svg('rect', { class: 'hit', x: pad.l + i * band, y: pad.t, width: band, height: plotH })
    tipFor(
      hit,
      () =>
        tipNodes(periodLabel(p.start, ts.unit), [
          ...parts.map((s) => ({ label: s.key, value: full(s.v), color: s.color })).reverse(),
          parts.length > 1 && '-',
          { label: `${MEASURE[m]}${parts.length > 1 ? ' (soma)' : ''}`, value: full(p.total[m]) },
          { label: 'Respostas', value: full(p.total.n) },
        ].filter(Boolean)),
      (on) => hit.classList.toggle('on', on),
    )
    root.append(hit)
  })
  box.replaceChildren(root)
}

// ---------------------------------------------------------------- hora × dia da semana

function renderHeat(events) {
  const m = state.measure
  const grid = heatmap(events)
  let max = 0
  let peak = null
  grid.forEach((row, d) =>
    row.forEach((b, hour) => {
      if (b[m] > max) {
        max = b[m]
        peak = { d, hour }
      }
    }),
  )
  const total = events.reduce((sum, ev) => sum + ev[m], 0)
  $('heat-title').textContent = `${MEASURE[m]} por hora do dia e dia da semana`
  $('heat-note').textContent = peak
    ? `Pico: ${DAYS_LONG[peak.d]}, ${peak.hour}h–${peak.hour + 1}h (${compact(max)}, ${pct(max, total)} do período). Horário local deste navegador (${TZ}).`
    : `Horário local deste navegador (${TZ}).`
  const box = $('heat-chart')
  if (!max) return box.replaceChildren(h('p', { class: 'empty' }, 'Sem dados neste filtro.'))

  if (state.tables.heat) {
    return box.replaceChildren(
      table(
        ['Hora', ...DAYS],
        Array.from({ length: 24 }, (_, hour) => [`${hour}h`, ...grid.map((row) => compact(row[hour][m]))]),
      ),
    )
  }

  const cells = [h('span', { class: 'lab' })]
  for (let hour = 0; hour < 24; hour++) cells.push(h('span', { class: 'lab hour' }, hour % 3 === 0 ? `${hour}h` : ''))
  grid.forEach((row, d) => {
    cells.push(h('span', { class: 'lab' }, DAYS[d]))
    row.forEach((b, hour) => {
      const v = b[m]
      const bin = v > 0 ? Math.min(6, Math.ceil((v / max) * 6)) : 0
      const cell = h('div', {
        class: `cell b${bin}`,
        role: 'img',
        'aria-label': `${DAYS_LONG[d]} ${hour}h: ${full(v)}`,
      })
      tipFor(cell, () =>
        tipNodes(`${DAYS_LONG[d]}, ${hour}h–${hour + 1}h`, [
          { label: MEASURE[m], value: full(v) },
          { label: 'Respostas', value: full(b.n) },
        ]),
      )
      cells.push(cell)
    })
  })
  box.replaceChildren(
    h('div', { class: 'heat' }, cells),
    h(
      'div',
      { class: 'scale' },
      '0',
      [0, 1, 2, 3, 4, 5, 6].map((i) => h('i', { class: `b${i}` })),
      compact(max),
    ),
  )
}

// ---------------------------------------------------------------- listas de barras

function renderBars(id, groups, total, emptyText = 'Sem dados neste filtro.') {
  const m = state.measure
  const rows = sortBy(groups.filter((g) => g[m] > 0), m)
  const box = $(id)
  if (!rows.length) return box.replaceChildren(h('p', { class: 'empty' }, emptyText))
  const max = rows[0][m]
  const limit = 8
  const shown = state.expanded[id] ? rows : rows.slice(0, limit)
  const list = h(
    'ul',
    { class: 'bars' },
    shown.map((g) => {
      const li = h(
        'li',
        { tabindex: 0 },
        h(
          'div',
          { class: 'bar-head' },
          h('span', { class: 'bar-label' }, g.key),
          h('span', { class: 'bar-val' }, h('b', null, compact(g[m])), ' ', h('span', { class: 'muted' }, pct(g[m], total))),
        ),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${(g[m] / max) * 100}%` })),
      )
      tipFor(li, () => tipNodes(g.key, bucketRows(g)))
      return li
    }),
  )
  const more =
    rows.length > limit &&
    h(
      'button',
      {
        class: 'btn small more',
        type: 'button',
        onclick: () => {
          state.expanded[id] = !state.expanded[id]
          render()
        },
      },
      state.expanded[id] ? `Mostrar só os ${limit} maiores` : `Mostrar todos (${rows.length})`,
    )
  box.replaceChildren(list, more || '')
}

function sumWhere(events, test) {
  let sum = 0
  for (const ev of events) if (test(ev)) sum += ev[state.measure]
  return sum
}

function renderBreakdowns(events, t) {
  const m = state.measure
  const total = t[m]
  const label = MEASURE[m].toLowerCase()
  const session = (ev) => DATA.sessions[ev.s]

  renderBars('by-machine', groupBy(events, (ev) => ev.machine), total)
  renderBars('by-topic', groupBy(events, (ev) => session(ev).topic), total)
  renderBars('by-project', groupBy(events, (ev) => session(ev).project), total)
  renderBars('by-model', groupBy(events, (ev) => ev.m), total)
  renderBars('by-agent', groupBy(events, (ev) => (ev.agent ? 'Subagentes' : 'Conversa principal')), total)
  renderBars('by-tool', groupBy(events, (ev) => ev.tools), total, 'Nenhuma resposta usou ferramenta neste filtro.')
  renderBars('by-skill', groupBy(events, (ev) => ev.skill), total, 'Nenhuma resposta atribuída a skill neste filtro.')
  renderBars('by-mcp', groupBy(events, (ev) => ev.mcp), total, 'Nenhuma resposta atribuída a servidor MCP neste filtro.')

  $('topic-hint').hidden = !DATA.sessions.every((s) => s.topic === NO_TOPIC)
  $('tool-note').textContent =
    `Tokens (${label}) das respostas que usaram cada ferramenta. Uma resposta com várias ferramentas entra inteira ` +
    `em cada uma, então as barras não somam 100%. ${pct(sumWhere(events, (ev) => ev.tools.length), total)} ` +
    `veio de respostas com alguma ferramenta.`
  $('skill-note').textContent =
    `${pct(sumWhere(events, (ev) => ev.skill), total)} de "${label}" veio de respostas atribuídas a uma skill; ` +
    `o resto não aparece aqui.`
  $('mcp-note').textContent =
    `${pct(sumWhere(events, (ev) => ev.mcp), total)} de "${label}" veio de respostas atribuídas a um servidor MCP; ` +
    `o resto não aparece aqui.`
}

// ---------------------------------------------------------------- sessões

const COLUMNS = [
  { key: 'title', label: 'Sessão', cls: 'title' },
  { key: 'topic', label: 'Assunto' },
  { key: 'project', label: 'Projeto' },
  { key: 'machine', label: 'Máquina' },
  { key: 'start', label: 'Início', num: true, cls: 'nowrap', show: (v) => (v == null ? '–' : dfStamp.format(v)) },
  { key: 'dur', label: 'Duração', num: true, hint: 'Do primeiro ao último registro da sessão', show: duration },
  { key: 'n', label: 'Respostas', num: true, show: full },
  ...['in', 'out', 'cr', 'cw', 'total'].map((key) => ({ key, label: MEASURE[key], num: true, show: compact, exact: true })),
]

function renderSessions(events) {
  const { col, dir } = state.sort
  const column = COLUMNS.find((c) => c.key === col)
  const rows = sessionRows(events, DATA.sessions).sort((a, b) =>
    column.num
      ? ((a[col] ?? 0) - (b[col] ?? 0)) * dir || b.total - a.total
      : String(a[col]).localeCompare(String(b[col]), 'pt-BR') * dir || b.total - a.total,
  )
  const shown = rows.slice(0, state.limit)
  $('sessions-note').textContent = rows.length
    ? `${full(rows.length)} sessões no filtro, mostrando ${full(shown.length)}. Os tokens contam só as respostas dentro do filtro; clique num cabeçalho para ordenar.`
    : ''
  if (!rows.length) return $('sessions').replaceChildren(h('p', { class: 'empty' }, 'Sem sessões neste filtro.'))

  const head = COLUMNS.map((c) =>
    h(
      'th',
      {
        class: c.num && c.key !== 'start' ? 'num' : null,
        'aria-sort': c.key === col ? (dir > 0 ? 'ascending' : 'descending') : null,
        title: c.hint,
      },
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            state.sort = c.key === col ? { col, dir: -dir } : { col: c.key, dir: c.num ? -1 : 1 }
            renderSessions(currentEvents())
          },
        },
        c.label,
        c.key === col ? (dir > 0 ? ' ↑' : ' ↓') : '',
      ),
    ),
  )
  const body = shown.map((r) =>
    h(
      'tr',
      null,
      COLUMNS.map((c) =>
        h(
          'td',
          {
            class: [c.cls, c.num && c.key !== 'start' ? 'num' : ''].filter(Boolean).join(' ') || null,
            title: c.exact ? full(r[c.key]) : null,
          },
          c.show ? c.show(r[c.key]) : r[c.key],
        ),
      ),
    ),
  )
  $('sessions').replaceChildren(
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, head)), h('tbody', null, body))),
    rows.length > shown.length &&
      h(
        'button',
        {
          class: 'btn small more',
          type: 'button',
          onclick: () => {
            state.limit += 20
            renderSessions(currentEvents())
          },
        },
        `Mostrar mais (${full(rows.length - shown.length)} restantes)`,
      ) || '',
  )
}

function table(head, rows) {
  return h(
    'div',
    { class: 'table-wrap', style: 'max-height:340px' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: i ? 'num' : null }, c)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : 'nowrap' }, c))))),
    ),
  )
}

// ---------------------------------------------------------------- controles

function setMeasure(measure) {
  state.measure = measure
  state.sort = { col: measure, dir: -1 }
  render()
}

function setPreset(preset) {
  state.preset = preset
  state.to = bounds.max
  state.from = preset === 'all' ? bounds.min : Math.max(bounds.min, addDays(bounds.max, 1 - Number(preset)))
  render()
}

function syncControls() {
  for (const b of document.querySelectorAll('[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset))
  for (const b of document.querySelectorAll('[data-measure]')) b.setAttribute('aria-pressed', String(b.dataset.measure === state.measure))
  for (const b of document.querySelectorAll('[data-split]')) b.setAttribute('aria-pressed', String(b.dataset.split === state.split))
  for (const b of document.querySelectorAll('[data-table]')) b.textContent = state.tables[b.dataset.table] ? 'Ver gráfico' : 'Ver tabela'
  $('from').value = toInput(state.from)
  $('to').value = toInput(state.to)
}

function render() {
  hideTip()
  syncControls()
  const events = currentEvents()
  const t = totals(events)
  renderKpis(t)
  renderTime(events)
  renderHeat(events)
  renderBreakdowns(events, t)
  renderSessions(events)
}

function init() {
  const machines = DATA.machines.length
  $('subtitle').textContent =
    `${machines} ${machines === 1 ? 'máquina' : 'máquinas'} · dados de ${dfDate.format(bounds.min)} a ${dfDate.format(bounds.max)}` +
    ` · gerado em ${dfStamp.format(Date.parse(RAW.generatedAt))}`
  $('machine').append(...DATA.machines.map((name) => h('option', { value: name }, name)))
  for (const input of [$('from'), $('to')]) {
    input.min = toInput(bounds.min)
    input.max = toInput(bounds.max)
    input.addEventListener('change', () => {
      const ts = fromInput(input.value)
      if (ts == null) return syncControls()
      state[input.id] = ts
      if (state.from > state.to) state[input.id === 'from' ? 'to' : 'from'] = ts
      state.preset = ''
      render()
    })
  }
  $('machine').addEventListener('change', (e) => {
    state.machine = e.target.value
    render()
  })
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.preset) setPreset(b.dataset.preset)
    else if (b.dataset.measure) setMeasure(b.dataset.measure)
    else if (b.dataset.split) {
      state.split = b.dataset.split
      render()
    } else if (b.dataset.table) {
      state.tables[b.dataset.table] = !state.tables[b.dataset.table]
      render()
    } else if (b.id === 'theme') {
      const root = document.documentElement
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
      root.dataset.theme = dark ? 'light' : 'dark'
    }
  })
  // o gráfico de tempo é desenhado na largura real do cartão
  let frame = 0
  let width = innerWidth
  addEventListener('resize', () => {
    if (innerWidth === width) return
    width = innerWidth
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => renderTime(currentEvents()))
  })
  render()
}

init()
