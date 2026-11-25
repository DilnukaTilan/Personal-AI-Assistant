import { webhooks } from '@trigger.dev/sdk';
import { chat } from '@trigger.dev/sdk/ai';
import { openai } from '@ai-sdk/openai';
import { isStepCount } from 'ai';
import { createFirecrawlTools } from '../firecrawl.js';
import { createDaytonaTools } from '../daytona.js';
import { sendTelegramDocument, telegramInboundMessage, uploadsFromHistory } from '../telegram-files.js';
import { telegramInstructions } from '../telegram-instructions.js';
import { telegramMessage, telegramText, telegramTarget, sendTelegramReply } from '../telegram.js';
export const telegramWebhook = webhooks.endpoint.define({
    id: 'telegram',
    description: 'Telegram Bot API updates for the personal assistant',
    source: webhooks.custom({
        scheme: 'shared-secret',
        placement: 'header',
        fieldName: 'X-Telegram-Bot-Api-Secret-Token',
        idempotencyField: { from: 'body', name: 'update_id' },
    }, {
        setupPrompt: 'Store TELEGRAM_WEBHOOK_SECRET as this endpoint signing secret, then call Telegram setWebhook with this hosted URL, the same secret_token, allowed_updates ["message"], and max_connections 1. Keep pending updates. TELEGRAM_BOT_TOKEN is needed by the worker to download uploads and send text/files; DAYTONA_API_KEY enables sandbox tools.',
    }),
});
export const telegramChannel = chat.channels.custom({
    id: 'telegram-chat',
    endpoint: telegramWebhook,
    // Missing topic ids fall back to the chat type, keeping the main chat distinct.
    // The endpoint prefix isolates this bot from any future Telegram endpoints.
    key: 'telegram:{webhook.id}:chat:{event.message.chat.id}:thread:{event.message.message_thread_id || event.message.chat.type}:direct:{event.message.direct_messages_topic.topic_id || event.message.chat.type}',
    filter: 'event.message != null && (event.message.text != null || event.message.caption != null || event.message.document != null || event.message.photo != null || event.message.audio != null || event.message.voice != null || event.message.video != null || event.message.animation != null || event.message.video_note != null || event.message.sticker != null)',
    inbound: (event) => {
        const message = telegramMessage(event);
        if (!message)
            return '';
        return {
            message: telegramInboundMessage(message, telegramText(message)),
            externalMessageId: String(message.message_id),
            externalUserId: String(message.from?.id ?? message.chat.id),
        };
    },
    bind: (event) => {
        const message = telegramMessage(event);
        return message ? telegramTarget(message) : null;
    },
    surface: (ctx) => ({
        uploads: () => uploadsFromHistory(chat.history.all()),
        sendFile: async (data, filename, signal) => {
            const incoming = telegramMessage(ctx.event);
            const target = ctx.handle ?? (incoming ? telegramTarget(incoming) : undefined);
            if (!target)
                throw new Error('Telegram conversation target is missing');
            return sendTelegramDocument(target, data, filename, signal);
        },
    }),
    delivery: 'final',
    outbound: (reply) => reply.text.trim() ? { text: reply.text } : null,
    errorMessage: 'I could not generate a response. Please try again.',
    send: async (message, ctx) => {
        const incoming = telegramMessage(ctx.event);
        const target = ctx.handle ?? (incoming ? telegramTarget(incoming) : undefined);
        if (!target)
            throw new Error('Telegram conversation target is missing');
        return { ref: await sendTelegramReply(target, message.text) };
    },
});
const sandboxTurn = chat.local({ id: 'telegram-sandbox-turn' });
function createComputerTools() {
    const surface = () => chat.surface();
    return createDaytonaTools({
        getUploads: () => surface()?.uploads() ?? [],
        sendFile: async (data, filename, signal) => {
            const channel = surface();
            if (!channel)
                throw new Error('Telegram file delivery is unavailable');
            return channel.sendFile(data, filename, signal);
        },
    });
}
// The model is a server-side dependency; webhook payloads cannot choose it.
export function createTelegramAgent(model = openai('gpt-5.4-nano'), createTools = createFirecrawlTools, createSandboxTools = createComputerTools) {
    return chat.agent({
        id: 'telegram-assistant',
        channels: [telegramChannel],
        maxDuration: 300,
        idleTimeoutInSeconds: 30,
        system: telegramInstructions,
        onBoot: () => { sandboxTurn.init({ ready: true }); },
        tools: () => {
            // Trigger also resolves schemas to restore history BEFORE onBoot. Reads of
            // an uninitialized local return undefined; only retain a live bundle after boot.
            const bundle = sandboxTurn.current ?? createSandboxTools();
            if (sandboxTurn.ready)
                sandboxTurn.current = bundle;
            return { ...createTools(), ...bundle.tools };
        },
        // Trigger calls this on successful, stopped, and failed turns. Return the
        // managed stream from run so the SDK still captures history and channel text.
        onTurnComplete: async () => {
            const current = sandboxTurn.current;
            sandboxTurn.current = undefined;
            await current?.dispose();
        },
        // Leave storage unset: Trigger.dev persists transcript snapshots and resume
        // cursors in its object store and restores them when the session boots again.
        run: async ({ messages, tools, signal, streamText }) => streamText({
            model,
            messages: [{ role: 'system', content: `Current date and time (UTC): ${new Date().toISOString()}` }, ...messages],
            tools,
            stopWhen: isStepCount(16),
            // File imports, desktop actions and delivery need several tool steps.
            prepareStep: ({ stepNumber }) => stepNumber >= 15 ? { toolChoice: 'none' } : {},
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(210_000)]),
            maxOutputTokens: 3000,
            maxRetries: 0,
            providerOptions: { openai: { reasoningEffort: 'none' } },
        }),
    });
}
export const telegramAgent = createTelegramAgent();
