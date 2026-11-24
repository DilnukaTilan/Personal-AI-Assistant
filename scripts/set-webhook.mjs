const url = process.argv[2]
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET

try {
  if (!url || new URL(url).protocol !== 'https:') {
    throw new Error('Pass the public HTTPS webhook URL: npm run webhook:set -- https://example.com/telegram/webhook')
  }
  if (!token || !secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (1–256 letters, digits, underscores or hyphens).')
  }

  let response
  let result
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
      signal: AbortSignal.timeout(15_000),
    })
    result = await response.json()
  } catch {
    throw new Error('Could not reach Telegram to register the webhook.')
  }
  if (!response.ok || result?.ok !== true) {
    throw new Error('Telegram rejected the webhook registration. Check the credentials and public HTTPS URL.')
  }
  console.log('Telegram webhook registered successfully.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
