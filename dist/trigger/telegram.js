import { webhooks } from '@trigger.dev/sdk';
import { chat } from '@trigger.dev/sdk/ai';
import { openai } from '@ai-sdk/openai';
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
        setupPrompt: 'Store TELEGRAM_WEBHOOK_SECRET as this endpoint signing secret, then call Telegram setWebhook with this hosted URL, the same secret_token, allowed_updates ["message"], and max_connections 1. Keep pending updates. The bot token is only needed by the worker to send replies.',
    }),
});
export const telegramChannel = chat.channels.custom({
    id: 'telegram-chat',
    endpoint: telegramWebhook,
    // Missing topic ids fall back to the chat type, keeping the main chat distinct.
    // The endpoint prefix isolates this bot from any future Telegram endpoints.
    key: 'telegram:{webhook.id}:chat:{event.message.chat.id}:thread:{event.message.message_thread_id || event.message.chat.type}:direct:{event.message.direct_messages_topic.topic_id || event.message.chat.type}',
    filter: 'event.message != null && (event.message.text != null || event.message.caption != null)',
    inbound: (event) => {
        const message = telegramMessage(event);
        if (!message)
            return '';
        return {
            message: telegramText(message),
            externalMessageId: String(message.message_id),
            externalUserId: String(message.from?.id ?? message.chat.id),
        };
    },
    bind: (event) => {
        const message = telegramMessage(event);
        return message ? telegramTarget(message) : null;
    },
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
// The model is a server-side dependency; webhook payloads cannot choose it.
export function createTelegramAgent(model = openai('gpt-5.4-nano')) {
    return chat.agent({
        id: 'telegram-assistant',
        channels: [telegramChannel],
        maxDuration: 300,
        idleTimeoutInSeconds: 30,
        system: 'You are a helpful personal assistant on Telegram. Use the conversation history to remember earlier messages. Answer concisely in plain text, ideally under 3500 characters. You can read message text and media captions, but not attachments.',
        // Leave storage unset: Trigger.dev persists transcript snapshots and resume
        // cursors in its object store and restores them when the session boots again.
        run: async ({ messages, signal, streamText }) => streamText({
            model,
            messages,
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            maxOutputTokens: 512,
            maxRetries: 0,
            providerOptions: { openai: { reasoningEffort: 'none' } },
        }),
    });
}
export const telegramAgent = createTelegramAgent();
