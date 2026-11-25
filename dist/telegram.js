function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function telegramMessage(update) {
    if (!isObject(update) || !Number.isSafeInteger(update.update_id))
        return;
    const message = update.message;
    if (!isObject(message) || !Number.isSafeInteger(message.message_id)
        || !isObject(message.chat) || !Number.isSafeInteger(message.chat.id)
        || typeof message.chat.type !== 'string')
        return;
    if (isObject(message.from) && message.from.is_bot === true)
        return;
    if (message.message_thread_id !== undefined && !Number.isSafeInteger(message.message_thread_id))
        return;
    if (message.direct_messages_topic !== undefined
        && (!isObject(message.direct_messages_topic)
            || !Number.isSafeInteger(message.direct_messages_topic.topic_id)))
        return;
    return message;
}
export function telegramText(message) {
    return (typeof message.text === 'string' ? message.text
        : typeof message.caption === 'string' ? message.caption : '').trim();
}
export function telegramTarget(message) {
    return {
        chat_id: message.chat.id,
        ...(message.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {}),
        ...(message.direct_messages_topic ? { direct_messages_topic_id: message.direct_messages_topic.topic_id } : {}),
    };
}
// Bound each plain-text message without cutting a Unicode surrogate pair.
export function splitTelegramText(text) {
    const chunks = [];
    let chunk = '';
    for (const character of text.trim()) {
        if (chunk.length + character.length > 4096) {
            chunks.push(chunk);
            chunk = '';
        }
        chunk += character;
    }
    if (chunk)
        chunks.push(chunk);
    return chunks;
}
export async function sendTelegramReply(target, text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token)
        throw new Error('Telegram bot is not configured');
    let ref;
    for (const chunk of splitTelegramText(text)) {
        try {
            const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...target, text: chunk }),
                signal: AbortSignal.timeout(10_000),
            });
            const result = await response.json();
            if (!response.ok || !isObject(result) || result.ok !== true
                || !isObject(result.result) || !Number.isSafeInteger(result.result.message_id)) {
                throw new Error('Telegram rejected the reply');
            }
            ref = String(result.result.message_id);
        }
        catch {
            // Fetch errors can contain the token-bearing URL; never propagate them.
            throw new Error('Telegram could not send the response');
        }
    }
    return ref;
}
