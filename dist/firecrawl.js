import { tool } from 'ai';
import Firecrawl from 'firecrawl';
import { z } from 'zod';
function getFirecrawl() {
    if (!process.env.FIRECRAWL_API_KEY?.trim())
        return undefined;
    // In this SDK maxRetries counts attempts, so 1 means no automatic retries.
    return new Firecrawl({ timeoutMs: 30_000, maxRetries: 1 });
}
const text = z.string().trim().min(1).max(2000);
const identifier = z.string().trim().min(1).max(200);
const MAX_RESULT_CHARACTERS = 30_000;
function bounded(data) {
    if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
        return data;
    }
    const serialized = JSON.stringify(data);
    return serialized.length <= MAX_RESULT_CHARACTERS
        ? { ok: true, data, truncated: false }
        : { ok: true, excerpt: serialized.slice(0, MAX_RESULT_CHARACTERS), truncated: true,
            note: 'Partial result. Narrow the query or request a smaller page; do not claim complete coverage.' };
}
// The SDK has no per-call AbortSignal. Stop waiting immediately on cancellation;
// its transport timeout still bounds the already-started remote request.
async function lookup(operation, signal) {
    signal?.throwIfAborted();
    let stop;
    try {
        const data = await Promise.race([
            operation(),
            new Promise((_, reject) => {
                stop = () => reject(new Error('Web lookup cancelled'));
                signal?.addEventListener('abort', stop, { once: true });
                if (signal?.aborted)
                    stop();
            }),
        ]);
        signal?.throwIfAborted();
        return bounded(data);
    }
    catch {
        signal?.throwIfAborted();
        // SDK errors can include request headers and provider response bodies.
        return { ok: false, code: 'LOOKUP_UNAVAILABLE',
            message: 'The live source could not be reached. Try another source or explain that verification is unavailable.' };
    }
    finally {
        if (stop)
            signal?.removeEventListener('abort', stop);
    }
}
const notConfigured = () => ({ ok: false, code: 'NOT_CONFIGURED',
    message: 'Live web lookup is not configured. Tell the user live information cannot be checked right now.' });
// Instantiate per turn, so discovered contracts never leak between customers.
export function createFirecrawlTools(getClient = getFirecrawl) {
    const contracts = new Map();
    function remember(items = []) {
        for (const item of items) {
            if (Array.isArray(item.options))
                contracts.set(`${item.provider}/${item.capability}`, item);
        }
    }
    return {
        webSearch: tool({
            description: 'Find current web sources and matching structured data tools for ordinary requests about prices, availability, jobs, places, companies, reviews, news, sports, travel, shopping, research, or technical information. Tool matches are contracts, not actual results. Use dataTools mode for structured datasets.',
            inputSchema: z.object({
                query: text.describe('The information needed, preserving dates, location, market, budget, and other constraints.'),
                mode: z.enum(['web', 'news', 'dataTools']).describe('web includes web results and data tool discovery; news includes news and data tools; dataTools discovers only structured data tools.'),
                limit: z.number().int().min(1).max(5),
            }),
            execute: async ({ query, mode, limit }, { abortSignal }) => lookup(async () => {
                const client = getClient();
                if (!client)
                    return notConfigured();
                const result = await client.search(query, {
                    sources: mode === 'dataTools' ? ['alexandria'] : [mode, 'alexandria'],
                    toolDetail: 'full', domainTools: true, limit, timeout: 20_000,
                });
                remember(result.tools);
                return result;
            }, abortSignal),
        }),
        readWebPage: tool({
            description: 'Read the content of a known public HTTP(S) URL. Use for a supplied link, source verification, or details beyond search snippets. Returns markdown and source metadata; no browser actions or attachments.',
            inputSchema: z.object({
                url: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an HTTP(S) URL'),
                fresh: z.boolean().describe('Use true for live prices, inventory, availability, or other facts that need a fresh fetch.'),
            }),
            execute: async ({ url, fresh }, { abortSignal }) => lookup(async () => {
                const client = getClient();
                if (!client)
                    return notConfigured();
                const document = await client.scrape(url, {
                    formats: ['markdown'], onlyMainContent: true, timeout: 25_000,
                    autoResume: false, parsers: [{ type: 'pdf', maxPages: 5 }],
                    ...(fresh ? { maxAge: 0 } : {}),
                });
                return { url, metadata: document.metadata, markdown: document.markdown,
                    warning: document.warning };
            }, abortSignal),
        }),
        inspectDataTool: tool({
            description: 'Inspect the full input and output contract of a structured data tool discovered by webSearch. Use the exact returned provider/capability identifiers. Reuse full contracts already returned by search.',
            inputSchema: z.object({ provider: identifier, capability: identifier }),
            execute: async ({ provider, capability }, { abortSignal }) => lookup(async () => {
                const client = getClient();
                if (!client)
                    return notConfigured();
                const result = await client.findTools({ providers: [provider], capabilities: [capability],
                    expand: ['options', 'response', 'examples'], limit: 1 });
                // Discovery items carry arbitrary contract fields in this SDK.
                remember(result.items.filter((item) => typeof item.provider === 'string'
                    && typeof item.capability === 'string'));
                return result;
            }, abortSignal),
        }),
        queryDataTool: tool({
            description: 'Retrieve records using a full data tool contract discovered or inspected in THIS turn. Supply only documented options as a JSON object encoded in optionsJson ({} for no inputs). Follow required/requiresOneOf rules and declared pagination. For read-only data retrieval only; never execute code, accept terms, book, buy, submit, or create monitors.',
            inputSchema: z.object({ provider: identifier, capability: identifier,
                optionsJson: z.string().max(12_000).describe('JSON object with the exact documented input names and types. Never invent record IDs or fields.') }),
            execute: async ({ provider, capability, optionsJson }, { abortSignal }) => lookup(async () => {
                const contract = contracts.get(`${provider}/${capability}`);
                if (!contract)
                    return { ok: false, code: 'INSPECT_FIRST', message: 'Discover or inspect the full contract in this turn before execution.' };
                // Do not expose the catalogue's arbitrary-code or state-changing helpers.
                if (/(^|[/_-])(bash|shell|exec|execute|interact|browser|accept|purchase|book|submit|monitor|create|delete|update)([/_-]|$)/i.test(capability)) {
                    return { ok: false, code: 'READ_ONLY', message: 'Only read-only data retrieval is available.' };
                }
                let options;
                try {
                    const parsed = JSON.parse(optionsJson);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                        throw new Error('Invalid options');
                    options = parsed;
                }
                catch {
                    return { ok: false, code: 'INVALID_OPTIONS', message: 'optionsJson must encode a JSON object.' };
                }
                const has = (name) => options[name] !== undefined && options[name] !== null && options[name] !== '';
                if (contract.options?.some((option) => option.required && !has(option.name))
                    || contract.requiresOneOf?.some((group) => !group.some(has))) {
                    return { ok: false, code: 'MISSING_INPUT', message: 'Supply the contract-required inputs or ask the user for missing information.' };
                }
                const client = getClient();
                if (!client)
                    return notConfigured();
                const result = await client.scrape({ alexandria: { provider, capability, options }, timeout: 40_000 });
                return { scrapeId: result.scrapeId, requestId: result.requestId, creditsCost: result.creditsCost,
                    results: result.alexandria.map((item) => item.error
                        ? { provider: item.provider, capability: item.capability, ok: false,
                            code: item.error.code, message: 'This data source is unavailable. Do not treat this as an empty successful result.' }
                        : { provider: item.provider, capability: item.capability, ok: true,
                            data: item.data, records: item.records, recordedAt: item.recordedAt }) };
            }, abortSignal),
        }),
    };
}
