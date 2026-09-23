/** Running totals of model usage, printed on shutdown and available via !status. */
export const usage = { jevCalls: 0, jevInputTokens: 0, llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCostUsd: 0 }

export const JEV_USD_PER_MTOK = 0.042

export function usageSummary() {
  const jevUsd = (usage.jevInputTokens / 1e6) * JEV_USD_PER_MTOK
  return `Jev: ${usage.jevCalls} calls, ${usage.jevInputTokens} input tokens (~$${jevUsd.toFixed(4)}) | LLM: ${usage.llmCalls} calls, ${usage.llmInputTokens} in / ${usage.llmOutputTokens} out tokens (~$${usage.llmCostUsd.toFixed(3)} at API list price)`
}
