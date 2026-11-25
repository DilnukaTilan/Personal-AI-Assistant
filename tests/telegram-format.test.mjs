import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeHTML } from 'entities'
import { formatTelegramReply } from '../src/telegram-format.ts'

const format = (markdown) => formatTelegramReply(markdown).map((chunk) => chunk.html).join('')
const visible = (html) => decodeHTML(html.replace(/<[^>]*>/g, ''))

function validChunk(html) {
  const stack = []
  for (const match of html.matchAll(/<([^>]+)>/g)) {
    const name = match[1].match(/^\/?(\w+)/)?.[1]
    assert.ok(['b', 'i', 's', 'a', 'blockquote', 'pre', 'code'].includes(name))
    if (match[1].startsWith('/')) assert.equal(stack.pop(), name)
    else {
      if (name === 'blockquote') assert.ok(!stack.includes(name))
      if (name === 'a') assert.ok(!stack.includes('a') && !stack.includes('blockquote'))
      if (name === 'code') assert.ok(stack.length === 0 || stack.join() === 'pre')
      stack.push(name)
    }
  }
  assert.deepEqual(stack, [])
  assert.ok(visible(html).length <= 4096)
  assert.ok(visible(html).isWellFormed())
}

test('renders headings, nested emphasis, lists, links, quotes, and code using Telegram tags', () => {
  assert.equal(format('# Title\n\n**bold _italic_** and ~~old~~'),
    '<b>Title</b>\n\n<b>bold <i>italic</i></b> and <s>old</s>')
  assert.equal(format('- one\n- two\n  - child\n\n3. three\n4. four'),
    '• one\n• two\n  • child\n\n3. three\n4. four')
  assert.equal(format('- [x] done\n- [ ] pending'), '• ☑ done\n• ☐ pending')
  assert.equal(format('> **Quote**\n> next\n\n[Read](https://example.com/?a=1&b=2)'),
    '<blockquote><b>Quote</b>\nnext</blockquote>\n\n<a href="https://example.com/?a=1&amp;b=2">Read</a>')
  assert.equal(format('`**literal** &amp; <x>`\n\n```js\nif (a < b) x = "&";\n```'),
    '<code>**literal** &amp;amp; &lt;x&gt;</code>\n\n<pre><code class="language-js">if (a &lt; b) x = &quot;&amp;&quot;;</code></pre>')
  assert.equal(format('    code < &'), '<pre>code &lt; &amp;</pre>')
  assert.equal(format('```\n  indented  \n```'), '<pre>  indented  </pre>')
  assert.equal(format('[reference][source]\n\n[source]: https://example.com'), '<a href="https://example.com">reference</a>')
})

test('tables become numbered mobile-friendly records with formatted headers and cell values', () => {
  assert.equal(format('| Name | Price | Link |\n| :--- | ---: | --- |\n| **Tea** | $2 | [Buy](https://example.com) |\n| A \\| B | | `x\\|y` |'),
    '1. <b>Name</b>: <b>Tea</b>\n   <b>Price</b>: $2\n   <b>Link</b>: <a href="https://example.com">Buy</a>\n\n'
    + '2. <b>Name</b>: A | B\n   <b>Price</b>: \n   <b>Link</b>: <code>x|y</code>')
  assert.equal(format('Name | Price\n--- | ---\nTea | $2'), '1. <b>Name</b>: Tea\n   <b>Price</b>: $2')
})

test('escapes literal HTML and special characters, decodes entities once, and rejects unsafe URLs', () => {
  assert.equal(format('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  assert.equal(format('A &amp; B &copy; &lt;b&gt; \\*literal\\* snake_case 2 < 3'),
    'A &amp; B © &lt;b&gt; *literal* snake_case 2 &lt; 3')
  assert.equal(format('[unsafe](javascript:alert%281%29) [relative](/local)'), 'unsafe relative')
  assert.equal(format('[encoded](javascript&#58;alert%281%29)'), 'encoded')
  assert.equal(format('[ok](https://example.com/?a=1&amp;b=2)'), '<a href="https://example.com/?a=1&amp;b=2">ok</a>')
  assert.equal(format('https://example.com/?a=1&amp;b=2'),
    '<a href="https://example.com/?a=1&amp;amp;b=2">https://example.com/?a=1&amp;amp;b=2</a>')
  assert.equal(format('[mail](mailto:a@example.com)'), '<a href="mailto:a@example.com">mail</a>')
  assert.equal(format('[x](https://example.com/%22onmouseover=%22)'), '<a href="https://example.com/%22onmouseover=%22">x</a>')
})

test('avoids unsupported entity nesting and handles incomplete Markdown literally', () => {
  const html = format('> outer\n> > nested **bold `code`** [link](https://example.com)\n\n**unfinished\n\n```\n<x> & **literal**')
  validChunk(html)
  assert.match(html, /<code>code<\/code>/)
  assert.doesNotMatch(html, /<b><code>/)
  assert.match(html, /\*\*unfinished/)
  assert.match(html, /<pre>&lt;x&gt; &amp; \*\*literal\*\*<\/pre>/)
})

test('chunks preserve visible text, complete entities, balanced tags, code, links, and emoji', () => {
  for (const [markdown, expected] of [
    ['**' + 'a & < > 👋 '.repeat(1200).trimEnd() + '**', 'a & < > 👋 '.repeat(1200).trimEnd()],
    ['> ' + 'x'.repeat(9000), 'x'.repeat(9000)],
    ['```python\n' + '<&👋'.repeat(3000) + '\n```', '<&👋'.repeat(3000)],
    ['[' + '👋&'.repeat(3000) + '](https://example.com/?a=1&b=2)', '👋&'.repeat(3000)],
    ['x'.repeat(4095) + '👋end', 'x'.repeat(4095) + '👋end'],
  ]) {
    const chunks = formatTelegramReply(markdown)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) validChunk(chunk.html)
    assert.equal(chunks.map((chunk) => visible(chunk.html)).join(''), expected)
    // Inline marker characters must never reappear at split boundaries.
    assert.doesNotMatch(chunks.map((c) => c.html).join(''), /\*\*|```/)
  }
  const text = 'x'.repeat(4095) + '👋end'
  assert.equal(formatTelegramReply(text).map((c) => visible(c.html)).join(''), text)
  assert.equal(formatTelegramReply('&'.repeat(4096)).length, 1, 'escaped size is not the visible size')
})

test('plain fallbacks retain links and literal HTML without Telegram tags or Markdown syntax', () => {
  assert.deepEqual(formatTelegramReply('## Heading\n\n[**Read**](https://example.com/?a=1&b=2) and `<b>x</b>`'), [{
    html: '<b>Heading</b>\n\n<a href="https://example.com/?a=1&amp;b=2"><b>Read</b></a> and <code>&lt;b&gt;x&lt;/b&gt;</code>',
    text: 'Heading\n\nRead (https://example.com/?a=1&b=2) and <b>x</b>',
  }])
  assert.deepEqual(formatTelegramReply(' \n\t '), [])
})
