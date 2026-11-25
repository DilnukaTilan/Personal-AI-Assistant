import { Lexer } from 'marked';
import { decodeHTML } from 'entities';
export const TELEGRAM_TEXT_LIMIT = 4096;
const tag = (name) => ({ open: `<${name}>`, close: `</${name}>` });
function escapeHTML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeLink(href) {
    // Never allow model-provided HTML or executable/relative link destinations.
    if (!/^(https?:\/\/|mailto:|tg:\/\/)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href))
        return;
    try {
        new URL(href);
    }
    catch {
        return;
    }
    return href;
}
function markdownRuns(markdown) {
    const runs = [];
    const add = (text, tags = []) => { if (text)
        runs.push({ text, tags }); };
    const gap = (tags) => {
        let trailing = 0;
        for (let i = runs.length - 1; i >= 0; i--) {
            const suffix = runs[i].text.match(/\n+$/)?.[0].length ?? 0;
            trailing += suffix;
            if (suffix < runs[i].text.length)
                break;
        }
        if (runs.length && trailing < 2)
            add('\n'.repeat(2 - trailing), tags);
    };
    const trimGaps = (start) => {
        while (runs.length > start && !runs.at(-1).text.trim()
            && !runs.at(-1).tags.some((t) => t.close === '</pre>' || t.close === '</code>'))
            runs.pop();
    };
    const styled = (tags, name) => tags.some((t) => t.open === `<${name}>`)
        ? tags : [...tags, tag(name)];
    function render(tokens, tags = [], depth = 0, listDepth = 0) {
        // Bound recursion for malformed or adversarial model output; the caller falls back to text.
        if (depth > 64)
            throw new Error('Markdown nesting limit exceeded');
        for (const token of tokens) {
            const children = (nextTags = tags) => render('tokens' in token ? token.tokens ?? [] : [], nextTags, depth + 1, listDepth);
            switch (token.type) {
                case 'space':
                    gap(tags);
                    break;
                case 'br':
                    add('\n', tags);
                    break;
                case 'hr':
                    add('\n───\n\n', tags);
                    break;
                case 'def': break;
                case 'checkbox':
                    add(token.checked ? '☑ ' : '☐ ', tags);
                    break;
                case 'heading':
                    children(styled(tags, 'b'));
                    gap(tags);
                    break;
                case 'paragraph':
                    children();
                    gap(tags);
                    break;
                case 'strong':
                    children(styled(tags, 'b'));
                    break;
                case 'em':
                    children(styled(tags, 'i'));
                    break;
                case 'del':
                    children(styled(tags, 's'));
                    break;
                case 'blockquote': {
                    const start = runs.length;
                    children(styled(tags, 'blockquote'));
                    trimGaps(start);
                    gap(tags);
                    break;
                }
                case 'code': {
                    const code = token;
                    const language = code.lang?.split(/\s/)[0];
                    const codeTags = [tag('pre')];
                    if (language && /^[\w+-]+$/.test(language)) {
                        codeTags.push({ open: `<code class="language-${language}">`, close: '</code>' });
                    }
                    add(code.text, codeTags);
                    gap(tags);
                    break;
                }
                case 'codespan':
                    // Telegram forbids code inside emphasis, links, or quotes.
                    add(token.text, [tag('code')]);
                    break;
                case 'link':
                case 'image': {
                    const link = token;
                    const href = safeLink('autolink' in link && link.autolink ? link.href : decodeHTML(link.href));
                    // Links and quotes cannot contain one another in Telegram entities.
                    const linkTags = href ? [...tags.filter((t) => t.close !== '</a>' && t.close !== '</blockquote>'),
                        { open: `<a href="${escapeHTML(href)}">`, close: '</a>' }] : tags;
                    if ('autolink' in link && link.autolink)
                        add(link.text, linkTags);
                    else
                        render(link.tokens, linkTags, depth + 1, listDepth);
                    break;
                }
                case 'list': {
                    const list = token;
                    if (runs.length && !runs.at(-1).text.endsWith('\n'))
                        add('\n', tags);
                    list.items.forEach((item, index) => {
                        add(`${'  '.repeat(listDepth)}${list.ordered ? `${Number(list.start) + index}.` : '•'} `, tags);
                        const start = runs.length;
                        render(item.tokens, tags, depth + 1, listDepth + 1);
                        // Paragraph tokens inside list items should not introduce blank rows.
                        trimGaps(start);
                        if (!runs.at(-1)?.text.endsWith('\n'))
                            add('\n', tags);
                    });
                    gap(tags);
                    break;
                }
                case 'table': {
                    const table = token;
                    const rows = table.rows.length ? table.rows : [table.header];
                    rows.forEach((row, index) => {
                        add(`${index + 1}. `, tags);
                        row.forEach((cell, column) => {
                            if (column)
                                add('\n   ', tags);
                            const header = table.header[column];
                            if (table.rows.length && header?.text) {
                                render(header.tokens, styled(tags, 'b'), depth + 1);
                                add(': ', tags);
                            }
                            render(cell.tokens, tags, depth + 1);
                        });
                        add('\n\n', tags);
                    });
                    break;
                }
                case 'text':
                    if (token.tokens)
                        children();
                    else
                        add(decodeHTML(token.text), tags);
                    break;
                case 'escape':
                    add(token.text, tags);
                    break;
                case 'html':
                    // Raw HTML is displayed literally, never trusted as Telegram markup.
                    add(token.text, tags);
                    break;
                default: add(token.raw, tags);
            }
        }
    }
    render(Lexer.lex(markdown, { gfm: true }));
    const isCode = (run) => run.tags.some((t) => t.close === '</pre>' || t.close === '</code>');
    while (runs.length && !runs[0].text.trim() && !isCode(runs[0]))
        runs.shift();
    trimGaps(0);
    if (runs.length) {
        if (!isCode(runs[0]))
            runs[0].text = runs[0].text.trimStart();
        if (!isCode(runs.at(-1)))
            runs.at(-1).text = runs.at(-1).text.trimEnd();
    }
    return runs;
}
function plainText(html) {
    // Operate on our generated markup before decoding, so literal user tags survive.
    const links = html.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_, href, label) => decodeHTML(label.replace(/<[^>]*>/g, '')) === decodeHTML(href) ? label : `${label} (${href})`);
    return decodeHTML(links.replace(/<[^>]*>/g, ''));
}
/** Convert Markdown into independently valid Telegram HTML chunks and readable fallbacks. */
export function formatTelegramReply(markdown) {
    const runs = markdownRuns(markdown);
    const chunks = [];
    let html = '';
    let length = 0;
    let active = [];
    const close = (tags) => [...tags].reverse().map((t) => t.close).join('');
    const flush = () => {
        if (!length)
            return;
        const complete = html + close(active);
        chunks.push({ html: complete, text: plainText(complete) });
        html = '';
        length = 0;
        active = [];
    };
    for (const run of runs) {
        for (const character of run.text) {
            // Count visible UTF-16 units, never encoded entities or markup; keep emoji intact.
            if (length + character.length > TELEGRAM_TEXT_LIMIT)
                flush();
            let shared = 0;
            while (shared < active.length && shared < run.tags.length
                && active[shared].open === run.tags[shared].open)
                shared++;
            html += close(active.slice(shared)) + run.tags.slice(shared).map((t) => t.open).join('');
            active = run.tags;
            html += escapeHTML(character);
            length += character.length;
        }
    }
    flush();
    return chunks;
}
