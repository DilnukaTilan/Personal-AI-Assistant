# Telegram AI assistant

Deployed on Railway: https://personal-assistant-production-344f73aa.up.railway.app

Webhook URL: `https://personal-assistant-production-344f73aa.up.railway.app/telegram/webhook`.
The server binds to `0.0.0.0` and uses Railway's `PORT` environment variable
(3000 locally). Node.js 24 is selected through `package.json`.

A Hono Node.js webhook at `POST /telegram/webhook`. It generates a response to
each new text message or media caption using AI SDK's `generateText` and the
direct OpenAI provider, then sends the answer to the same chat using Telegram's
`sendMessage` API. Forum topics and direct message topics are preserved.
Attachments themselves are not processed, and messages without text or a caption
are acknowledged without calling the model. Each response uses only the current
message; no conversation history is stored.

## Setup

Install dependencies with `npm ci`. Set `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` and `OPENAI_API_KEY` in the deployment environment or a
local `.env` file (see `.env.example`). The webhook secret must contain 1–256
letters, digits, underscores or hyphens. Credentials and Firecrawl research
output are ignored by Git.

The model is `gpt-5.4-nano`, with reasoning disabled and output capped at 512
tokens to keep cost and latency low. OpenAI lists standard pricing of $0.20 per
million input tokens and $1.25 per million output tokens, checked November 25,
2026. See the [model reference](https://developers.openai.com/api/docs/models/gpt-5.4-nano)
for current pricing. Replies are plain text and capped at Telegram's 4096
character limit.

Build with `npm run build`, then run with `npm start`. Expose the server through
a public HTTPS endpoint, then register the complete webhook URL:

```sh
npm run webhook:set -- https://your-domain.example/telegram/webhook
```

Registration sends the secret to Telegram and subscribes to new `message` updates.
Send a text message to the bot in Telegram to receive an AI response. In groups,
Telegram's bot privacy settings determine which messages the bot receives.

## Temporary public AI test

`GET /test/ai` needs no authentication and returns a generated greeting as
`text/plain`. The Hono handler triggers the `test-ai` Trigger.dev task, waits
for completion, and returns its output. The AI SDK call runs in Trigger.dev,
using the same OpenAI model as the webhook. Responses include the run ID in
`X-Trigger-Run-Id` and use `Cache-Control: no-store`.

Set a production `TRIGGER_SECRET_KEY` in Railway and `OPENAI_API_KEY` in the
Trigger.dev project's Production environment, then deploy the tasks with
`npx trigger.dev@4.8.10 deploy --env prod`. For local testing, use a development
key in `.env` and run `npm run dev:trigger` with the OpenAI key configured.
The fixed prompt, 512-token cap, 15-second generation timeout, and disabled
task/AI retries keep the test bounded. The handler waits up to 45 seconds for
run updates; a timed-out request does not cancel the background run.

```sh
npx hono request /test/ai src/app.ts -e ai -e @ai-sdk/openai -e @trigger.dev/sdk
```

Once deployed, open `/test/ai` on the server's public HTTPS domain. Each request
starts a Trigger.dev run that calls OpenAI. Missing Trigger.dev configuration
returns 503; task failures or empty output return 502; waiting too long returns
504. Remove the marked route in `src/app.ts` and `src/trigger/test-ai.ts` after
testing.

## Background tasks with Trigger.dev

Trigger.dev project: `proj_cyhyvbhxmfhaqgtcuhui`.
The exported `hello-world` task lives in `src/trigger/hello-world.ts` and accepts
`{"name":"Tilan"}` (or `{}` for the default greeting).

Add your development `TRIGGER_SECRET_KEY` to `.env`. If the CLI is not already
authenticated, run `npx trigger.dev@latest login`, then start the local worker:

```sh
npm run dev:trigger
```

Keep the worker running, open the project's Development environment in the
Trigger.dev dashboard, and use the task's Test page to run `hello-world`.
The run logs the greeting and returns it with a timestamp. This sample task
does not require the Telegram or OpenAI credentials.

`npm run typecheck` checks both the application and `trigger.config.ts`.
`npm run build` uses `tsconfig.build.json` to preserve the `dist/index.js`
entry point used by `npm start`.

## Verification without a server

```sh
npx hono routes src/app.ts -e ai -e @ai-sdk/openai -e @trigger.dev/sdk
npx hono request / src/app.ts -e ai -e @ai-sdk/openai -e @trigger.dev/sdk
npm test
npm run build
```

The Hono CLI tests exercise authentication, malformed payloads, text and caption
generation, topics, ignored updates, output limits, missing configuration, and
OpenAI/Telegram failures. They run the actual AI SDK with fake outbound OpenAI
and Telegram transports and test credentials, without incurring model charges
or sending real messages. The original `/` and `/marco` routes are retained.
The SDK packages are marked external so the CLI loads their Node.js modules
directly instead of bundling their CommonJS dependencies into ESM.

## Webhook behavior

The handler checks `X-Telegram-Bot-Api-Secret-Token` before parsing the update.
See Telegram's [setWebhook](https://core.telegram.org/bots/api#setwebhook) and
[sendMessage](https://core.telegram.org/bots/api#sendmessage) references.

Valid updates without a new text message or caption receive HTTP 200. Missing
Telegram configuration returns 503, a missing/wrong secret returns 401,
malformed updates return 400, and a missing OpenAI key returns 503 for messages
requiring generation. AI failures or empty output and Telegram API/network
failures return 502 so delivery can be retried. Generation times out after 15
seconds with SDK retries disabled; Telegram calls time out after 10 seconds.
Errors do not expose credentials. This simple bot has no persistent
deduplication: a redelivery can regenerate a response and produce a duplicate
reply or additional model charges.
