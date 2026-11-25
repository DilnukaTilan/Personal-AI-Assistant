import { Hono } from 'hono'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { runs, tasks } from '@trigger.dev/sdk'
import type { testAI } from './trigger/test-ai.js'
import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

if (existsSync('.env')) loadEnvFile('.env')

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/marco', (c) => {
  return c.text('polo')
})

// Temporary public AI smoke test. Remove this route after testing.
app.get('/test/ai', async (c) => {
  c.header('Cache-Control', 'no-store')
  if (!process.env.TRIGGER_SECRET_KEY) {
    return c.json({ error: 'Trigger.dev is not configured' }, 503)
  }

  const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(45_000)])
  try {
    const handle = await tasks.trigger<typeof testAI>('test-ai', {}, { ttl: '1m' })
    c.header('X-Trigger-Run-Id', handle.id)
    for await (const run of runs.subscribeToRun<typeof testAI>(handle.id, { signal })) {
      if (run.status === 'COMPLETED') {
        const text = run.output?.text?.trim()
        if (text) return c.text(text)
        break
      }
    }
  } catch {
    // Keep provider and Trigger.dev credentials out of public error responses.
  }
  if (signal.aborted) return c.json({ error: 'AI test timed out' }, 504)
  return c.json({ error: 'Trigger.dev AI task could not generate a response' }, 502)
})

app.post('/telegram/webhook', async (c) => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!token || !secret) {
    return c.json({ error: 'Telegram bot is not configured' }, 503)
  }

  const supplied = Buffer.from(c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '')
  const expected = Buffer.from(secret)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let update: unknown
  try {
    update = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!isObject(update) || !Number.isSafeInteger(update.update_id)) {
    return c.json({ error: 'Invalid Telegram update' }, 400)
  }

  // Only new messages receive replies; edits and other updates are acknowledged.
  if (update.message === undefined) return c.json({ ok: true })
  const message = update.message
  if (!isObject(message) || !isObject(message.chat)
    || !Number.isSafeInteger(message.chat.id) || !Number.isSafeInteger(message.message_id)) {
    return c.json({ error: 'Invalid Telegram message' }, 400)
  }

  const prompt = (typeof message.text === 'string' ? message.text
    : typeof message.caption === 'string' ? message.caption : '').trim()
  if (!prompt) return c.json({ ok: true })

  if (!process.env.OPENAI_API_KEY) {
    return c.json({ error: 'AI model is not configured' }, 503)
  }

  let reply: string
  try {
    const { text } = await generateText({
      model: openai('gpt-5.4-nano'),
      instructions: 'You are a helpful personal assistant on Telegram. Answer concisely in plain text, under 3500 characters. You can only see the current text or caption, not attachments or previous messages.',
      prompt,
      maxOutputTokens: 512,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
      providerOptions: { openai: { reasoningEffort: 'none' } },
    })
    // Telegram accepts at most 4096 characters. Avoid cutting a surrogate pair.
    reply = Array.from(text.trim()).slice(0, 4096).join('')
    if (!reply) return c.json({ error: 'AI could not generate a response' }, 502)
  } catch {
    return c.json({ error: 'AI could not generate a response' }, 502)
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        text: reply,
        ...(Number.isSafeInteger(message.message_thread_id)
          ? { message_thread_id: message.message_thread_id } : {}),
        ...(isObject(message.direct_messages_topic)
          && Number.isSafeInteger(message.direct_messages_topic.topic_id)
          ? { direct_messages_topic_id: message.direct_messages_topic.topic_id } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const result: unknown = await response.json()
    if (!response.ok || !isObject(result) || result.ok !== true) {
      return c.json({ error: 'Telegram could not send the response' }, 502)
    }
  } catch {
    // Fetch errors can contain the token-bearing URL. Never expose or log them.
    return c.json({ error: 'Telegram could not send the response' }, 502)
  }

  return c.json({ ok: true })
})

export default app
