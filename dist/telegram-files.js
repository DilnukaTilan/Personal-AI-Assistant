export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const TELEGRAM_SEND_LIMIT = 50 * 1024 * 1024;
export function safeFilename(value) {
    return value.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(0, 120).trim() || 'file.bin';
}
// Only metadata from verified Telegram updates becomes an attachment reference.
export function telegramUploads(message) {
    const result = [];
    for (const kind of ['document', 'photo', 'audio', 'voice', 'video', 'animation', 'video_note', 'sticker']) {
        const value = kind === 'photo' ? (Array.isArray(message.photo) ? message.photo.at(-1) : undefined) : message[kind];
        if (!value || typeof value.file_id !== 'string' || !value.file_id || value.file_id.length > 1024)
            continue;
        if (value.file_size !== undefined && (!Number.isSafeInteger(value.file_size) || value.file_size < 0))
            continue;
        const extension = kind === 'photo' ? 'jpg' : kind === 'voice' ? 'ogg' : 'bin';
        result.push({ id: `${message.message_id}-${kind}`, fileId: value.file_id,
            filename: safeFilename(value.file_name || `${kind}.${extension}`),
            mediaType: value.mime_type || (kind === 'photo' ? 'image/jpeg' : 'application/octet-stream'),
            ...(value.file_size !== undefined ? { size: value.file_size } : {}) });
    }
    return result;
}
export function telegramInboundMessage(message, text) {
    const uploads = telegramUploads(message);
    return {
        id: `telegram-${message.chat.id}-${message.message_id}`,
        role: 'user',
        parts: [
            { type: 'text', text: [text, ...uploads.map((file) => `Uploaded file: ${JSON.stringify({ attachmentId: file.id, filename: file.filename, mediaType: file.mediaType, size: file.size })}`)].filter(Boolean).join('\n') },
            ...uploads.map((data) => ({ type: 'data-telegram-upload', data })),
        ],
    };
}
// Text supplied by a customer cannot mint references to other chats' Telegram files.
export function uploadsFromHistory(messages) {
    const uploads = new Map();
    for (const message of messages) {
        const metadata = message.metadata;
        if (message.role !== 'user' || metadata?.source !== 'channel' || metadata.connectorId !== 'telegram-chat')
            continue;
        for (const part of message.parts) {
            if (part.type !== 'data-telegram-upload' || !('data' in part))
                continue;
            const file = part.data;
            if (file && typeof file.id === 'string' && typeof file.fileId === 'string'
                && typeof file.filename === 'string' && typeof file.mediaType === 'string')
                uploads.set(file.id, file);
        }
    }
    return [...uploads.values()];
}
async function boundedBytes(response, limit) {
    if (!response.ok || !response.body)
        throw new Error('File download failed');
    if (Number(response.headers.get('content-length')) > limit) {
        await response.body.cancel();
        throw new Error('File is too large');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > limit)
                throw new Error('File is too large');
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}
export async function downloadTelegramFile(file, signal) {
    if (file.size !== undefined && file.size > TELEGRAM_DOWNLOAD_LIMIT)
        throw new Error('Telegram uploads must be at most 20 MB');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token)
        throw new Error('Telegram bot is not configured');
    const timeout = AbortSignal.timeout(30_000);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        const info = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: file.fileId }), signal: abortSignal, redirect: 'error',
        });
        const result = await info.json();
        const path = result.result?.file_path;
        if (!info.ok || !result.ok || !path || !/^[\w./-]+$/.test(path)
            || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.'))
            throw new Error('Invalid file path');
        if ((result.result?.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT)
            throw new Error('File is too large');
        return await boundedBytes(await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
            signal: abortSignal, redirect: 'error',
        }), TELEGRAM_DOWNLOAD_LIMIT);
    }
    catch {
        signal?.throwIfAborted();
        throw new Error('Telegram could not download the file; it may be unavailable or over the 20 MB limit');
    }
}
export async function sendTelegramDocument(target, data, filename, signal) {
    if (!data.byteLength || data.byteLength > TELEGRAM_SEND_LIMIT)
        throw new Error('Return files must be between 1 byte and 50 MB');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token)
        throw new Error('Telegram bot is not configured');
    const form = new FormData();
    for (const [key, value] of Object.entries(target))
        if (value !== undefined)
            form.set(key, String(value));
    form.set('document', new Blob([new Uint8Array(data)], { type: 'application/octet-stream' }), safeFilename(filename));
    try {
        const timeout = AbortSignal.timeout(60_000);
        const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
            method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            redirect: 'error',
        });
        const result = await response.json();
        if (!response.ok || !result.ok || !Number.isSafeInteger(result.result?.message_id))
            throw new Error('Delivery failed');
        return String(result.result.message_id);
    }
    catch {
        signal?.throwIfAborted();
        // Do not retry an ambiguous upload: it may already have reached Telegram.
        throw new Error('Telegram could not confirm file delivery. Do not automatically resend it');
    }
}
