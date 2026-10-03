import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, machineDir } from './paths.js'

// Layout (um diretório por máquina, então duas máquinas nunca editam o mesmo arquivo):
//   data/machines/<máquina>/events-AAAA-MM.jsonl   uma linha por resposta da API
//   data/machines/<máquina>/sessions.json          { sessionId: { title, project, ... } }
//   data/machines/<máquina>/topics.json            { sessionId: "assunto" }

const SESSION_FIELDS = ['title', 'project', 'branch', 'entrypoint', 'start', 'end']

/** Junta o que foi lido agora com o que já estava guardado. Devolve quantos eventos são novos. */
export function mergeMachine(machine, events, sessions) {
  const dir = machineDir(machine)
  fs.mkdirSync(dir, { recursive: true })

  const byMonth = new Map()
  for (const ev of events.values()) {
    const month = ev.t.slice(0, 7)
    if (!byMonth.has(month)) byMonth.set(month, [])
    byMonth.get(month).push(ev)
  }

  let added = 0
  for (const [month, fresh] of byMonth) {
    const file = path.join(dir, `events-${month}.jsonl`)
    const stored = new Map(readJsonl(file).map((ev) => [ev.id, ev]))
    for (const ev of fresh) {
      if (!stored.has(ev.id)) added++
      stored.set(ev.id, ev)
    }
    const sorted = [...stored.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    fs.writeFileSync(file, sorted.map((ev) => JSON.stringify(ev)).join('\n') + '\n')
  }

  // Sessões cujas transcrições já foram apagadas pelo Claude Code continuam guardadas.
  const sessionsFile = path.join(dir, 'sessions.json')
  const stored = readJson(sessionsFile, {})
  for (const [sid, s] of sessions) {
    const prev = stored[sid] || {}
    const next = { ...prev }
    for (const f of SESSION_FIELDS) if (s[f] != null) next[f] = s[f]
    if (prev.start && prev.start < next.start) next.start = prev.start
    if (prev.end && prev.end > next.end) next.end = prev.end
    stored[sid] = next
  }
  writeJson(sessionsFile, stored)
  return added
}

export function readTopics(machine) {
  return readJson(path.join(machineDir(machine), 'topics.json'), {})
}

export function writeTopics(machine, topics) {
  fs.mkdirSync(machineDir(machine), { recursive: true })
  writeJson(path.join(machineDir(machine), 'topics.json'), topics)
}

export function listMachines() {
  try {
    return fs
      .readdirSync(path.join(DATA_DIR, 'machines'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Carrega os dados de todas as máquinas.
 * events: Event[] com `machine` preenchido; sessions: { sessionId: Session & { machine, topic } }
 */
export function loadAll() {
  const events = []
  const sessions = {}
  for (const machine of listMachines()) {
    const dir = machineDir(machine)
    const topics = readTopics(machine)
    for (const [sid, s] of Object.entries(readJson(path.join(dir, 'sessions.json'), {}))) {
      sessions[sid] = { ...s, machine, topic: topics[sid] || null }
    }
    for (const name of fs.readdirSync(dir).sort()) {
      if (!/^events-\d{4}-\d{2}\.jsonl$/.test(name)) continue
      for (const ev of readJsonl(path.join(dir, name))) events.push({ ...ev, machine })
    }
  }
  return { events, sessions, machines: listMachines() }
}

function readJsonl(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
