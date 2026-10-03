import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { projectName, scanTranscripts } from '../src/parse.js'

const assistant = (id, usage, extra = {}) => ({
  type: 'assistant',
  sessionId: 's1',
  timestamp: '2026-09-01T10:00:00.000Z',
  cwd: '/work/app',
  message: { id, model: 'claude-opus-5', usage, content: [] },
  ...extra,
})

function fixture(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-'))
  fs.mkdirSync(path.join(root, 'proj'))
  fs.writeFileSync(path.join(root, 'proj', 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"trunc')
  return root
}

test('a mesma resposta em várias linhas conta uma vez', async () => {
  const usage = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }
  const root = fixture([
    assistant('msg_1', usage, { message: { id: 'msg_1', model: 'claude-opus-5', usage, content: [{ type: 'tool_use', name: 'Bash' }] } }),
    assistant('msg_1', { ...usage, output_tokens: 120 }),
    assistant('msg_2', usage, { isSidechain: true, cwd: '/elsewhere' }),
  ])
  const { events, sessions } = await scanTranscripts(root)
  assert.equal(events.size, 2)
  assert.deepEqual(events.get('msg_1'), {
    id: 'msg_1', s: 's1', t: '2026-09-01T10:00:00.000Z', m: 'claude-opus-5', in: 2, out: 120, cr: 30, cw: 5, tools: ['Bash'],
  })
  assert.equal(events.get('msg_2').agent, true)
  assert.equal(sessions.get('s1').project, '/work/app')
})

test('título e primeiro prompt humano', async () => {
  const root = fixture([
    { type: 'user', sessionId: 's1', timestamp: '2026-09-01T09:59:00.000Z', cwd: '/work/app', isMeta: true, origin: { kind: 'human' }, message: { content: 'meta' } },
    { type: 'user', sessionId: 's1', timestamp: '2026-09-01T09:59:30.000Z', cwd: '/work/app', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: ' arrume o bug ' }] } },
    { type: 'ai-title', sessionId: 's1', aiTitle: 'antigo' },
    { type: 'ai-title', sessionId: 's1', aiTitle: 'Corrigir bug' },
  ])
  const s = (await scanTranscripts(root)).sessions.get('s1')
  assert.equal(s.title, 'Corrigir bug')
  assert.equal(s.firstPrompt, 'arrume o bug')
  assert.equal(s.start, '2026-09-01T09:59:00.000Z')
})

test('worktrees contam para o projeto de origem', () => {
  assert.equal(projectName('/work/app/.claude/worktrees/fix-1'), '/work/app')
  assert.equal(projectName(path.join(os.homedir(), 'x')), '~/x')
})
