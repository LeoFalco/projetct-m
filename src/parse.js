import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { CLAUDE_PROJECTS } from './paths.js'

/**
 * Lê as transcrições do Claude Code e devolve:
 *   events:   Map<messageId, Event>   uma entrada por resposta da API
 *   sessions: Map<sessionId, Session> metadados da sessão
 *
 * Event   = { id, s, t, m, in, out, cr, cw, agent?, skill?, mcp?, tools? }
 * Session = { title, project, branch, entrypoint, start, end, firstPrompt }
 *
 * `firstPrompt` só existe em memória (para a classificação); nunca é gravado.
 */
export async function scanTranscripts(root = CLAUDE_PROJECTS) {
  const events = new Map()
  const sessions = new Map()
  for (const file of listTranscripts(root)) {
    await scanFile(file, events, sessions)
  }
  return { events, sessions }
}

function listTranscripts(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out
}

async function scanFile(file, events, sessions) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue // linha truncada de uma sessão ainda em andamento
    }
    const sid = entry.sessionId
    if (!sid) continue

    if (entry.type === 'ai-title') {
      session(sessions, sid).title = entry.aiTitle
    } else if (entry.type === 'user') {
      const s = touch(session(sessions, sid), entry)
      if (!s.firstPrompt && !entry.isSidechain && !entry.isMeta && entry.origin?.kind === 'human') {
        const text = promptText(entry.message?.content)
        if (text) s.firstPrompt = text.slice(0, 400)
      }
    } else if (entry.type === 'assistant') {
      touch(session(sessions, sid), entry)
      addEvent(events, entry)
    }
  }
}

function session(sessions, sid) {
  let s = sessions.get(sid)
  if (!s) sessions.set(sid, (s = {}))
  return s
}

function touch(s, entry) {
  const t = entry.timestamp
  if (t) {
    if (!s.start || t < s.start) s.start = t
    if (!s.end || t > s.end) s.end = t
  }
  // subagentes podem rodar em outro diretório; o projeto é o da conversa principal
  if (!entry.isSidechain) {
    if (!s.project && entry.cwd) s.project = projectName(entry.cwd)
    if (!s.branch && entry.gitBranch) s.branch = entry.gitBranch
    if (!s.entrypoint && entry.entrypoint) s.entrypoint = entry.entrypoint
  }
  return s
}

// A mesma resposta é gravada uma vez por bloco de conteúdo, repetindo o `usage`.
// Contar linha a linha dobraria os tokens, então juntamos por id da mensagem.
function addEvent(events, entry) {
  const msg = entry.message
  const u = msg?.usage
  if (!msg?.id || !u || msg.model === '<synthetic>') return

  let ev = events.get(msg.id)
  if (!ev) {
    ev = { id: msg.id, s: entry.sessionId, t: entry.timestamp, m: msg.model, in: 0, out: 0, cr: 0, cw: 0 }
    events.set(msg.id, ev)
  }
  ev.in = Math.max(ev.in, u.input_tokens || 0)
  ev.out = Math.max(ev.out, u.output_tokens || 0)
  ev.cr = Math.max(ev.cr, u.cache_read_input_tokens || 0)
  ev.cw = Math.max(ev.cw, u.cache_creation_input_tokens || 0)
  if (entry.timestamp < ev.t) ev.t = entry.timestamp
  if (entry.isSidechain) ev.agent = true
  if (entry.attributionSkill) ev.skill = entry.attributionSkill
  if (entry.attributionMcpServer) ev.mcp = entry.attributionMcpServer

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.name) continue
      ev.tools ||= []
      if (!ev.tools.includes(block.name)) ev.tools.push(block.name)
    }
  }
}

function promptText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

// "/Users/x/Talk/App/.claude/worktrees/fix-1" -> "~/Talk/App"
export function projectName(cwd) {
  let p = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '')
  const home = os.homedir()
  if (p === home || p.startsWith(home + path.sep)) p = '~' + p.slice(home.length)
  return p
}
