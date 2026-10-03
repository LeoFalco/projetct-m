import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, saveConfig } from '../paths.js'
import { listMachines } from '../store.js'

const BRANCH = 'main'
const DEFAULT_NAME = 'projetct-m-data'
const PUSH_ATTEMPTS = 3

// Só para os testes: usa este caminho/URL como remoto e não fala com o GitHub.
const TEST_REMOTE = process.env.PTM_SYNC_REMOTE || null

export default async function sync(args, config) {
  const opts = parseArgs(args)
  if (opts.init) return init(opts.repo, config)

  if (!config.dataRepo || !isRepo()) {
    throw new Error(
      'o repositório de dados ainda não foi configurado nesta máquina.\n' +
        'Rode "ptm sync --init" (cria/usa <seu usuário>/projetct-m-data, privado) ou "ptm sync --init dono/nome".',
    )
  }
  ensurePrivate(config.dataRepo)
  ensureOrigin(config.dataRepo)
  ensureIdentity(config.machine)

  // Commit antes do pull: o rebase precisa da árvore limpa.
  git(['add', '-A'])
  const changed = git(['status', '--porcelain']).split('\n').filter(Boolean).length
  if (changed) git(['commit', '-q', '-m', `sync ${config.machine} ${new Date().toISOString()}`])

  let received = false
  let sent = false
  for (let attempt = 1; ; attempt++) {
    const before = revParse(`refs/remotes/origin/${BRANCH}`)
    const remoteHasBranch = fetch()
    const remote = revParse(`refs/remotes/origin/${BRANCH}`)
    if (remoteHasBranch && remote !== before) received = true
    if (remoteHasBranch && remote !== revParse('HEAD')) rebase()

    const head = revParse('HEAD')
    if (!head || head === remote) break // nada para enviar
    const push = tryGit(['push', '-q', '-u', 'origin', `HEAD:${BRANCH}`])
    if (push.ok) {
      sent = true
      break
    }
    // Outra máquina enviou no meio do caminho: busca de novo e tenta outra vez.
    const raced = /rejected|non-fast-forward|fetch first/i.test(push.err)
    if (!raced || attempt >= PUSH_ATTEMPTS) {
      throw new Error(
        `não consegui enviar para ${config.dataRepo}: ${lastLines(push.err)}\n` +
          'Seus dados locais continuam intactos (já commitados); rode "ptm sync" de novo quando a conexão voltar.',
      )
    }
  }

  const machines = listMachines()
  console.log(
    `sync ${config.dataRepo}: ${machines.length} máquina(s) [${machines.join(', ')}] · ` +
      `enviado: ${sent ? 'sim' : 'não'} · recebido: ${received ? 'sim' : 'não'}` +
      (!sent && !received ? ' (já estava em dia)' : ''),
  )
}

function parseArgs(args) {
  const opts = { init: false, repo: null }
  for (const arg of args) {
    if (arg === '--init') opts.init = true
    else if (opts.init && !opts.repo && !arg.startsWith('-')) opts.repo = arg
    else throw new Error(`opção desconhecida: ${arg}. Use "ptm sync" ou "ptm sync --init [dono/nome]".`)
  }
  return opts
}

// ---------------------------------------------------------------- init

function init(repoArg, config) {
  // ordem: argumento, depois PTM_DATA_REPO / config.json, depois o nome padrão
  const repo = repoArg || config.dataRepo || (TEST_REMOTE ? 'teste/local' : `${ghUser()}/${DEFAULT_NAME}`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repositório inválido: "${repo}". Use o formato dono/nome.`)

  const url = TEST_REMOTE || prepareGithubRepo(repo)

  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!isRepo()) {
    git(['init', '-q'])
    git(['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`])
  }
  const origin = tryGit(['remote', 'get-url', 'origin'])
  if (!origin.ok) git(['remote', 'add', 'origin', url])
  else if (!sameRemote(origin.out, url, repo)) {
    throw new Error(
      `${DATA_DIR} já é um clone de outro repositório (${origin.out}). ` +
        'Não vou trocar o destino sozinho; ajuste o remoto "origin" à mão se for isso mesmo.',
    )
  }
  git(['config', 'core.autocrlf', 'false'])
  ensureIdentity(config.machine)

  // Sem commits locais: adota o histórico do remoto sem tocar nos arquivos já coletados.
  const remoteHasBranch = fetch()
  let adopted = 0
  if (remoteHasBranch && !revParse('HEAD')) adopted = adoptRemote()

  saveConfig({ dataRepo: repo })
  const machines = listMachines()
  console.log(
    `Repositório de dados: ${repo} (privado) em ${DATA_DIR}\n` +
      (remoteHasBranch
        ? `Histórico existente adotado (${adopted} arquivo(s) trazidos do remoto). `
        : 'O repositório remoto está vazio. ') +
      `Máquinas locais: ${machines.join(', ') || 'nenhuma'}.\n` +
      'Agora rode "ptm sync" para enviar e receber as métricas.',
  )
}

/** Garante que o repositório existe no GitHub e é PRIVADO; devolve a URL de clone. */
function prepareGithubRepo(repo) {
  const view = gh(['repo', 'view', repo, '--json', 'visibility,url,sshUrl'])
  let info
  if (view.ok) {
    info = JSON.parse(view.out)
    if (info.visibility !== 'PRIVATE') throw new Error(notPrivate(repo, info.visibility))
  } else if (/could not resolve to a repository|not found/i.test(view.err)) {
    const created = gh(['repo', 'create', repo, '--private', '--description', 'Métricas de uso do Claude Code (projetct-m)'])
    if (!created.ok) throw new Error(`não consegui criar ${repo}: ${lastLines(created.err)}`)
    console.log(`Repositório privado ${repo} criado.`)
    // confere de novo: nunca assumir que o que foi criado ficou privado
    info = JSON.parse(ghOrThrow(['repo', 'view', repo, '--json', 'visibility,url,sshUrl']))
    if (info.visibility !== 'PRIVATE') throw new Error(notPrivate(repo, info.visibility))
  } else {
    throw new Error(`não consegui consultar ${repo} no GitHub: ${lastLines(view.err)}`)
  }
  const protocol = gh(['config', 'get', 'git_protocol', '-h', 'github.com'])
  return protocol.ok && protocol.out === 'ssh' ? info.sshUrl : `${info.url}.git`
}

/**
 * DATA_DIR acabou de virar repositório e o remoto já tem histórico. Aponta o branch para o remoto
 * sem mexer na árvore de trabalho, traz o que falta e junta o que existe dos dois lados.
 */
function adoptRemote() {
  const ref = `origin/${BRANCH}`
  git(['reset', '-q', ref])
  const missing = git(['ls-files', '--deleted', '-z']).split('\0').filter(Boolean)
  for (let i = 0; i < missing.length; i += 100) git(['checkout', '-q', ref, '--', ...missing.slice(i, i + 100)])

  // Mesmo arquivo dos dois lados (ex.: máquina reinstalada com o mesmo nome): une, o local vence.
  for (const file of git(['ls-files', '--modified', '-z']).split('\0').filter(Boolean)) {
    const full = path.join(DATA_DIR, file)
    const remote = git(['show', `${ref}:${file}`])
    const local = fs.readFileSync(full, 'utf8')
    if (file.endsWith('.jsonl')) {
      const byId = new Map()
      for (const line of (remote + '\n' + local).split('\n').filter(Boolean)) {
        try {
          const ev = JSON.parse(line)
          byId.set(ev.id, ev)
        } catch {}
      }
      const sorted = [...byId.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
      fs.writeFileSync(full, sorted.map((ev) => JSON.stringify(ev)).join('\n') + '\n')
    } else if (file.endsWith('.json')) {
      try {
        const merged = { ...JSON.parse(remote), ...JSON.parse(local) }
        fs.writeFileSync(full, JSON.stringify(merged, null, 2) + '\n')
      } catch {}
    }
  }
  return missing.length
}

// ---------------------------------------------------------------- git

function isRepo() {
  return fs.existsSync(path.join(DATA_DIR, '.git'))
}

function tryGit(args) {
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: DATA_DIR,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // sem conexão/credencial: falha em vez de travar
  })
  if (res.error?.code === 'ENOENT') throw new Error('o comando "git" não foi encontrado. Instale o git.')
  if (res.error) throw new Error(`falha ao executar o git: ${res.error.message}`)
  return { ok: res.status === 0, out: res.stdout.replace(/\r?\n$/, ''), err: res.stderr.trim() }
}

function git(args) {
  const res = tryGit(args)
  if (!res.ok) throw new Error(`git ${args[0]} falhou: ${lastLines(res.err) || 'sem mensagem'}`)
  return res.out
}

function revParse(ref) {
  const res = tryGit(['rev-parse', '--verify', '-q', ref])
  return res.ok ? res.out : null
}

/** Busca o remoto. Devolve se o branch já existe lá (repositório recém-criado ainda não tem). */
function fetch() {
  const heads = tryGit(['ls-remote', '--heads', 'origin', BRANCH])
  if (!heads.ok) {
    throw new Error(
      `não consegui falar com o repositório remoto: ${lastLines(heads.err)}\n` +
        'Seus dados locais continuam intactos; tente de novo quando a conexão voltar.',
    )
  }
  if (!heads.out) return false
  git(['fetch', '-q', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`])
  return true
}

function rebase() {
  if (!revParse('HEAD')) return git(['reset', '-q', '--hard', `origin/${BRANCH}`])
  const res = tryGit(['rebase', '-q', `origin/${BRANCH}`])
  if (res.ok) return
  tryGit(['rebase', '--abort'])
  throw new Error(
    `conflito ao juntar com o remoto: ${lastLines(res.err || res.out)}\n` +
      'Isso só acontece se duas máquinas usarem o mesmo nome. Nada foi perdido: o rebase foi desfeito. ' +
      'Dê nomes diferentes às máquinas (PTM_MACHINE ou "machine" no config.json).',
  )
}

// Máquinas sem user.name/user.email global não conseguiriam commitar.
function ensureIdentity(machine) {
  if (!tryGit(['config', 'user.email']).out) git(['config', 'user.email', `ptm@${machine}`])
  if (!tryGit(['config', 'user.name']).out) git(['config', 'user.name', `ptm ${machine}`])
}

/** O "origin" tem que ser o repositório configurado: evita enviar para outro lugar por engano. */
function ensureOrigin(repo) {
  const origin = tryGit(['remote', 'get-url', 'origin'])
  if (!origin.ok || !sameRemote(origin.out, TEST_REMOTE || '', repo)) {
    throw new Error(
      `o remoto "origin" de ${DATA_DIR} (${origin.out || 'ausente'}) não é ${repo}. ` +
        'Não envio dados para um destino que não foi verificado; rode "ptm sync --init" de novo.',
    )
  }
}

function sameRemote(originUrl, url, repo) {
  if (TEST_REMOTE) return originUrl === url
  const slug = /github\.com[:/]+(.+?)(?:\.git)?\/?$/i.exec(originUrl)?.[1]
  return !!slug && slug.toLowerCase() === repo.toLowerCase()
}

// ---------------------------------------------------------------- GitHub

function gh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8' })
  if (res.error?.code === 'ENOENT') {
    throw new Error('o comando "gh" (GitHub CLI) não foi encontrado. Instale em https://cli.github.com e rode "gh auth login".')
  }
  if (res.error) throw new Error(`falha ao executar o gh: ${res.error.message}`)
  return { ok: res.status === 0, out: res.stdout.trim(), err: res.stderr.trim() }
}

function ghOrThrow(args) {
  const res = gh(args)
  if (!res.ok) throw new Error(`gh ${args.slice(0, 2).join(' ')} falhou: ${lastLines(res.err)}`)
  return res.out
}

function ghUser() {
  const res = gh(['api', 'user', '-q', '.login'])
  if (!res.ok || !res.out) throw new Error(`não consegui descobrir seu usuário do GitHub (rode "gh auth login"): ${lastLines(res.err)}`)
  return res.out
}

/** Os dados têm títulos de sessão e caminhos de projeto: só saem daqui para um repositório privado. */
function ensurePrivate(repo) {
  if (TEST_REMOTE) return
  const res = gh(['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'])
  if (!res.ok) {
    throw new Error(
      `não consegui confirmar que ${repo} é privado: ${lastLines(res.err)}\n` +
        'Sem essa confirmação nada é enviado. Seus dados locais continuam intactos.',
    )
  }
  if (res.out !== 'PRIVATE') throw new Error(notPrivate(repo, res.out))
}

function notPrivate(repo, visibility) {
  return (
    `${repo} não é privado (visibilidade: ${visibility}). Os dados incluem títulos de sessão e caminhos ` +
    'de projeto e nunca são enviados para um repositório que não seja privado. Torne-o privado ou escolha outro.'
  )
}

function lastLines(text) {
  return String(text || '').trim().split('\n').slice(-3).join(' | ')
}
