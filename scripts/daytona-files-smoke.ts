import assert from 'node:assert/strict'
import { z } from 'zod'
import { createDaytonaTools } from '../src/daytona.js'
import type { TelegramUpload } from '../src/telegram-files.js'

// Live Daytona, synthetic incoming files, and a captured return-file transport.
// This never sends messages/files to an actual Telegram conversation.
const fixtures = new Map<string, Buffer>([['text', Buffer.from('Hello from a Telegram upload fixture.')]])
const uploads: TelegramUpload[] = [
  { id: 'text', fileId: 'synthetic-text', filename: 'input.txt', mediaType: 'text/plain' },
  { id: 'pdf', fileId: 'synthetic-pdf', filename: 'sample.pdf', mediaType: 'application/pdf' },
  { id: 'docx', fileId: 'synthetic-docx', filename: 'sample.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'xlsx', fileId: 'synthetic-xlsx', filename: 'sample.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'png', fileId: 'synthetic-png', filename: 'sample.png', mediaType: 'image/png' },
]
const fileOptions = {
  getUploads: () => uploads.filter((file) => fixtures.has(file.id)),
  download: async (file: TelegramUpload) => {
    const data = fixtures.get(file.id)
    if (!data) throw new Error('Fixture is not ready')
    return data
  },
  sendFile: async (data: Uint8Array, filename: string) => {
    fixtures.set(filename.split('.')[0]!, Buffer.from(data))
    console.log(`Captured return-file upload: ${filename} (${data.byteLength} bytes)`)
    return `fixture-${filename}`
  },
}
const bundle = createDaytonaTools(fileOptions)
const context = { toolCallId: 'smoke', messages: [] }
async function check(name: keyof typeof bundle.tools, input: unknown, target = bundle) {
  const tool = target.tools[name]
  const parsed = (tool.inputSchema as z.ZodType).parse(input)
  const result = await tool.execute!(parsed as never, { ...context, context: {} })
  assert.ok('ok' in result, 'Smoke tools return one result rather than a stream')
  assert.equal(result.ok, true, `${name}: ${JSON.stringify({ ...result, imageBase64: undefined }).slice(0, 2000)}`)
  return result
}

try {
  assert.ok(process.env.DAYTONA_API_KEY?.trim(), 'DAYTONA_API_KEY must be set')
  const text = await check('readUploadedFile', { attachmentId: 'text' })
  assert.match(String(text.text), /Hello from a Telegram upload fixture/)
  console.log('Text upload and parser installation passed.')
  await check('runSandboxCommand', { command: `python3 - <<'PY'
from reportlab.pdfgen import canvas
from docx import Document
from openpyxl import Workbook
from PIL import Image
c = canvas.Canvas('outputs/pdf.pdf')
c.drawString(50, 760, 'SAMPLE - NOT A REAL AGREEMENT')
c.drawString(50, 720, 'Hello from a PDF upload fixture.')
c.save()
d = Document(); d.add_paragraph('Hello from a DOCX upload fixture.'); d.save('outputs/docx.docx')
w = Workbook(); w.active.append(['Hello from an XLSX upload fixture.', 42]); w.save('outputs/xlsx.xlsx')
Image.new('RGB', (320, 200), 'teal').save('outputs/png.png')
PY` })
  for (const ext of ['pdf', 'docx', 'xlsx', 'png']) {
    await check('sendSandboxFile', { path: `outputs/${ext}.${ext}`, filename: `${ext}.${ext}` })
    const result = await check('readUploadedFile', { attachmentId: ext })
    if (ext === 'png') assert.ok(result.imageBase64)
    else assert.match(String(result.text), new RegExp(`Hello from a[n]? ${ext.toUpperCase()} upload fixture`))
    console.log(`${ext.toUpperCase()} generation, transfer, reimport, and parsing passed.`)
  }
  await check('runSandboxCommand', { command: `python3 - <<'PY'
import fitz
doc = fitz.open('uploads/pdf-sample.pdf')
doc[0].insert_text((50, 130), 'Mock signature: Example Person (FICTIONAL)', fontsize=12)
doc.save('outputs/returned-sample.pdf')
assert 'FICTIONAL' in fitz.open('outputs/returned-sample.pdf')[0].get_text()
print('Verified modified sample PDF')
PY` })
  await check('sendSandboxFile', { path: 'outputs/returned-sample.pdf', filename: 'returned-sample.pdf' })
  assert.equal(fixtures.get('returned-sample')?.subarray(0, 5).toString(), '%PDF-')
  await check('runSandboxCommand', { command: `python3 - <<'PY'
import fitz, json, subprocess
scan = fitz.open()
for i in range(2):
    page = scan.new_page()
    page.insert_image(fitz.Rect(50, 50, 370, 250), filename='outputs/png.png')
scan.save('outputs/scanned.pdf')
parsed = json.loads(subprocess.check_output(['python3', 'parse_upload.py', 'outputs/scanned.pdf', '1']))
assert parsed['imageBase64'] and 'No embedded text' in parsed['note']
doc = fitz.open()
for i in range(7):
    page = doc.new_page(); page.insert_text((50, 50), 'Page number ' + str(i+1))
doc.save('outputs/pages.pdf')
parsed = json.loads(subprocess.check_output(['python3', 'parse_upload.py', 'outputs/pages.pdf', '6']))
assert 'Page number 6' in parsed['text'] and 'Page number 1' not in parsed['text']
print('Scanned PDF and pagination verified')
PY` })
  for (const input of [{ action: 'screenshot' }, { action: 'move', x: 100, y: 100 },
    { action: 'press', key: 'ctrl+alt+t' }, { action: 'type', text: 'echo Daytona-computer-smoke' },
    { action: 'press', key: 'enter' }]) {
    const result = await check('computer', input)
    const jpeg = Buffer.from(String(result.imageBase64), 'base64')
    assert.ok(jpeg.length > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8)
  }
  console.log('Live desktop screenshots, mouse and keyboard passed.')
} finally {
  await bundle.dispose()
  console.log('Sandbox deletion completed.')
}

// Reproduce Telegram's upload -> later watermark request across sandbox deletion.
const followup = createDaytonaTools({ ...fileOptions, getUploads: () => [uploads[1]!] })
try {
  const restored = await check('runSandboxCommand', { command: `python3 - <<'PY'
import fitz, reportlab, PyPDF2
from pathlib import Path
assert Path('uploads/pdf-sample.pdf').is_file()
print('Fresh-turn imports and PDF libraries verified')
PY` }, followup)
  assert.match(String(restored.output), /Fresh-turn imports and PDF libraries verified/)
  const edited = await check('watermarkPdf', { attachmentId: 'pdf', text: 'SAMPLE — NOT FOR SIGNING / NOT FOR EXECUTION' }, followup)
  assert.equal(edited.verified, true)
  await check('sendSandboxFile', { path: edited.path, filename: 'followup-watermarked.pdf' }, followup)
  assert.equal(fixtures.get('followup-watermarked')?.subarray(0, 5).toString(), '%PDF-')
  console.log('Fresh-turn automatic reimport, dependency setup, verified PDF watermark, and return-file transfer passed.')
} finally {
  await followup.dispose()
  console.log('Follow-up sandbox deletion completed.')
}
