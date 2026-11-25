import assert from 'node:assert/strict'
import { runs, tasks } from '@trigger.dev/sdk'
import app from '../src/app.ts'

process.env.TRIGGER_SECRET_KEY = 'tr_test_only'
let mode = 'success'
let triggered = 0

tasks.trigger = async (id, payload, options) => {
  assert.equal(id, 'test-ai')
  assert.deepEqual(payload, {})
  assert.equal(options.ttl, '1m')
  triggered++
  if (mode === 'unavailable') throw new Error('Private upstream error')
  return { id: 'run_test_ai' }
}
runs.subscribeToRun = async function* (id, options) {
  assert.equal(id, 'run_test_ai')
  assert.ok(options.signal instanceof AbortSignal)
  yield { status: 'EXECUTING' }
  if (mode === 'failed') {
    yield { status: 'FAILED', error: { message: 'Private upstream error' } }
  } else {
    yield { status: 'COMPLETED', output: { text: mode === 'empty' ? '  ' : ' Hello from Trigger.dev! ' } }
  }
}
app.post('/__test/mode/:mode', (c) => {
  mode = c.req.param('mode')
  if (mode === 'unconfigured') delete process.env.TRIGGER_SECRET_KEY
  return c.json({ ok: true })
})
app.get('/__test/trigger-count', (c) => c.json({ triggered }))
export default app
