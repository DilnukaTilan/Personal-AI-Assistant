import { serve } from '@hono/node-server';
import app from './app.js';
serve({
    fetch: app.fetch,
    hostname: '0.0.0.0',
    port: Number(process.env.PORT ?? 3000)
}, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
});
