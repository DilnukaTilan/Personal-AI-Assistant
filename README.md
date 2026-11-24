# Telegram echo bot

Deployed on Railway: https://personal-assistant-production-344f73aa.up.railway.app

Webhook URL: `https://personal-assistant-production-344f73aa.up.railway.app/telegram/webhook`.
The server binds to `0.0.0.0` and uses Railway's `PORT` environment variable
(3000 locally). Node.js 24 is selected through `package.json`.

A Hono Node.js webhook at `POST /telegram/webhook`. It echoes new text messages,
photos, stickers, voice messages, documents and other supported content to the
same chat using Telegram's `copyMessage` API. Text, formatting and media captions
are preserved by Telegram. Forum topics are preserved too.

## Setup

Install dependencies with `npm ci`. Set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_WEBHOOK_SECRET` in the environment or a local `.env` file (see
`.env.example`). The secret must contain 1–256 letters, digits, underscores or
hyphens. Credentials and Firecrawl research output are ignored by Git.

Build with `npm run build`, then run with `npm start`. The Node entry point listens
on port 3000. Expose it through a public HTTPS endpoint, then register the complete
webhook URL:

```sh
npm run webhook:set -- https://your-domain.example/telegram/webhook
```

Registration sends the secret to Telegram and subscribes to new `message` updates.
Send a message to the bot in Telegram to receive the echo. In groups, Telegram's
bot privacy settings determine which messages the bot receives.

## Verification without a server

```sh
npx hono routes src/app.ts
npx hono request / src/app.ts
npm test
npm run build
```

The Hono CLI tests exercise authentication, malformed payloads, text/media copying,
topics, ignored updates and Telegram failures using a fake outbound transport and
test credentials. They send no real messages. The original `/` and `/marco` routes
are retained.

## Webhook behavior and API research

Researched with Firecrawl's developer index on November 23, 2026. Direct scraping
of Telegram's site was rejected by Firecrawl; the index returned official API
passages. Local results are saved under `.firecrawl/`.

- [setWebhook](https://core.telegram.org/bots/api#setwebhook): Telegram delivers
  JSON updates over HTTPS POST and sends the configured `secret_token` in
  `X-Telegram-Bot-Api-Secret-Token`. The handler checks this header before parsing.
- [copyMessage](https://core.telegram.org/bots/api#copymessage): copies a message
  back to its source chat without a forwarding link. Service messages, paid media,
  giveaways, invoices and widgets cannot be copied; this bot ignores unsupported
  content and quiz polls with unknown correct answers. Albums are echoed as
  individual messages.
- [Webhook guide](https://core.telegram.org/bots/webhooks): the deployed endpoint
  must be publicly reachable over HTTPS. The registration helper sets the secret
  and `allowed_updates: ["message"]` without discarding pending updates.

Valid updates that do not contain a new supported message receive HTTP 200.
Missing configuration returns 503, a missing/wrong secret returns 401, malformed
updates return 400, and Telegram API/network failures return 502 so delivery can
be retried. Calls time out after 10 seconds; errors do not expose the bot token.
This simple bot has no persistent deduplication: a redelivery after a successful
send can produce a duplicate echo.
