import assert from 'node:assert/strict'
import app from '../src/app.ts'

// These credentials and the outbound transport exist only in this CLI test process.
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret'
const calls = []
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.telegram.org/bottest-token/copyMessage')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['Content-Type'], 'application/json')
  const body = JSON.parse(options.body)
  calls.push(body)
  if (body.message_id === 500) return Response.json({ ok: false }, { status: 500 })
  if (body.message_id === 501) return Response.json({ ok: false })
  if (body.message_id === 502) throw new Error('Simulated network failure')
  return Response.json({ ok: true, result: { message_id: 100 } })
}
app.get('/__test/calls', (c) => c.json({ calls, count: calls.length }))
app.post('/__test/unconfigure', (c) => {
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  return c.json({ ok: true })
})
export default app
