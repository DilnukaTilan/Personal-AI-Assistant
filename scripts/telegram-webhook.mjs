async function telegramRequest(method, token, body) {
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN.')
  let response
  let result
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    })
    result = await response.json()
  } catch {
    // Never propagate a network error containing the bot-token URL.
    throw new Error(`Could not reach Telegram for ${method}.`)
  }
  if (!response.ok || result?.ok !== true) {
    throw new Error(`Telegram rejected ${method}. Check the credentials and webhook configuration.`)
  }
  return result.result
}

export async function getTelegramWebhookInfo(token = process.env.TELEGRAM_BOT_TOKEN) {
  const info = await telegramRequest('getWebhookInfo', token)
  if (!info || typeof info.url !== 'string' || !Number.isSafeInteger(info.pending_update_count)) {
    throw new Error('Telegram returned invalid webhook information.')
  }
  return info
}

export async function registerTelegramWebhook(url, {
  token = process.env.TELEGRAM_BOT_TOKEN,
  secret = process.env.TELEGRAM_WEBHOOK_SECRET,
} = {}) {
  let endpoint
  try {
    endpoint = new URL(url)
  } catch {
    throw new Error('Pass the hosted HTTPS Trigger.dev endpoint URL: npm run webhook:set -- https://<endpoint>')
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('The webhook URL must use HTTPS without credentials or a fragment.')
  }
  if (!token || !secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (1–256 letters, digits, underscores or hyphens).')
  }
  const result = await telegramRequest('setWebhook', token, {
    url: endpoint.href,
    secret_token: secret,
    allowed_updates: ['message'],
    max_connections: 1,
    // Preserve queued messages during the cutover.
    drop_pending_updates: false,
  })
  if (result !== true) throw new Error('Telegram did not confirm webhook registration.')
  const info = await getTelegramWebhookInfo(token)
  if (info.url !== endpoint.href) throw new Error('Telegram webhook URL verification failed.')
  return info
}
