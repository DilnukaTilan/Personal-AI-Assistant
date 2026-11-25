import { registerTelegramWebhook } from './telegram-webhook.mjs'

try {
  const info = await registerTelegramWebhook(process.argv[2])
  console.log(`Telegram webhook registered and verified. Pending updates: ${info.pending_update_count}.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
