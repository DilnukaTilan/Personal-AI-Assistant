import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTelegramWebhook } from '../scripts/telegram-webhook.mjs'

const config = { token: 'test-bot-token', secret: 'test-webhook-secret' }
const endpoint = 'https://example.com/trigger-telegram'

test('registration preserves pending messages and verifies the registered URL', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return Response.json({ ok: true, result: calls.length === 1 ? true : { url: endpoint, pending_update_count: 2 } })
  })
  const info = await registerTelegramWebhook(endpoint, config)
  assert.equal(info.pending_update_count, 2)
  assert.deepEqual(calls, [
    { url: 'https://api.telegram.org/bottest-bot-token/setWebhook', body: {
      url: endpoint, secret_token: config.secret, allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false,
    } },
    { url: 'https://api.telegram.org/bottest-bot-token/getWebhookInfo', body: {} },
  ])
})

test('registration rejects invalid input before contacting Telegram', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not call the network') })
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/#fragment', undefined]) {
    await assert.rejects(registerTelegramWebhook(url, config), /HTTPS/)
  }
  await assert.rejects(registerTelegramWebhook(endpoint, { ...config, secret: 'invalid secret' }), /TELEGRAM_WEBHOOK_SECRET/)
})

test('registration reports mismatched destinations and sanitizes upstream failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => Response.json({ ok: true, result: url.endsWith('/setWebhook')
    ? true : { url: 'https://wrong.example.com', pending_update_count: 0 } }))
  await assert.rejects(registerTelegramWebhook(endpoint, config), /URL verification failed/)
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`https://api.telegram.org/bot${config.token}`) })
  await assert.rejects(registerTelegramWebhook(endpoint, config), (error) => !error.message.includes(config.token))
})
