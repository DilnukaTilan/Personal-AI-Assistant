import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('.env'))
    loadEnvFile('.env');
const copyableContent = [
    'text', 'animation', 'audio', 'contact', 'dice', 'document', 'game',
    'location', 'photo', 'poll', 'sticker', 'venue', 'video', 'video_note', 'voice',
];
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const app = new Hono();
app.get('/', (c) => {
    return c.text('Hello Hono!');
});
app.get('/marco', (c) => {
    return c.text('polo');
});
app.post('/telegram/webhook', async (c) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!token || !secret) {
        return c.json({ error: 'Telegram bot is not configured' }, 503);
    }
    const supplied = Buffer.from(c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '');
    const expected = Buffer.from(secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    let update;
    try {
        update = await c.req.json();
    }
    catch {
        return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!isObject(update) || !Number.isSafeInteger(update.update_id)) {
        return c.json({ error: 'Invalid Telegram update' }, 400);
    }
    // Only new messages are echoed; edits and other update types are acknowledged.
    if (update.message === undefined)
        return c.json({ ok: true });
    const message = update.message;
    if (!isObject(message) || !isObject(message.chat)
        || !Number.isSafeInteger(message.chat.id) || !Number.isSafeInteger(message.message_id)) {
        return c.json({ error: 'Invalid Telegram message' }, 400);
    }
    // Service messages and quiz polls without known answers cannot be copied.
    if (!copyableContent.some((key) => key in message)
        || (isObject(message.poll) && message.poll.type === 'quiz'
            && !('correct_option_ids' in message.poll) && !('correct_option_id' in message.poll))) {
        return c.json({ ok: true });
    }
    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: message.chat.id,
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                ...(Number.isSafeInteger(message.message_thread_id)
                    ? { message_thread_id: message.message_thread_id } : {}),
                ...(isObject(message.direct_messages_topic)
                    && Number.isSafeInteger(message.direct_messages_topic.topic_id)
                    ? { direct_messages_topic_id: message.direct_messages_topic.topic_id } : {}),
            }),
            signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json();
        if (!response.ok || !isObject(result) || result.ok !== true) {
            return c.json({ error: 'Telegram could not echo the message' }, 502);
        }
    }
    catch {
        // Fetch errors can contain the token-bearing URL. Never expose or log them.
        return c.json({ error: 'Telegram could not echo the message' }, 502);
    }
    return c.json({ ok: true });
});
export default app;
