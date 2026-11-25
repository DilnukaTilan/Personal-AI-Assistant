import { AbortTaskRunError, task } from '@trigger.dev/sdk'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

// Temporary task for GET /test/ai. Remove both after testing.
export const testAI = task({
  id: 'test-ai',
  maxDuration: 30,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 2 },
  run: async (_payload: Record<string, never>, { signal }) => {
    if (!process.env.OPENAI_API_KEY) {
      throw new AbortTaskRunError('AI model is not configured')
    }
    const { text } = await generateText({
      model: openai('gpt-5.4-nano'),
      prompt: 'Say hello in one short sentence.',
      maxOutputTokens: 512,
      maxRetries: 0,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      providerOptions: { openai: { reasoningEffort: 'none' } },
    })
    if (!text.trim()) throw new Error('AI could not generate a response')
    return { text: text.trim() }
  },
})
