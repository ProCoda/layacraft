/** System Two: a slower generative model behind one `json()` call. Providers are swappable. */
import { spawn } from 'node:child_process'
import os from 'node:os'
import { config } from '../config.ts'
import { log } from '../log.ts'
import { usage } from '../usage.ts'

export interface LLM {
  name: string
  json<T>(system: string, user: string, schema: object): Promise<T>
}

function claudeCli(): LLM {
  const model = config.llm.model || 'sonnet'
  return {
    name: `claude-cli:${model}`,
    json<T>(system: string, user: string, schema: object) {
      const args = [
        '-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
        '--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config', '--tools', '',
        '--system-prompt', system, '--json-schema', JSON.stringify(schema),
      ]
      return new Promise<T>((resolve, reject) => {
        // Run outside the project and without user CLAUDE.md so personal instructions never leak into the bot.
        const child = spawn('claude', args, {
          cwd: os.tmpdir(),
          env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
        child.stdout.on('data', (c) => (out += c))
        child.stderr.on('data', (c) => (err += c))
        child.on('error', reject)
        child.on('close', (code) => {
          clearTimeout(timer)
          try {
            const result = JSON.parse(out)
            usage.llmCalls++
            usage.llmInputTokens += (result.usage?.input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0) + (result.usage?.cache_read_input_tokens ?? 0)
            usage.llmOutputTokens += result.usage?.output_tokens ?? 0
            usage.llmCostUsd += result.total_cost_usd ?? 0
            if (result.is_error || !result.structured_output) throw new Error(String(result.result ?? 'no structured output'))
            resolve(result.structured_output as T)
          } catch (e) {
            reject(new Error(`claude CLI failed (exit ${code}): ${(e as Error).message} ${err.slice(0, 300)}`))
          }
        })
        child.stdin.end(user)
      })
    },
  }
}

function anthropic(): LLM {
  const model = config.llm.model || 'claude-sonnet-5'
  return {
    name: `anthropic:${model}`,
    async json<T>(system: string, user: string, schema: object) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': config.llm.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 4096, system,
          messages: [{ role: 'user', content: user }],
          output_config: { format: { type: 'json_schema', schema } },
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const body = (await response.json()) as { content: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } }
      usage.llmCalls++
      usage.llmInputTokens += body.usage?.input_tokens ?? 0
      usage.llmOutputTokens += body.usage?.output_tokens ?? 0
      return JSON.parse(body.content.find((b) => b.type === 'text')?.text ?? '{}') as T
    },
  }
}

function openai(): LLM {
  const model = config.llm.model || 'anthropic/claude-sonnet-5'
  return {
    name: `openai:${model}`,
    async json<T>(system: string, user: string, schema: object) {
      const response = await fetch(config.llm.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.llm.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema } },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const body = (await response.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } }
      usage.llmCalls++
      usage.llmInputTokens += body.usage?.prompt_tokens ?? 0
      usage.llmOutputTokens += body.usage?.completion_tokens ?? 0
      return JSON.parse(body.choices[0].message.content) as T
    },
  }
}

export function createLLM(): LLM {
  const llm = config.llm.provider === 'anthropic' ? anthropic() : config.llm.provider === 'openai' ? openai() : claudeCli()
  log('llm', `strategist model: ${llm.name}`)
  return llm
}
