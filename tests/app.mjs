import assert from 'node:assert/strict'
import app from '../src/app.ts'

// These credentials and the outbound transport exist only in this CLI test process.
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret'
process.env.OPENAI_API_KEY = 'test-openai-key'
process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
const calls = []
const prompts = []
globalThis.fetch = async (url, options) => {
  if (url === 'https://api.openai.com/v1/responses') {
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'gpt-5.4-nano')
    assert.equal(body.max_output_tokens, 512)
    assert.equal(body.reasoning.effort, 'none')
    assert.ok(options.signal instanceof AbortSignal)
    const prompt = body.input.find((item) => item.role === 'user').content[0].text
    prompts.push(prompt)
    if (prompt === 'AI failure') {
      return Response.json({ error: { message: 'Simulated provider failure' } }, { status: 500 })
    }
    if (prompt === 'AI network failure') throw new Error('Simulated provider network failure')
    const text = prompt === 'Empty response' ? '   '
      : prompt === 'Long response' ? '👋'.repeat(4100)
      : `AI reply to: ${prompt}`
    return Response.json({
      id: 'resp_test',
      created_at: 1,
      model: body.model,
      output: [{
        type: 'message', id: 'msg_test', role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      }],
      usage: { input_tokens: 10, output_tokens: 20 },
    })
  }
  assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['Content-Type'], 'application/json')
  const body = JSON.parse(options.body)
  assert.equal(body.parse_mode, undefined)
  assert.ok(Array.from(body.text).length <= 4096)
  assert.ok(body.text.isWellFormed())
  calls.push(body)
  if (body.text === 'AI reply to: API failure') return Response.json({ ok: false }, { status: 500 })
  if (body.text === 'AI reply to: API ok false') return Response.json({ ok: false })
  if (body.text === 'AI reply to: Network failure') throw new Error('Simulated network failure')
  return Response.json({ ok: true, result: { message_id: 100 } })
}
app.get('/__test/calls', (c) => c.json({ calls, count: calls.length }))
app.get('/__test/prompts', (c) => c.json({ prompts, count: prompts.length }))
app.post('/__test/ai-unconfigure', (c) => {
  delete process.env.OPENAI_API_KEY
  return c.json({ ok: true })
})
app.post('/__test/unconfigure', (c) => {
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  return c.json({ ok: true })
})
export default app
