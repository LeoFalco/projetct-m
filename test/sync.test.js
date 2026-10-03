import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))

// Tudo acontece em diretórios temporários, com um repositório bare local no lugar do GitHub.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-sync-'))
  const remote = path.join(root, 'remote.git')
  spawnSync('git', ['init', '-q', '--bare', remote])
  const machine = (name) => {
    const home = path.join(root, `home-${name}`)
    const dir = path.join(home, 'data', 'machines', name)
    return {
      home,
      dir,
      write(file, content, owner = name) {
        const target = path.join(home, 'data', 'machines', owner)
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, file), content)
      },
      read: (file, owner = name) => fs.readFileSync(path.join(home, 'data', 'machines', owner, file), 'utf8'),
      ptm(...args) {
        const env = { ...process.env, PTM_HOME: home, PTM_MACHINE: name, PTM_SYNC_REMOTE: remote }
        const res = spawnSync(process.execPath, [CLI, 'sync', ...args], { encoding: 'utf8', env })
        return { code: res.status, out: res.stdout + res.stderr }
      },
    }
  }
  const log = () => spawnSync('git', ['log', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }).stdout
  return { root, remote, machine, log }
}

const ev = (id, t) => JSON.stringify({ id, s: 's', t, m: 'x', in: 1, out: 1, cr: 0, cw: 0 })

test('sync sem init explica como configurar', () => {
  const { machine } = sandbox()
  const res = machine('a').ptm()
  assert.equal(res.code, 1)
  assert.match(res.out, /ptm sync --init/)
})

test('duas máquinas trocam métricas pelo repositório', () => {
  const { machine, log } = sandbox()
  const a = machine('a')
  const b = machine('b')

  // a: já tinha dados num diretório comum, remoto vazio
  a.write('sessions.json', '{"s1":{"title":"da a"}}\n')
  let res = a.ptm('--init')
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /vazio/)
  assert.equal(a.read('sessions.json'), '{"s1":{"title":"da a"}}\n')
  res = a.ptm()
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /enviado: sim · recebido: não/)
  assert.match(log(), /^sync a \d{4}-\d\d-\d\dT/)

  // b: DATA_DIR nem existe; recebe os dados da a no init
  res = b.ptm('--init')
  assert.equal(res.code, 0, res.out)
  assert.equal(b.read('sessions.json', 'a'), '{"s1":{"title":"da a"}}\n')
  b.write('sessions.json', '{"s2":{"title":"da b"}}\n')
  res = b.ptm()
  assert.match(res.out, /2 máquina\(s\) \[a, b\] · enviado: sim/)

  // a recebe a b; rodar de novo não faz nada
  res = a.ptm()
  assert.match(res.out, /\[a, b\] · enviado: não · recebido: sim/)
  assert.equal(a.read('sessions.json', 'b'), '{"s2":{"title":"da b"}}\n')
  res = a.ptm()
  assert.equal(res.code, 0)
  assert.match(res.out, /já estava em dia/)

  // as duas mudam ao mesmo tempo: quem chega depois faz rebase e envia
  a.write('topics.json', '{"s1":"pesquisa"}\n')
  b.write('topics.json', '{"s2":"testes"}\n')
  assert.equal(a.ptm().code, 0)
  res = b.ptm()
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /enviado: sim · recebido: sim/)
  assert.equal(b.read('topics.json', 'a'), '{"s1":"pesquisa"}\n')
  assert.equal(a.ptm().code, 0)
  assert.equal(a.read('topics.json', 'b'), '{"s2":"testes"}\n')
})

test('init junta dados locais com os que já estão no remoto', () => {
  const { machine } = sandbox()
  const a = machine('a')
  a.write('events-2026-09.jsonl', ev('m1', '2026-09-01T10:00:00Z') + '\n' + ev('m2', '2026-09-02T10:00:00Z') + '\n')
  a.write('sessions.json', '{"s1":{"title":"velha"},"s0":{"title":"só no remoto"}}\n')
  a.ptm('--init')
  assert.equal(a.ptm().code, 0)

  // mesma máquina reinstalada: coletou de novo, com parte dos eventos antigos já apagados
  const again = machine('a')
  fs.rmSync(again.home, { recursive: true })
  again.write('events-2026-09.jsonl', ev('m2', '2026-09-02T10:00:00Z') + '\n' + ev('m3', '2026-09-03T10:00:00Z') + '\n')
  again.write('events-2026-10.jsonl', ev('m4', '2026-10-01T10:00:00Z') + '\n')
  again.write('sessions.json', '{"s1":{"title":"nova"}}\n')
  let res = again.ptm('--init')
  assert.equal(res.code, 0, res.out)
  const ids = again.read('events-2026-09.jsonl').trim().split('\n').map((l) => JSON.parse(l).id)
  assert.deepEqual(ids, ['m1', 'm2', 'm3'])
  assert.deepEqual(JSON.parse(again.read('sessions.json')), { s1: { title: 'nova' }, s0: { title: 'só no remoto' } })
  res = again.ptm()
  assert.match(res.out, /enviado: sim/)
  // init de novo num clone já pronto não quebra nem perde nada
  assert.equal(again.ptm('--init').code, 0)
  assert.match(again.ptm().out, /já estava em dia/)
})

test('remoto fora do ar: erro claro, dados intactos, envia depois', () => {
  const { machine, remote } = sandbox()
  const a = machine('a')
  a.write('sessions.json', '{"s1":{}}\n')
  a.ptm('--init')
  a.ptm()

  a.write('topics.json', '{"s1":"pesquisa"}\n')
  fs.renameSync(remote, remote + '.off')
  const res = a.ptm()
  assert.equal(res.code, 1)
  assert.match(res.out, /dados locais continuam intactos/)
  assert.equal(a.read('topics.json'), '{"s1":"pesquisa"}\n')

  fs.renameSync(remote + '.off', remote)
  assert.match(a.ptm().out, /enviado: sim/)
})

test('recusa enviar se o origin não for o repositório configurado', () => {
  const { machine, root } = sandbox()
  const a = machine('a')
  a.write('sessions.json', '{}\n')
  a.ptm('--init')
  spawnSync('git', ['remote', 'set-url', 'origin', path.join(root, 'outro.git')], { cwd: path.join(a.home, 'data') })
  const res = a.ptm()
  assert.equal(res.code, 1)
  assert.match(res.out, /destino que não foi verificado/)
})
