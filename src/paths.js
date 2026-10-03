import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Tudo que é dado fica fora deste repositório (que é público).
export const HOME = process.env.PTM_HOME || path.join(os.homedir(), '.projetct-m')
export const DATA_DIR = path.join(HOME, 'data')
export const CONFIG_FILE = path.join(HOME, 'config.json')
export const CLAUDE_PROJECTS =
  process.env.PTM_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects')

export function loadConfig() {
  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {}
  return {
    machine: process.env.PTM_MACHINE || config.machine || defaultMachine(),
    dataRepo: process.env.PTM_DATA_REPO || config.dataRepo || null,
  }
}

export function saveConfig(patch) {
  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {}
  fs.mkdirSync(HOME, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, ...patch }, null, 2) + '\n')
}

function defaultMachine() {
  return os.hostname().replace(/\.(local|lan|home)$/i, '').replace(/[^\w.-]+/g, '-')
}

export function machineDir(machine) {
  return path.join(DATA_DIR, 'machines', machine)
}
