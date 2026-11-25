import assert from 'node:assert/strict'
import { openai } from '@ai-sdk/openai'
import { generateText, isStepCount } from 'ai'
import { createDaytonaTools } from '../src/daytona.js'
import { telegramInstructions } from '../src/telegram-instructions.js'

// A synthetic, valid one-page PDF; no customer document or chat history is used.
function samplePdf(): Buffer {
  const stream = 'BT /F1 20 Tf 50 740 Td (SAMPLE DOCUMENT - FICTIONAL TEMPLATE) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function main() {
  assert.ok(process.env.OPENAI_API_KEY?.trim() && process.env.DAYTONA_API_KEY?.trim(), 'Configure OpenAI and Daytona before this live test')
  let returned: Uint8Array | undefined
  const bundle = createDaytonaTools({
    getUploads: () => [{ id: 'sample-pdf', fileId: 'synthetic', filename: 'sample.pdf', mediaType: 'application/pdf' }],
    download: async () => samplePdf(),
    sendFile: async (data) => { returned = data; return 'captured-smoke-delivery' },
  })
  try {
    const result = await generateText({
      model: openai('gpt-5.4-nano'),
      instructions: telegramInstructions,
      messages: [
        { role: 'user', content: 'Uploaded file: {"attachmentId":"sample-pdf","filename":"sample.pdf","mediaType":"application/pdf"}\nThis is a fictional sample. Please add a sample watermark and return the PDF.' },
        { role: 'assistant', content: 'An earlier attempt failed because the PDF libraries were missing. I can add a diagonal watermark reading "SAMPLE - NOT FOR SIGNING / NOT FOR EXECUTION". Reply with "Watermark only".' },
        { role: 'user', content: 'Watermark only' },
      ],
      tools: bundle.tools,
      stopWhen: isStepCount(6),
      maxOutputTokens: 2000,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(210_000),
      providerOptions: { openai: { reasoningEffort: 'none' } },
    })
    const calls = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName))
    console.log(`Live model chose: ${calls.join(' -> ') || 'no tools'}`)
    assert.ok(calls.includes('watermarkPdf') && calls.includes('sendSandboxFile'), 'Model must attempt and deliver the requested watermark instead of repeating the old failure')
    assert.ok(returned && Buffer.from(returned).subarray(0, 5).toString() === '%PDF-', 'Return-file transport must receive PDF bytes')
    console.log('Live OpenAI + Daytona watermark follow-up passed; delivery captured without sending a Telegram message.')
  } finally {
    await bundle.dispose()
    console.log('Watermark sandbox deletion completed.')
  }
}

main().catch(() => {
  console.error('Live watermark verification failed. Check the preceding tool-call summary; no credentials are printed.')
  process.exitCode = 1
})
