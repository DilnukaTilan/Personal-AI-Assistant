import { mockChatAgent } from '@trigger.dev/sdk/ai/test'
import { chat } from '@trigger.dev/sdk/ai'
import { logger } from '@trigger.dev/sdk'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { createDaytonaTools, SANDBOX_WORKSPACE } from '../src/daytona.ts'
import { createTelegramAgent, telegramChannel } from '../src/trigger/telegram.ts'
import { telegramInboundMessage, telegramUploads, uploadsFromHistory, downloadTelegramFile,
  sendTelegramDocument, TELEGRAM_DOWNLOAD_LIMIT } from '../src/telegram-files.ts'

const file = { id: '1-document', fileId: 'private-file-id', filename: 'input.txt', mediaType: 'text/plain', size: 5 }
const event = (id = 1, extra = {}) => ({ update_id: id, message: {
  message_id: id, chat: { id: 42, type: 'private' }, from: { id: 7 },
  document: { file_id: file.fileId, file_name: 'input.txt', mime_type: 'text/plain', file_size: 5 }, ...extra,
} })
function botToken(t) {
  const previous = process.env.TELEGRAM_BOT_TOKEN
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  t.after(() => previous === undefined ? delete process.env.TELEGRAM_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN = previous)
}
function fakeDaytona() {
  const calls = []
  const files = new Map()
  let failure
  const sandbox = { id: 'sandbox-test',
    fs: {
      createFolder: async (path) => calls.push(['mkdir', path]),
      uploadFile: async (data, path) => { calls.push(['upload', path]); files.set(path, Buffer.from(data)) },
      downloadFile: async (path) => { calls.push(['download', path]); return files.get(path) ?? Buffer.from('result') },
    },
    process: { executeCommand: async (command, cwd, env, timeout) => {
      calls.push(['command', command, cwd, env, timeout])
      if (failure) throw failure
      if (command.includes('morph=(center')) return { exitCode: 0, result: JSON.stringify({ pageCount: 1, verified: true, watermark: 'SAMPLE - NOT FOR SIGNING' }) }
      if (command.startsWith('python3 -c')) return { exitCode: 0, result: '6' }
      if (command.includes('parse_upload.py')) return { exitCode: 0, result: JSON.stringify({ text: 'hello', note: 'preview', truncated: false }) }
      return { exitCode: 0, result: 'done' }
    } },
    computerUse: { start: async () => calls.push(['desktop']),
      mouse: { click: async (...args) => calls.push(['click', ...args]) },
      keyboard: { type: async (text) => calls.push(['type', text]), hotkey: async (key) => calls.push(['press', key]) },
      screenshot: { takeCompressed: async () => ({ screenshot: Buffer.from('image').toString('base64') }) },
    },
  }
  const client = { v0: {
    create: async (params) => { calls.push(['create', params]); return sandbox },
    delete: async (...args) => calls.push(['delete', ...args]),
    get: async () => sandbox,
  } }
  return { client, calls, files, fail: (error) => { failure = error } }
}
const context = { toolCallId: 'test-call', messages: [] }
const run = (tool, input, extra = {}) => tool.execute(input, { ...context, ...extra })

test('captionless uploads become durable, scoped references without token-bearing URLs', () => {
  const inbound = telegramChannel.inbound(event())
  assert.match(telegramChannel.filter, /event.message.document != null/)
  assert.match(inbound.message.parts[0].text, /Uploaded file.*1-document/)
  assert.doesNotMatch(inbound.message.parts[0].text, /private-file-id/)
  assert.equal(telegramUploads(event(1, { document: { file_id: 'id', file_name: '../../evil\n.pdf' } }).message)[0].filename, '_.._evil_.pdf')
  const uim = { ...inbound.message, metadata: { source: 'channel', connectorId: 'telegram-chat' } }
  assert.equal(uploadsFromHistory([uim])[0].fileId, file.fileId)
  assert.deepEqual(uploadsFromHistory([{ ...uim, metadata: {} }]), [])
  assert.deepEqual(uploadsFromHistory([{ ...uim, role: 'assistant' }]), [])
  assert.deepEqual(telegramUploads(event(1, { document: null, photo: {} }).message), [])
  const photos = telegramUploads(event(1, { document: null, photo: [{ file_id: 'small' }, { file_id: 'large' }] }).message)
  assert.equal(photos[0].fileId, 'large')
  assert.equal(telegramInboundMessage(event(1, { document: null }).message, '').parts[0].text, '')
})

test('Telegram downloads are bounded, use getFile, and sanitize network failures', async (t) => {
  botToken(t)
  const urls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url)
    assert.equal(options.redirect, 'error')
    if (url.endsWith('/getFile')) {
      assert.deepEqual(JSON.parse(options.body), { file_id: file.fileId })
      return Response.json({ ok: true, result: { file_path: 'documents/test.txt' } })
    }
    return new Response('hello')
  })
  assert.equal((await downloadTelegramFile(file)).toString(), 'hello')
  assert.equal(urls[1], 'https://api.telegram.org/file/bottest-token/documents/test.txt')
  await assert.rejects(downloadTelegramFile({ ...file, size: TELEGRAM_DOWNLOAD_LIMIT + 1 }), /20 MB/)
  assert.equal(urls.length, 2)
  for (const path of ['../escape', '/absolute', 'https://evil.example/path', 'a/../b']) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, result: { file_path: path } }))
    await assert.rejects(downloadTelegramFile(file), /could not download/)
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('test-token secret URL') })
  await assert.rejects(downloadTelegramFile(file), (error) => !error.message.includes('test-token'))
})

test('streaming downloads stop at the byte limit even without content-length', async (t) => {
  botToken(t)
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/getFile')
    ? Response.json({ ok: true, result: { file_path: 'documents/test.txt' } })
    : new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(TELEGRAM_DOWNLOAD_LIMIT + 1)) },
      cancel() { cancelled = true },
    })))
  await assert.rejects(downloadTelegramFile({ ...file, size: undefined }), /could not download/)
  assert.equal(cancelled, true)
})

test('return-file uploads preserve the destination and do not retry ambiguous sends', async (t) => {
  botToken(t)
  const target = { chat_id: 42, message_thread_id: 8, direct_messages_topic_id: 9 }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendDocument')
    assert.ok(options.body instanceof FormData)
    for (const [key, value] of Object.entries(target)) assert.equal(options.body.get(key), String(value))
    assert.equal(await options.body.get('document').text(), 'result')
    assert.equal(options.body.get('document').name, 'report.pdf')
    return Response.json({ ok: true, result: { message_id: 10 } })
  })
  assert.equal(await sendTelegramDocument(target, Buffer.from('result'), 'report.pdf'), '10')
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('test-token') })
  await assert.rejects(sendTelegramDocument(target, Buffer.from('result'), 'report.pdf'), /could not confirm file delivery/)
  assert.equal(calls, 2)
  await assert.rejects(sendTelegramDocument(target, new Uint8Array(), 'empty.pdf'), /between 1 byte/)
})

test('tools import only known uploads, preview data, control the desktop and clean up via v0', async () => {
  const fake = fakeDaytona()
  const sent = []
  const bundle = createDaytonaTools({ getClient: () => fake.client, getUploads: () => [file],
    download: async () => Buffer.from('hello'), sendFile: async (...args) => { sent.push(args); return '10' } })
  assert.equal((await run(bundle.tools.readUploadedFile, { attachmentId: 'invented', startPage: 1 })).ok, false)
  assert.equal(fake.calls.length, 0)
  const read = await run(bundle.tools.readUploadedFile, { attachmentId: file.id, startPage: 1 })
  assert.equal(read.text, 'hello')
  assert.match(read.path, /workspace\/uploads\/1-document-input.txt$/)
  assert.match(read.contentWarning, /untrusted/)
  await run(bundle.tools.readUploadedFile, { attachmentId: file.id, startPage: 2 })
  assert.equal(fake.calls.filter(([kind, command]) => kind === 'command' && command.includes('pip install')).length, 1)
  const image = await run(bundle.tools.computer, { action: 'screenshot' })
  const model = await bundle.tools.computer.toModelOutput({ output: image, toolCallId: 's', input: { action: 'screenshot' } })
  assert.equal(model.value[1].type, 'file')
  assert.equal(model.value[1].mediaType, 'image/jpeg')
  await run(bundle.tools.computer, { action: 'click', x: 20, y: 30 })
  assert.ok(fake.calls.some((call) => JSON.stringify(call) === '["click",20,30,"left"]'))
  assert.equal((await run(bundle.tools.sendSandboxFile, { path: '../secret', filename: 'secret' })).ok, false)
  assert.equal(sent.length, 0)
  const delivered = await run(bundle.tools.sendSandboxFile, { path: 'outputs/report.pdf', filename: 'report.pdf' })
  assert.equal(delivered.delivered, true)
  assert.equal(sent[0][0].toString(), 'result')
  const create = fake.calls.find(([kind]) => kind === 'create')[1]
  assert.equal(create.ephemeral, true)
  assert.equal(create.ttlMinutes, 15)
  assert.equal(create.envVars, undefined)
  await bundle.dispose()
  assert.ok(fake.calls.some(([kind, sandbox, seconds, wait]) => kind === 'delete' && sandbox.id === 'sandbox-test' && seconds === 60 && wait))
})

test('a new turn restores an earlier input path and installs PDF editing dependencies before executing code', async () => {
  const pdf = { ...file, filename: 'agreement.pdf', mediaType: 'application/pdf' }
  const first = fakeDaytona()
  const options = { getUploads: () => [pdf], download: async () => Buffer.from('input'), sendFile: async () => '1' }
  const uploadTurn = createDaytonaTools({ ...options, getClient: () => first.client })
  const read = await run(uploadTurn.tools.readUploadedFile, { attachmentId: pdf.id, startPage: 1 })
  await uploadTurn.dispose()
  const second = fakeDaytona()
  const editTurn = createDaytonaTools({ ...options, getClient: () => second.client })
  const command = `python3 -c 'import reportlab, PyPDF2, fitz; open("${read.path}", "rb")'`
  try {
    const result = await run(editTurn.tools.runSandboxCommand, { command, timeoutSeconds: 30 })
    assert.equal(result.ok, true)
    assert.equal(result.attachments[0].path, read.path)
    assert.equal(second.files.has(read.path), true, 'file is reimported without readUploadedFile in this turn')
    const installIndex = second.calls.findIndex(([kind, cmd]) => kind === 'command' && cmd.includes('pip install'))
    const commandIndex = second.calls.findIndex(([kind, cmd]) => kind === 'command' && cmd === command)
    assert.ok(installIndex >= 0 && installIndex < commandIndex)
    assert.match(second.calls[installIndex][1], /PyMuPDF.*reportlab.*PyPDF2/)
  } finally { await editTurn.dispose() }
})

test('command preparation selects explicit older attachments and stops before edits when setup fails', async () => {
  const fake = fakeDaytona()
  const older = { ...file, id: 'older', filename: 'older.pdf' }
  const latest = { ...file, id: 'latest', filename: 'latest.pdf' }
  const downloads = []
  const bundle = createDaytonaTools({ getClient: () => fake.client, getUploads: () => [older, latest],
    download: async (file) => { downloads.push(file.id); return Buffer.from('input') }, sendFile: async () => '1' })
  try {
    assert.equal((await run(bundle.tools.runSandboxCommand, { command: 'echo one', timeoutSeconds: 5, attachmentIds: ['older'] })).ok, true)
    assert.deepEqual(downloads, ['older'])
    assert.equal((await run(bundle.tools.runSandboxCommand, { command: 'echo two', timeoutSeconds: 5, attachmentIds: [] })).ok, true)
    assert.deepEqual(downloads, ['older'])
    assert.equal((await run(bundle.tools.runSandboxCommand, { command: 'echo three', timeoutSeconds: 5 })).ok, true)
    assert.deepEqual(downloads, ['older', 'latest'])
    assert.equal(fake.calls.filter(([kind, cmd]) => kind === 'command' && cmd.includes('pip install')).length, 1)
  } finally { await bundle.dispose() }
  const failed = fakeDaytona()
  const execute = failed.client.v0.create
  failed.client.v0.create = async (params) => {
    const sandbox = await execute(params)
    sandbox.process.executeCommand = async (command) => {
      failed.calls.push(['command', command])
      return { exitCode: 1, result: 'dependency installation failed' }
    }
    return sandbox
  }
  const failedBundle = createDaytonaTools({ getClient: () => failed.client, getUploads: () => [], sendFile: async () => '1' })
  try {
    const result = await run(failedBundle.tools.runSandboxCommand, { command: 'must-not-run', timeoutSeconds: 5 })
    assert.equal(result.ok, false)
    assert.match(result.message, /Document tool setup failed in this attempt/)
    assert.ok(!failed.calls.some(([kind, cmd]) => kind === 'command' && cmd === 'must-not-run'))
  } finally { await failedBundle.dispose() }
})

test('operations sanitize provider errors, respect cancellation and keep workspaces separate', async () => {
  const fake = fakeDaytona()
  const options = { getClient: () => fake.client, getUploads: () => [], sendFile: async () => '1' }
  const first = createDaytonaTools(options)
  const second = createDaytonaTools(options)
  fake.fail(new Error('Authorization: super-secret-key'))
  const result = await run(first.tools.runSandboxCommand, { command: 'false', timeoutSeconds: 5 })
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /super-secret/)
  await run(second.tools.runSandboxCommand, { command: 'false', timeoutSeconds: 5 })
  const names = fake.calls.filter(([kind]) => kind === 'create').map(([, params]) => params.name)
  assert.notEqual(names[0], names[1])
  const before = fake.calls.length
  await assert.rejects(run(first.tools.runSandboxCommand, { command: 'echo forbidden', timeoutSeconds: 5 },
    { abortSignal: AbortSignal.abort() }))
  assert.equal(fake.calls.length, before)
  await first.dispose()
  await second.dispose()
})

test('uncertain delivery is reported without inviting an automatic resend', async () => {
  const fake = fakeDaytona()
  const bundle = createDaytonaTools({ getClient: () => fake.client, getUploads: () => [],
    sendFile: async () => { throw new Error('network error with token') } })
  try {
    const result = await run(bundle.tools.sendSandboxFile, { path: 'outputs/result.txt', filename: 'result.txt' })
    assert.equal(result.ok, false)
    assert.match(result.message, /Do not automatically resend/)
    assert.doesNotMatch(result.message, /token/)
  } finally { await bundle.dispose() }
})

test('timed-out creation is recovered by unique name for cleanup', async () => {
  const fake = fakeDaytona()
  fake.client.v0.create = async (params) => { fake.calls.push(['create', params]); throw new Error('create timeout') }
  fake.client.v0.get = async (name) => { fake.calls.push(['get', name]); return { id: 'timed-out-sandbox' } }
  const bundle = createDaytonaTools({ getClient: () => fake.client, getUploads: () => [], sendFile: async () => '1' })
  assert.equal((await run(bundle.tools.runSandboxCommand, { command: 'echo hello', timeoutSeconds: 5 })).ok, false)
  await bundle.dispose()
  assert.equal(fake.calls.find(([kind]) => kind === 'get')[1], fake.calls.find(([kind]) => kind === 'create')[1].name)
  assert.equal(fake.calls.find(([kind]) => kind === 'delete')[1].id, 'timed-out-sandbox')
})

test('real Trigger channel receives a file-only update, reads it and returns a document to the same topic', { timeout: 30_000 }, async (t) => {
  botToken(t)
  const warnings = []
  t.mock.method(logger, 'warn', (message) => { warnings.push(message) })
  const fake = fakeDaytona()
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url)
    if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'documents/input.txt' } })
    if (url.includes('/file/')) return new Response('hello')
    if (url.endsWith('/sendDocument')) {
      assert.equal(options.body.get('chat_id'), '42')
      assert.equal(options.body.get('message_thread_id'), '8')
      assert.equal(await options.body.get('document').text(), 'result')
    }
    return Response.json({ ok: true, result: { message_id: requests.length } })
  })
  let step = 0
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 } }
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    const i = step++ % 4
    assert.match(JSON.stringify(options.prompt), /Uploaded file/)
    let chunks
    if (i < 3) {
      const toolName = i === 0 ? 'readUploadedFile' : i === 1 ? 'computer' : 'sendSandboxFile'
      const input = i === 0 ? { attachmentId: file.id, startPage: 1 } : i === 1 ? { action: 'screenshot' }
        : { path: `${SANDBOX_WORKSPACE}/outputs/result.txt`, filename: 'result.txt' }
      if (i === 1) assert.match(JSON.stringify(options.prompt), /"text":"hello"/)
      if (i === 2) assert.match(JSON.stringify(options.prompt), /"mediaType":"image\/jpeg"/)
      chunks = [{ type: 'tool-call', toolCallId: `file-${i}`, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]
    } else {
      assert.match(JSON.stringify(options.prompt), /"delivered":true/)
      chunks = [{ type: 'text-start', id: 'done' }, { type: 'text-delta', id: 'done', delta: 'Returned the file.' },
        { type: 'text-end', id: 'done' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]
    }
    return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
  } })
  const agent = createTelegramAgent(model, () => ({}), () => createDaytonaTools({ getClient: () => fake.client,
    getUploads: () => chat.surface().uploads(), sendFile: (...args) => chat.surface().sendFile(...args) }))
  const harness = mockChatAgent(agent, { chatId: 'file-channel-test' })
  try {
    await harness.sendChannelEvent({ connectorId: 'telegram-chat', deliveryId: 'file-1',
      event: event(1, { message_thread_id: 8 }) })
  } finally { await harness.close() }
  assert.equal(step, 4)
  assert.equal(requests.filter((url) => url.endsWith('/sendDocument')).length, 1)
  assert.ok(fake.calls.some(([kind]) => kind === 'delete'))
  const snapshot = harness.getSnapshot()
  assert.match(JSON.stringify(snapshot), /data-telegram-upload/)
  assert.doesNotMatch(JSON.stringify(snapshot), /bottest-token/)
  const resumed = mockChatAgent(agent, { chatId: 'file-channel-test', mode: 'continuation', snapshot })
  try {
    await resumed.sendChannelEvent({ connectorId: 'telegram-chat', deliveryId: 'file-2',
      event: { update_id: 2, message: { message_id: 2, chat: { id: 42, type: 'private' }, message_thread_id: 8,
        text: 'Use my previous upload again.' } } })
  } finally { await resumed.close() }
  assert.equal(step, 8)
  assert.equal(requests.filter((url) => url.endsWith('/getFile')).length, 2, 'a fresh worker reimports the saved file reference')
  assert.equal(requests.filter((url) => url.endsWith('/sendMessage')).length, 2, 'automatic response capture preserves text egress')
  assert.equal(fake.calls.filter(([kind]) => kind === 'delete').length, 2)
  assert.ok(!warnings.some((message) => message.includes('tools() resolver threw at boot')), 'history tools resolve before onBoot without mutating chat.local')
})

test('upload then Watermark only on a fresh worker creates and sends a verified PDF without another read call', { timeout: 30_000 }, async (t) => {
  botToken(t)
  const sandboxes = []
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url)
    if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'documents/agreement.pdf' } })
    if (url.includes('/file/')) return new Response('synthetic PDF fixture')
    if (url.endsWith('/sendDocument')) assert.equal(options.body.get('document').name, 'sample-watermarked.pdf')
    return Response.json({ ok: true, result: { message_id: requests.length } })
  })
  let step = 0
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 } }
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    const i = step++
    let call
    if (i === 0) call = ['readUploadedFile', { attachmentId: file.id, startPage: 1 }]
    if (i === 2) call = ['watermarkPdf', { attachmentId: file.id, text: 'SAMPLE - NOT FOR SIGNING' }]
    if (i === 3) {
      assert.match(JSON.stringify(options.prompt), /"verified":true/)
      const lastTool = options.prompt.filter((m) => m.role === 'tool').at(-1)
      const result = lastTool.content.at(-1).output.value
      call = ['sendSandboxFile', { path: result.path, filename: 'sample-watermarked.pdf' }]
    }
    const chunks = call ? [{ type: 'tool-call', toolCallId: `watermark-${i}`, toolName: call[0], input: JSON.stringify(call[1]) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]
      : [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: i === 1 ? 'I can add a watermark.' : 'Sent the watermarked PDF.' },
        { type: 'text-end', id: 'reply' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]
    return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
  } })
  const agent = createTelegramAgent(model, () => ({}), () => {
    const fake = fakeDaytona()
    sandboxes.push(fake)
    return createDaytonaTools({ getClient: () => fake.client,
      getUploads: () => chat.surface().uploads(), sendFile: (...args) => chat.surface().sendFile(...args) })
  })
  const first = mockChatAgent(agent, { chatId: 'watermark-followup' })
  try { await first.sendChannelEvent({ connectorId: 'telegram-chat', deliveryId: 'upload', event: event() }) }
  finally { await first.close() }
  const resumed = mockChatAgent(agent, { chatId: 'watermark-followup', mode: 'continuation', snapshot: first.getSnapshot() })
  try {
    await resumed.sendChannelEvent({ connectorId: 'telegram-chat', deliveryId: 'watermark', event: {
      update_id: 2, message: { message_id: 2, chat: { id: 42, type: 'private' }, text: 'Watermark only' },
    } })
  } finally { await resumed.close() }
  assert.equal(step, 5)
  assert.equal(requests.filter((url) => url.endsWith('/getFile')).length, 2)
  assert.equal(requests.filter((url) => url.endsWith('/sendDocument')).length, 1)
  const used = sandboxes.filter((fake) => fake.calls.some(([kind]) => kind === 'create'))
  assert.equal(used.length, 2)
  assert.ok(used.every((fake) => fake.calls.some(([kind]) => kind === 'delete')))
  assert.ok(!used[1].calls.some(([kind, cmd]) => kind === 'command' && cmd.includes('parse_upload.py')),
    'watermark tool imports directly instead of relying on the reader tool to bootstrap the turn')
})
