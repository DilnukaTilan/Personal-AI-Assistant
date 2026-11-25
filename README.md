# Telegram AI assistant

Telegram posts directly to a **Trigger.dev hosted inbound webhook**. A custom
Telegram chat channel routes each message to the `telegram-assistant` chat agent
and posts the final reply using Telegram's Bot API. Hono no longer handles
`POST /telegram/webhook`.

The flow is:

```text
Telegram -> Trigger.dev endpoint `telegram` -> conversation session
         -> chat.agent -> AI SDK/OpenAI -> Telegram sendMessage
```

`src/trigger/telegram.ts` declares the endpoint, channel, and agent.
`src/telegram.ts` validates messages and sends formatted replies using
`src/telegram-format.ts`, the reusable Markdown-to-Telegram HTML formatter.
The agent uses the existing `gpt-5.4-nano` model, with reasoning disabled,
1200 output tokens per step, no model retries, and a 180-second turn timeout.
Research has at most eight model steps, with the last reserved for an answer.
It uses the managed `streamText` supplied by Trigger.dev.

## Live web and structured data

The official `firecrawl` Node SDK powers four AI SDK tools, declared on the
Trigger agent and passed to its managed `streamText`:

- `webSearch`: web/news results plus Alexandria data tool discovery, or data tools only.
- `readWebPage`: markdown from a supplied/source URL, with fresh fetching when needed.
- `inspectDataTool`: the selected provider's input/output contract and examples.
- `queryDataTool`: structured retrieval through Firecrawl's Alexandria scrape API.

`src/telegram-instructions.ts` routes ordinary customer requests to these tools.
Customers can ask for prices, travel, available tables/classes/campsites, jobs,
rentals, local businesses, reviews, company research, public ads, creator metrics,
streaming availability, product comparisons, official records, or other current
information. They never need to name Firecrawl or Alexandria. The instructions
cover missing constraints, source URLs, freshness, pagination, partial results,
fallbacks, and untrusted web content. The current UTC time is supplied each turn;
the bot asks for the customer's timezone/location when needed.

Data execution requires a full contract discovered/inspected in that turn. Tool
state is isolated per turn; transcript memory remains managed by Trigger.dev.
The tools retrieve information and links; they do not book, buy, submit applications,
accept provider terms, execute code, or create recurring monitors. Provider coverage
and availability vary. A Firecrawl account may need credits, Alexandria access,
or provider terms reviewed by an account admin before some datasets can run.
See the [prompt gallery](https://alexandria.firecrawl.dev/prompts) for example requests.

Set **`FIRECRAWL_API_KEY`** in your local `.env` and in the Trigger.dev environments
where this agent runs (including Production before deploying). Existing CLI login
credentials do not automatically configure the worker. No separate Alexandria key
is used. `FIRECRAWL_API_URL` is optional for a self-hosted API; leave it unset for
hosted Firecrawl. Without the key, ordinary conversation still works and live
lookups report that they are unavailable without exposing configuration details.

Searches, page reads, and provider queries are bounded by SDK timeouts and result
size limits. Stop/cancel ends the agent's wait; the SDK does not expose per-call
abort signals, so an already-started remote request can finish and consume credits.
The offline tests use a local HTTP server with the real SDK and a mocked chat
model; they do not spend Firecrawl/OpenAI credits or send real Telegram messages.

## Conversation memory without a database

The agent deliberately uses Trigger.dev's **default transcript storage**. The
runtime writes UI messages, internal context state, and resume cursors to its
object store, and restores them when a fresh worker continues the same session.
There is no application database or local transcript file to provision.

A session key includes the endpoint, Telegram chat, forum/private thread, and
direct-message topic. Different chats and topics have separate histories; group
participants in the same topic share that topic's conversation. Reuse the same
endpoint id, channel id, agent id, and routing key across deployments to keep
addressing those histories. Old conversations from the former stateless Hono
webhook cannot be recovered retroactively.

History is available in Trigger.dev's Sessions view. Storage retention and the
model's context window still apply. Self-hosted Trigger.dev requires an object
store for default transcript persistence; the hosted platform supplies it.

## Setup and Telegram registration

1. Run `npm ci`. Add the variables from `.env.example` to your existing local
   `.env` file. The shared `TELEGRAM_WEBHOOK_SECRET` must be 1-256 letters,
   digits, underscores, or hyphens. You can reuse the existing webhook secret.
   Keep `.env` out of Git.
2. In the Trigger.dev project `proj_cyhyvbhxmfhaqgtcuhui`, set
   `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, and `FIRECRAWL_API_KEY` in **Production environment
   variables**. These are worker credentials. The webhook's verification secret
   is configured separately in step 4.
3. Enable hosted deployments for the organization, then deploy:

   ```sh
   npx trigger.dev@4.8.10 deploy --env prod
   ```

   Verify that the deployment registers the `telegram-assistant` agent and the
   `telegram` endpoint. The last live deployment attempt in this project was
   blocked by a Free plan card-verification requirement; resolve any outstanding
   account setup shown in the Trigger.dev dashboard before deploying.
4. Open **Webhooks > telegram** in the project's **Production** environment and
   copy its exact hosted HTTPS URL. Store the same local secret as the endpoint's
   signing secret (the CLI reads it without printing it):

   ```sh
   npx trigger.dev@4.8.10 webhooks set-secret telegram --env prod --from-env TELEGRAM_WEBHOOK_SECRET --from-file .env
   ```

   An endpoint rejects deliveries until its secret is set. When rotating an
   existing secret, use `--previous-secret-ttl 24h` for an overlap or `0` to stop
   accepting the old secret immediately. The shared-secret verifier checks
   `X-Telegram-Bot-Api-Secret-Token`; it does not use an HMAC.
5. Register the copied URL with Telegram:

   ```sh
   npm run webhook:set -- "https://<exact-hosted-trigger-endpoint-url>"
   ```

   This calls Telegram's `setWebhook` with `secret_token` from `.env`,
   `allowed_updates: ["message"]`, `max_connections: 1`, and
   `drop_pending_updates: false`. It then calls `getWebhookInfo` to verify the
   registered URL. This replaces the old Railway URL; no `deleteWebhook` call
   is needed. Complete this step before deploying the removal of the old Hono
   handler to Railway to avoid an interruption.
6. Check the current registration and send two messages to the bot:

   ```sh
   npm run webhook:info
   ```

   Verify the URL, pending update count, and any recent delivery error. Send
   “My name is Tilan”, then “What is my name?” in the same chat/topic. Confirm
   the delivery, agent run, reply, and saved transcript in Trigger.dev. Repeat
   after the worker has ended or been restarted to check restored memory.

Use the **Trigger.dev hosted URL**, not the removed Railway
`/telegram/webhook` path. The registration helper does not provision or verify
Trigger.dev itself; deploy the agent and set the endpoint secret first.
Live registration and credential transfers are separate from the local code
change and are not performed by `npm test` or `npm run build`.

## Delivery behavior

Trigger.dev verifies, stores, and acknowledges each update before the agent
answers. The source uses `update_id` for ingress deduplication, and the channel
keeps turns sequential within a session. `max_connections: 1` also reduces
concurrent deliveries during registration.

New message text and media captions become prompts. Edits, callbacks,
non-text updates, whitespace-only messages, bot-authored messages, and malformed
messages do not call the model. Attachments themselves are not processed.
Replies preserve forum/private threads and direct-message topics, and long
answers are split into messages of at most 4096 visible UTF-16 code units without
breaking surrogate pairs, HTML entities, or tags. Replies use `parse_mode: "HTML"`.
Headings become bold text; emphasis, lists, hyperlinks, quotes, and code are preserved.
Markdown tables become numbered records with a labeled line for each column.
Raw HTML and special characters are escaped, and unsafe link destinations are omitted.
Telegram formatting rejections retry only the rejected chunk as readable plain text
(including link destinations). Parser failures deliver the original text instead.
Network, rate-limit, and other delivery failures retain the existing generic error behavior.

Turn errors produce a generic Telegram error message. Network failures do not
expose the bot-token URL. A successful webhook acknowledgement means delivery
was stored, not that a Telegram reply was sent: monitor failed runs and channel
egress in Trigger.dev. Sending a reply and persisting its result are not one
atomic operation; a crash or manual replay can still duplicate a reply. No
custom exactly-once delivery database is introduced.

## Local development

Use a development `TRIGGER_SECRET_KEY` in `.env`, with worker credentials
available to the local Trigger.dev worker:

```sh
npm run dev:trigger
```

Development and Production have different hosted webhook URLs and secrets.
Use a separate test bot for Development so its registration does not replace
the production bot's webhook. Default transcript persistence is managed by
Trigger.dev; restarting only the Node worker does not require a database.

## Hono and the temporary AI test

The Railway Hono app retains `GET /`, `GET /marco`, and the temporary public
`GET /test/ai` endpoint. The latter still triggers the separate `test-ai` task
and returns plain text with `X-Trigger-Run-Id`. It requires a matching
`TRIGGER_SECRET_KEY` in Railway and an OpenAI key in the Trigger.dev worker.
The Telegram pipeline does not pass through Railway.

```sh
npx hono routes src/app.ts -e ai -e @ai-sdk/openai -e @trigger.dev/sdk
npx hono request / src/app.ts -e ai -e @ai-sdk/openai -e @trigger.dev/sdk
npm test
npm run typecheck
npm run build
```

The tests use Hono CLI for HTTP behavior and Trigger.dev's offline
`mockChatAgent` harness for real channel turns and transcript restoration on a
fresh worker. Fake model and Telegram transports prevent model charges and real
messages. Registration tests verify the cutover payload, URL read-back, and
credential-safe errors. `@ai-sdk/otel` supplies the AI SDK v7 tracing integration.

## Daytona sandbox smoke test

The project includes `@daytona/sdk` version 2. Its client operations use the
`daytona.v0` namespace, as described in the
[TypeScript SDK reference](https://www.daytona.io/docs/en/typescript-sdk/).

Create an API key at [Daytona API keys](https://app.daytona.io/dashboard/keys)
and set it in your shell or in the existing, Git-ignored `.env` file:

```dotenv
DAYTONA_API_KEY=your-daytona-api-key
```

Run from the project root:

```sh
npm run daytona:smoke
```

The script creates a TypeScript sandbox, runs `console.log("Hello World")`,
captures and checks its output and exit code, then deletes the sandbox in a
`finally` block and waits for deletion. It prints `Daytona smoke test passed.`
only after execution and deletion both succeed. The sandbox also auto-stops
after five minutes of inactivity and deletes on stop if the process is interrupted.
Without an API key, the script exits before creating a sandbox.

## Documentation

- [Trigger.dev inbound webhooks](https://trigger.dev/docs/webhooks/overview)
- [Custom webhook verification](https://trigger.dev/docs/webhooks/custom-providers)
- [Custom chat channels](https://trigger.dev/docs/webhooks/channels)
- [Transcript storage](https://trigger.dev/docs/ai-chat/transcript-storage)
- [Signing secrets and CLI commands](https://trigger.dev/docs/webhooks/signing-secrets)
- [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook)
- [Telegram getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo)
