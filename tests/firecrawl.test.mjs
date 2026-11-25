import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Firecrawl from 'firecrawl'
import { createFirecrawlTools } from '../src/firecrawl.ts'

const contract = {
  provider: 'example', capability: 'listings/search', description: 'Search available listings',
  options: [{ name: 'city', type: 'string', required: true }, { name: 'date', type: 'string' },
    { name: 'week', type: 'string' }], requiresOneOf: [['date', 'week']],
  response: { key: 'listings' },
}
const context = (signal) => ({ toolCallId: 'test-call', messages: [], abortSignal: signal })

async function serverClient(t, respond) {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ path: req.url, body })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(respond(req.url, body)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const client = new Firecrawl({ apiKey: 'fc-test', apiUrl: `http://127.0.0.1:${server.address().port}`,
    maxRetries: 1, timeoutMs: 1000 })
  return { client, requests }
}

test('real SDK discovers contracts and executes structured retrieval with required inputs', async (t) => {
  const { client, requests } = await serverClient(t, (path, body) => path === '/v2/search'
    ? { success: true, data: { web: [{ url: 'https://example.com' }], tools: [contract] } }
    : { success: true, scrape_id: 'scrape-test', data: { creditsCost: 1, alexandria: [
      { provider: 'example', capability: contract.capability, creditsCost: 1,
        data: { listings: [{ name: 'Available table', url: 'https://example.com/table' }] } },
      { provider: 'example', capability: 'other', error: { code: 'unavailable', message: 'private upstream detail' } },
    ] } })
  const tools = createFirecrawlTools(() => client)
  const query = { provider: 'example', capability: contract.capability, optionsJson: '{}' }
  assert.equal((await tools.queryDataTool.execute(query, context())).code, 'INSPECT_FIRST')
  const search = await tools.webSearch.execute({ query: 'restaurant tables in Colombo tomorrow', mode: 'web', limit: 3 }, context())
  assert.equal(search.ok, true)
  assert.deepEqual(requests[0].body.sources, ['web', 'alexandria'])
  assert.equal(requests[0].body.toolDetail, 'full')
  assert.equal((await tools.queryDataTool.execute(query, context())).code, 'MISSING_INPUT')
  assert.equal((await tools.queryDataTool.execute({ ...query, optionsJson: '{"city":"Colombo"}' }, context())).code, 'MISSING_INPUT')
  assert.equal((await tools.queryDataTool.execute({ ...query, optionsJson: '[]' }, context())).code, 'INVALID_OPTIONS')
  const result = await tools.queryDataTool.execute({ ...query, optionsJson: '{"city":"Colombo","date":"2026-11-26"}' }, context())
  assert.equal(requests.length, 2, 'invalid or undiscovered calls never reach the API')
  assert.deepEqual(requests[1].body.alexandria, [{ provider: 'example', capability: contract.capability,
    options: { city: 'Colombo', date: '2026-11-26' } }])
  assert.equal(result.data.results[0].data.listings[0].name, 'Available table')
  assert.equal(result.data.results[1].ok, false)
  assert.equal(result.data.results[1].code, 'unavailable')
  assert.doesNotMatch(JSON.stringify(result), /private upstream detail/)
  const anotherTurn = createFirecrawlTools(() => client)
  assert.equal((await anotherTurn.queryDataTool.execute(query, context())).code, 'INSPECT_FIRST')
})

test('real SDK inspection unlocks a contract; page reading preserves sources and bounds output', async (t) => {
  const { client, requests } = await serverClient(t, (_, body) => body.url
    ? { success: true, data: { markdown: 'x'.repeat(40_000), metadata: { sourceURL: body.url, title: 'Source' } } }
    : { success: true, data: { creditsCost: 0, alexandria: [{ provider: 'firecrawl', capability: 'find-tools',
      creditsCost: 0, data: { level: 'tools', items: [contract], total: 1, next: null } }] } })
  const tools = createFirecrawlTools(() => client)
  const inspected = await tools.inspectDataTool.execute({ provider: 'example', capability: contract.capability }, context())
  assert.equal(inspected.ok, true)
  assert.deepEqual(requests[0].body.alexandria[0].options.expand, ['options', 'response', 'examples'])
  assert.equal((await tools.queryDataTool.execute({ provider: 'example', capability: contract.capability, optionsJson: '{}' }, context())).code, 'MISSING_INPUT')
  const page = await tools.readWebPage.execute({ url: 'https://example.com/prices', fresh: true }, context())
  assert.equal(requests[1].body.maxAge, 0)
  assert.deepEqual(requests[1].body.parsers, [{ type: 'pdf', maxPages: 5 }])
  assert.equal(requests[1].body.autoResume, undefined, 'SDK-only setting must not be sent to the API')
  assert.equal(page.truncated, true)
  assert.match(page.excerpt, /https:\/\/example.com\/prices/)
  assert.ok(page.excerpt.length <= 30_000)
})

test('unconfigured credentials and provider failures are safe; cancellation prevents new work', async () => {
  const tools = createFirecrawlTools(() => undefined)
  assert.equal((await tools.webSearch.execute({ query: 'current prices', mode: 'web', limit: 1 }, context())).code, 'NOT_CONFIGURED')
  const broken = createFirecrawlTools(() => { throw new Error('Authorization: Bearer fc-private') })
  const result = await broken.readWebPage.execute({ url: 'https://example.com', fresh: false }, context())
  assert.equal(result.code, 'LOOKUP_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(result), /fc-private|Authorization/)
  await assert.rejects(broken.webSearch.execute({ query: 'news', mode: 'news', limit: 1 }, context(AbortSignal.abort())))
  let started = false
  const slow = createFirecrawlTools(() => ({ search: () => { started = true; return new Promise(() => {}) } }))
  const controller = new AbortController()
  const pending = slow.webSearch.execute({ query: 'news', mode: 'news', limit: 1 }, context(controller.signal))
  assert.equal(started, true)
  controller.abort()
  await assert.rejects(pending)
})

test('catalogue code execution and agreement acceptance are not exposed', async () => {
  const tools = createFirecrawlTools(() => ({ search: async () => ({ tools: [
    { ...contract, provider: 'firecrawl', capability: 'bash' },
    { ...contract, provider: 'firecrawl', capability: 'terms/accept' },
  ] }) }))
  await tools.webSearch.execute({ query: 'data', mode: 'dataTools', limit: 1 }, context())
  for (const capability of ['bash', 'terms/accept']) {
    assert.equal((await tools.queryDataTool.execute({ provider: 'firecrawl', capability, optionsJson: '{}' }, context())).code, 'READ_ONLY')
  }
})
