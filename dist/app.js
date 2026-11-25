import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('.env'))
    loadEnvFile('.env');
const app = new Hono();
// Telegram now posts directly to the hosted Trigger.dev endpoint.
export default app;
