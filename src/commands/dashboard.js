import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { encode } from '../dashboard/core.js'
import { HOME } from '../paths.js'
import { loadAll } from '../store.js'

const ASSETS = path.join(import.meta.dirname, '..', 'dashboard')

export default async function dashboard(args) {
  const { out, open } = parseArgs(args)
  const data = loadAll()
  if (!data.events.length) throw new Error('nenhum dado encontrado. Rode "ptm collect" primeiro.')

  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buildHtml(data))

  const sessions = new Set(data.events.map((ev) => ev.s)).size
  console.log(`Dashboard gerado: ${out}`)
  console.log(`${data.events.length} respostas, ${sessions} sessões, ${data.machines.length} máquina(s).`)
  if (open) openFile(out)
}

function parseArgs(args) {
  // por padrão o arquivo fica junto dos dados, nunca dentro do repositório (que é público)
  let out = path.join(HOME, 'dashboard.html')
  let open = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-open') open = false
    else if (arg === '--out' || arg === '-o') out = args[++i]
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else throw new Error(`opção desconhecida: ${arg}. Use --out <arquivo> e/ou --no-open.`)
  }
  if (!out) throw new Error('--out precisa de um caminho.')
  return { out: path.resolve(out), open }
}

/** Monta a página inteira em uma string: CSS, dados e JS embutidos, sem nenhuma requisição. */
export function buildHtml(data, generatedAt = new Date().toISOString()) {
  const read = (name) => fs.readFileSync(path.join(ASSETS, name), 'utf8')
  // core.js é um módulo no Node; na página vira script comum, então saem os `export`
  const script = `${read('core.js').replace(/^export /gm, '')}\n${read('app.js')}`
  const json = JSON.stringify({ generatedAt, ...encode(data) })
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>projetct-m · tokens do Claude Code</title>',
    `<style>\n${read('style.css')}</style>`,
    '</head>',
    '<body>',
    BODY,
    // `<` escapado: nenhum título de sessão consegue fechar a tag ou abrir outra
    `<script type="application/json" id="ptm-data">${json.replace(/</g, '\\u003c')}</script>`,
    `<script>\n(() => {\n'use strict'\n${script.replace(/<\/script/gi, '<\\/script')}\n})()\n</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function openFile(file) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : ['xdg-open', [file]]
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', () => console.error(`Não consegui abrir o navegador; abra o arquivo manualmente.`))
  child.unref()
}

const measures = [
  ['total', 'Total'],
  ['in', 'Entrada'],
  ['out', 'Saída'],
  ['cr', 'Cache lido'],
  ['cw', 'Cache escrito'],
]

const barCard = (id, title, extra = '') => `
      <section class="card">
        <div class="card-head"><div><h3>${title}</h3>${extra}</div></div>
        <div id="${id}"></div>
      </section>`

const BODY = `<main>
  <header class="top">
    <div>
      <h1>Tokens do Claude Code</h1>
      <p class="sub" id="subtitle"></p>
    </div>
    <button class="btn small" id="theme" type="button">Claro/escuro</button>
  </header>

  <div class="filters" role="group" aria-label="Filtros">
    <div class="field">
      <span>Período</span>
      <div class="row">
        <div class="seg">
          <button type="button" data-preset="7">7d</button>
          <button type="button" data-preset="30">30d</button>
          <button type="button" data-preset="all">Tudo</button>
        </div>
        <input type="date" id="from" aria-label="De">
        <span class="muted">até</span>
        <input type="date" id="to" aria-label="Até">
      </div>
    </div>
    <label class="field">
      <span>Máquina</span>
      <select id="machine"><option value="">Todas</option></select>
    </label>
    <div class="field">
      <span>Medida dos gráficos</span>
      <div class="seg">
        ${measures.map(([k, label]) => `<button type="button" data-measure="${k}">${label}</button>`).join('\n        ')}
      </div>
    </div>
  </div>

  <h2>Visão geral</h2>
  <div class="kpis" id="kpis"></div>
  <p class="note" id="kpi-note"></p>

  <h2>Quando</h2>
  <div class="stack">
    <section class="card">
      <div class="card-head">
        <div>
          <h3 id="time-title"></h3>
          <p class="note">7d e 30d contam a partir do último dia com dados. Dias no horário local deste navegador.</p>
        </div>
        <div class="tools">
          <div class="seg" role="group" aria-label="Dividir por">
            <button type="button" data-split="model">Por modelo</button>
            <button type="button" data-split="machine">Por máquina</button>
          </div>
          <button class="btn small" type="button" data-table="time">Ver tabela</button>
        </div>
      </div>
      <div class="legend" id="time-legend"></div>
      <div class="chart" id="time-chart"></div>
    </section>
    <section class="card">
      <div class="card-head">
        <div>
          <h3 id="heat-title"></h3>
          <p class="note" id="heat-note"></p>
        </div>
        <div class="tools"><button class="btn small" type="button" data-table="heat">Ver tabela</button></div>
      </div>
      <div id="heat-chart"></div>
    </section>
  </div>

  <h2>Onde e em quê</h2>
  <div class="grid">
    ${barCard('by-machine', 'Por máquina')}
    ${barCard('by-topic', 'Por assunto', '<p class="note" id="topic-hint" hidden>Nenhuma sessão classificada ainda. Rode <code>ptm classify</code> e gere o dashboard de novo.</p>')}
    ${barCard('by-project', 'Por projeto')}
    ${barCard('by-model', 'Por modelo')}
  </div>

  <h2>O que custa mais</h2>
  <div class="stack">
    <section class="card">
      <div class="card-head"><div><h3>Sessões</h3><p class="note" id="sessions-note"></p></div></div>
      <div id="sessions"></div>
    </section>
    <div class="grid">
      ${barCard('by-agent', 'Conversa principal × subagentes')}
      ${barCard('by-tool', 'Respostas que usaram a ferramenta', '<p class="note" id="tool-note"></p>')}
      ${barCard('by-skill', 'Por skill', '<p class="note" id="skill-note"></p>')}
      ${barCard('by-mcp', 'Por servidor MCP', '<p class="note" id="mcp-note"></p>')}
    </div>
  </div>
</main>
<div id="tip" role="status" hidden></div>`
