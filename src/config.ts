import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    goal: { type: 'string', short: 'g' },
    host: { type: 'string' },
    port: { type: 'string' },
    user: { type: 'string', short: 'u' },
    version: { type: 'string' },
    xray: { type: 'boolean', default: false },
  },
})

const env = process.env

export const config = {
  goal: values.goal ?? (positionals.join(' ') || env.GOAL || ''),
  host: values.host ?? env.MC_HOST ?? 'localhost',
  port: Number(values.port ?? env.MC_PORT ?? 25565),
  username: values.user ?? env.MC_USER ?? 'Jev',
  auth: (env.MC_AUTH ?? 'offline') as 'offline' | 'microsoft',
  version: values.version ?? env.MC_VERSION ?? undefined,

  // Fair perception only reports blocks the bot could plausibly see. --xray reads the raw chunk data.
  perception: (values.xray || env.PERCEPTION === 'xray' ? 'xray' : 'fair') as 'fair' | 'xray',

  jev: {
    apiKey: env.TYPESAFE_API_KEY ?? '',
    model: env.TYPESAFE_MODEL ?? 'jev-latest',
    url: env.TYPESAFE_URL ?? 'https://api.typesafe.ai/v1/systemone',
    // Below this the decision still runs, but the strategist is asked for advice in the background.
    adviseBelow: Number(env.JEV_ADVISE_BELOW ?? 0.45),
  },

  llm: {
    // claude-cli | anthropic | openai. Auto: anthropic if ANTHROPIC_API_KEY, openai if OPENAI-compatible key, else claude-cli.
    provider: env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : env.LLM_API_KEY ? 'openai' : 'claude-cli'),
    model: env.LLM_MODEL ?? '',
    apiKey: env.LLM_API_KEY ?? env.ANTHROPIC_API_KEY ?? '',
    baseUrl: env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1',
  },

  limits: {
    failuresBeforeRecover: 3,
    stepsPerSubgoal: 30,
    lowConfidenceStreak: 3,
  },
}

export type Config = typeof config
