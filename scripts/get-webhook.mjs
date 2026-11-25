import { getTelegramWebhookInfo } from './telegram-webhook.mjs'

try {
  const info = await getTelegramWebhookInfo()
  console.log(JSON.stringify({
    url: info.url,
    pending_update_count: info.pending_update_count,
    allowed_updates: info.allowed_updates,
    max_connections: info.max_connections,
    last_error_date: info.last_error_date,
    last_error_message: info.last_error_message,
  }, null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
