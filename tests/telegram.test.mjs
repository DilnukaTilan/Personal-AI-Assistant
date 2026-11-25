import { mockChatAgent } from '@trigger.dev/sdk/ai/test'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { createTelegramAgent, telegramChannel } from '../src/trigger/telegram.ts'
import { telegramMessage, telegramText, telegramTarget, splitTelegramText, sendTelegramReply } from '../src/telegram.ts'

const update = (id, text, extra = {}) => ({ update_id: id, message: {
  message_id: id, chat: { id: 42, type: 'private' }, from: { id: 7 }, text, ...extra,
} })

function mockBotToken(t) {
  const original = process.env.TELEGRAM_BOT_TOKEN
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  t.after(() => {
    if (original === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = original
  })
}

test('channel validates messages, uses captions, and preserves topic destinations', () => {
  assert.equal(telegramChannel.inbound({ update_id: 1, edited_message: {} }), '')
  assert.equal(telegramChannel.inbound(update(1, 'hi', { from: { id: 9, is_bot: true } })), '')
  for (const invalid of [null, {}, { update_id: 1, message: {} }, update(1, 'hi', { message_thread_id: 'bad' })]) {
    assert.equal(telegramMessage(invalid), undefined)
  }
  assert.equal(telegramText(telegramMessage(update(2, undefined, { caption: ' A photo ' }))), 'A photo')
  assert.deepEqual(telegramChannel.bind(update(3, 'question', { message_thread_id: 8 })), { chat_id: 42, message_thread_id: 8 })
  assert.deepEqual(telegramTarget(update(4, 'question', { direct_messages_topic: { topic_id: 9 } }).message), {
    chat_id: 42, direct_messages_topic_id: 9,
  })
})

test('outbound replies are bounded without losing text or exposing provider errors', async (t) => {
  mockBotToken(t)
  const text = '👋'.repeat(4100)
  const chunks = splitTelegramText(text)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 4096 && chunk.isWellFormed()))
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage')
    const payload = JSON.parse(options.body)
    assert.equal(payload.parse_mode, undefined)
    sent.push(payload)
    return Response.json({ ok: true, result: { message_id: sent.length } })
  })
  const ref = await sendTelegramReply({ chat_id: 42, message_thread_id: 8 }, text)
  assert.equal(ref, String(sent.length))
  assert.equal(sent.map((p) => p.text).join(''), text)
  assert.ok(sent.every((p) => p.message_thread_id === 8))
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private bot test-token URL') })
  await assert.rejects(sendTelegramReply({ chat_id: 42 }, 'hello'), { message: 'Telegram could not send the response' })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false }, { status: 429 }))
  await assert.rejects(sendTelegramReply({ chat_id: 42 }, 'hello'), { message: 'Telegram could not send the response' })
})

test('agent restores conversation memory from a transcript on a fresh worker', { timeout: 20_000 }, async (t) => {
  mockBotToken(t)
  const prompts = []
  const sends = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage')
    sends.push(JSON.parse(options.body))
    return Response.json({ ok: true, result: { message_id: sends.length } })
  })
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    prompts.push(options.prompt)
    const text = prompts.length === 1 ? 'I will remember your name.'
      : JSON.stringify(options.prompt).includes('My name is Tilan') ? 'Your name is Tilan.' : 'I do not know your name yet.'
    return { stream: simulateReadableStream({ chunks: [
      { type: 'text-start', id: 'reply' },
      { type: 'text-delta', id: 'reply', delta: text },
      { type: 'text-end', id: 'reply' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      } },
    ], initialDelayInMs: 0, chunkDelayInMs: 0 }) }
  } })
  const agent = createTelegramAgent(model)
  const first = mockChatAgent(agent, { chatId: 'telegram-memory-test' })
  let snapshot
  try {
    await first.sendChannelEvent({ connectorId: 'telegram-chat', deliveryId: 'delivery-1', event: update(1, 'My name is Tilan.') })
  } finally {
    await first.close()
    snapshot = first.getSnapshot()
  }
  assert.ok(snapshot, 'the default platform transcript must be written')
  assert.match(JSON.stringify(snapshot), /My name is Tilan/)
  const resumed = mockChatAgent(agent, { chatId: 'telegram-memory-test', mode: 'continuation', snapshot })
  try {
    await resumed.sendChannelEvent({ connectorId: 'telegram-chat', deliveryId: 'delivery-2', event: update(2, 'What is my name?') })
  } finally {
    await resumed.close()
  }
  assert.equal(prompts.length, 2)
  assert.match(JSON.stringify(prompts[1]), /My name is Tilan/)
  assert.match(JSON.stringify(prompts[1]), /I will remember your name/)
  assert.match(JSON.stringify(prompts[1]), /What is my name/)
  assert.deepEqual(sends.map((p) => p.text), ['I will remember your name.', 'Your name is Tilan.'])
  const separate = mockChatAgent(agent, { chatId: 'another-telegram-chat' })
  try {
    await separate.sendChannelEvent({ connectorId: 'telegram-chat', deliveryId: 'delivery-3', event: update(3, 'What is my name?', { chat: { id: 99, type: 'private' } }) })
  } finally {
    await separate.close()
  }
  assert.doesNotMatch(JSON.stringify(prompts[2]), /My name is Tilan/)
  assert.equal(sends[2].text, 'I do not know your name yet.')
  assert.equal(sends[2].chat_id, 99)
})
