import { scanTranscripts } from '../parse.js'
import { mergeMachine } from '../store.js'

export default async function collect(_args, config) {
  const { events, sessions } = await scanTranscripts()
  const added = mergeMachine(config.machine, events, sessions)
  console.log(
    `${config.machine}: ${events.size} respostas em ${sessions.size} sessões lidas, ${added} novas guardadas.`,
  )
}
