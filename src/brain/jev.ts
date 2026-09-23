/** Thin TypeSafe System One client. One HTTP request evaluates every question against one state. */
import { config } from '../config.ts'
import { usage } from '../usage.ts'

export type Criteria = Record<string, unknown>
export type Question =
  | { type: 'choice'; instructions: unknown; criteria: Criteria }
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'score'; instructions: unknown; criteria: unknown[] }

export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | NoulAnswer | { type: 'score'; score: number; confidence: number }

export interface SystemOneResult { model: string; answers: Record<string, Answer>; latencyMs: number; inputTokens: number }

export async function systemOne(state: unknown, questions: Record<string, Question>): Promise<SystemOneResult> {
  if (!config.jev.apiKey) throw new Error('TYPESAFE_API_KEY is not set')
  const started = performance.now()
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(config.jev.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.jev.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.jev.model, state, questions }),
      signal: AbortSignal.timeout(20_000),
    })
    if ([429, 500, 502, 503, 529].includes(response.status) && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000
      await new Promise((r) => setTimeout(r, retryAfter || 400 * 2 ** attempt))
      continue
    }
    if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const body = (await response.json()) as { model: string; answers: Record<string, Answer>; usage?: { input_tokens: number } }
    usage.jevCalls++
    usage.jevInputTokens += body.usage?.input_tokens ?? 0
    return { model: body.model, answers: body.answers, latencyMs: Math.round(performance.now() - started), inputTokens: body.usage?.input_tokens ?? 0 }
  }
}

/** Reject answers that do not name one of the offered options; the executor never acts on an invented option. */
export function readChoice(answer: Answer | undefined, options: string[]): ChoiceAnswer {
  if (!answer || answer.type !== 'choice' || !options.includes(answer.choice)) {
    throw new Error(`Jev returned an invalid choice: ${JSON.stringify(answer)?.slice(0, 200)}`)
  }
  return answer
}
