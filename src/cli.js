#!/usr/bin/env node
import { loadConfig } from './paths.js'

const COMMANDS = {
  collect: ['Lê as sessões do Claude Code desta máquina e guarda as métricas', './commands/collect.js'],
  classify: ['Classifica as sessões por assunto usando o Haiku', './commands/classify.js'],
  sync: ['Envia/recebe as métricas do repositório privado de dados', './commands/sync.js'],
  report: ['Mostra o relatório no terminal', './commands/report.js'],
  dashboard: ['Gera o dashboard em HTML', './commands/dashboard.js'],
}

const [name, ...args] = process.argv.slice(2)

if (!name || name === 'help' || name === '--help' || name === '-h') {
  console.log('Uso: ptm <comando> [opções]\n')
  for (const [cmd, [desc]] of Object.entries(COMMANDS)) console.log(`  ${cmd.padEnd(10)} ${desc}`)
  console.log(`\nMáquina: ${loadConfig().machine}`)
  process.exit(0)
}

if (!COMMANDS[name]) {
  console.error(`Comando desconhecido: ${name}. Rode "ptm help".`)
  process.exit(1)
}

try {
  const { default: run } = await import(COMMANDS[name][1])
  await run(args, loadConfig())
} catch (err) {
  console.error(`ptm ${name}: ${err.message}`)
  process.exit(1)
}
