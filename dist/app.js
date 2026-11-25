import { Hono } from 'hono';
import { runs, tasks } from '@trigger.dev/sdk';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('.env'))
    loadEnvFile('.env');
const app = new Hono();
app.get('/', (c) => {
    return c.text('Hello Hono!');
});
app.get('/marco', (c) => {
    return c.text('polo');
});
// Temporary public AI smoke test. Remove this route after testing.
app.get('/test/ai', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!process.env.TRIGGER_SECRET_KEY) {
        return c.json({ error: 'Trigger.dev is not configured' }, 503);
    }
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(45_000)]);
    try {
        const handle = await tasks.trigger('test-ai', {}, { ttl: '1m' });
        c.header('X-Trigger-Run-Id', handle.id);
        for await (const run of runs.subscribeToRun(handle.id, { signal })) {
            if (run.status === 'COMPLETED') {
                const text = run.output?.text?.trim();
                if (text)
                    return c.text(text);
                break;
            }
        }
    }
    catch {
        // Keep provider and Trigger.dev credentials out of public error responses.
    }
    if (signal.aborted)
        return c.json({ error: 'AI test timed out' }, 504);
    return c.json({ error: 'Trigger.dev AI task could not generate a response' }, 502);
});
// Telegram now posts directly to the hosted Trigger.dev endpoint.
export default app;
