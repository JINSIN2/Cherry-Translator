// Cherry Translator - core text pipeline (pure functions, no SillyTavern dependencies)
// Splits a message into protected blocks and translatable lines, builds numbered
// requests, validates numbered responses, and reassembles the translated message.

export const TOKEN_OPEN = '⟦'; // ⟦
export const TOKEN_CLOSE = '⟧'; // ⟧

// Inline HTML/markdown formatting tags: their content is translated, the tags are kept as placeholders.
const INLINE_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins',
    'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
    'time', 'tt', 'u', 'var', 'wbr', 'p', 'blockquote', 'center', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
]);

// Block-level HTML containers: usually status panels / UI, protected as a whole when "protectHtmlBlocks" is on.
const BLOCK_TAGS = new Set([
    'div', 'details', 'summary', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'section', 'article', 'aside',
    'nav', 'header', 'footer', 'main', 'figure', 'figcaption', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'form',
    'fieldset', 'legend', 'button', 'input', 'select', 'option', 'textarea', 'label', 'progress', 'meter',
]);

// Always protected regardless of settings (never meant to be read as prose).
const ALWAYS_PROTECTED_TAGS = new Set([
    'style', 'script', 'svg', 'html', 'head', 'body', 'iframe', 'canvas', 'video', 'audio', 'object', 'embed',
    'math', 'template', 'noscript', 'custom-style',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'wbr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track']);

const INLINE_MASK_RE = /<\/?[A-Za-z][^<>]*>|\{\{[\s\S]*?\}\}|`[^`\n]+`|!\[[^\]\n]*\]\([^)\n]*\)|\]\([^)\n]*\)|https?:\/\/[^\s<>()]+|<!--[\s\S]*?-->/g;

const BLOCK_PREFIX_RE = /^(\s*(?:(?:>[ \t]?)+|#{1,6}[ \t]+|[-+*][ \t]+|\d{1,3}[.)][ \t]+)*)/;

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses the comma/newline separated tag list from settings.
 * @param {string} list
 * @returns {Set<string>}
 */
export function parseTagList(list) {
    return new Set(String(list || '')
        .split(/[\s,]+/)
        .map(x => x.trim().replace(/^<\/?|\/?>$/g, '').toLowerCase())
        .filter(Boolean));
}

/**
 * Parses user regex lines ("/pattern/flags" or plain pattern) into RegExp objects.
 * @param {string} text
 * @returns {RegExp[]}
 */
export function parseRegexList(text) {
    const result = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        try {
            const m = line.match(/^\/([\s\S]+)\/([a-z]*)$/);
            let regex = m ? new RegExp(m[1], m[2]) : new RegExp(line);
            if (!regex.flags.includes('g')) regex = new RegExp(regex.source, regex.flags + 'g');
            result.push(regex);
        } catch (e) {
            console.warn('[Cherry Translator] Invalid regex skipped:', line, e);
        }
    }
    return result;
}

function findBalancedEnd(text, from, name) {
    const re = new RegExp(`<(\\/?)${escapeRegex(name)}(?=[\\s/>])[^>]*?(\\/?)>`, 'gi');
    re.lastIndex = from;
    let depth = 1;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[1]) depth--;
        else if (!m[2]) depth++;
        if (depth === 0) return m.index + m[0].length;
    }
    return -1;
}

function findFenceSpans(text) {
    const spans = [];
    const lineRe = /[^\n]*(?:\n|$)/g;
    let open = null;
    let m;
    while ((m = lineRe.exec(text)) !== null) {
        if (m[0] === '') break;
        const start = m.index;
        const end = start + m[0].length;
        const line = m[0].replace(/\n$/, '');
        const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (!open) {
            if (!fence) continue;
            const marker = fence[1];
            const rest = line.slice(fence[0].length);
            // Single-line block like ```text```
            if (marker[0] === '`' && rest.includes(marker)) {
                spans.push([start, start + line.length]);
                continue;
            }
            open = { start, ch: marker[0], len: marker.length };
        } else if (fence && fence[1][0] === open.ch && fence[1].length >= open.len && /^\s*[`~]+\s*$/.test(line)) {
            spans.push([open.start, start + line.length]);
            open = null;
        }
        if (end >= text.length) break;
    }
    if (open) spans.push([open.start, text.length]);
    return spans;
}

/**
 * Finds every region of the text that must never be sent to the translator.
 * @param {string} text
 * @param {object} options
 * @returns {Array<[number, number]>} sorted, merged [start, end) spans
 */
export function findProtectedSpans(text, options = {}) {
    const listed = options.protectedTags instanceof Set ? options.protectedTags : parseTagList(options.protectedTags);
    const protectUnknown = options.protectUnknownTags !== false;
    const protectHtml = options.protectHtmlBlocks !== false;
    const spans = findFenceSpans(text);

    const isInside = (pos) => spans.some(([a, b]) => pos >= a && pos < b);

    // HTML comments are invisible: protect.
    for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
        if (!isInside(m.index)) spans.push([m.index, m.index + m[0].length]);
    }

    const tagRe = /<([A-Za-z][\w:.-]*)(?=[\s/>])[^<>]*?>/g;
    let m;
    while ((m = tagRe.exec(text)) !== null) {
        const start = m.index;
        if (isInside(start)) continue;
        const name = m[1].toLowerCase();
        const selfClosing = /\/\s*>$/.test(m[0]);
        const isListed = listed.has(name);
        const isAlways = ALWAYS_PROTECTED_TAGS.has(name);
        const isBlock = BLOCK_TAGS.has(name);
        const isInline = INLINE_TAGS.has(name);
        const isUnknown = !isInline && !isBlock && !isAlways;
        const shouldProtect = isListed || isAlways || (isBlock && protectHtml) || (isUnknown && protectUnknown);
        if (!shouldProtect) continue;

        const tagEnd = start + m[0].length;
        if (selfClosing || VOID_TAGS.has(name)) {
            spans.push([start, tagEnd]);
            continue;
        }
        const end = findBalancedEnd(text, tagEnd, name);
        if (end > 0) {
            spans.push([start, end]);
            tagRe.lastIndex = end;
        } else if (isListed || isAlways) {
            // Unclosed listed block (e.g. truncated output): protect till the end.
            spans.push([start, text.length]);
            break;
        } else {
            spans.push([start, tagEnd]);
        }
    }

    // Closing tags left alone (e.g. "</status>" without opener) should not be translated either.
    for (const c of text.matchAll(/<\/([A-Za-z][\w:.-]*)\s*>/g)) {
        const name = c[1].toLowerCase();
        if (INLINE_TAGS.has(name)) continue;
        if (!isInside(c.index)) spans.push([c.index, c.index + c[0].length]);
    }

    for (const regex of options.customRegexes || []) {
        regex.lastIndex = 0;
        for (const r of text.matchAll(regex)) {
            if (!r[0]) continue;
            spans.push([r.index, r.index + r[0].length]);
        }
    }

    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] < last[1]) {
            last[1] = Math.max(last[1], span[1]);
        } else {
            merged.push([span[0], span[1]]);
        }
    }
    return merged;
}

/**
 * Returns the script family key of a language name.
 * @param {string} lang
 * @returns {'ko'|'en'|'ja'|'zh'|null}
 */
export function scriptKey(lang) {
    const l = String(lang || '').toLowerCase();
    if (/korean|한국|한글|^ko\b/.test(l)) return 'ko';
    if (/english|영어|^en\b/.test(l)) return 'en';
    if (/japanese|일본|^ja\b/.test(l)) return 'ja';
    if (/chinese|중국|^zh\b/.test(l)) return 'zh';
    return null;
}

const SCRIPT_TESTS = {
    ko: /[가-힣ᄀ-ᇿ㄰-㆏]/,
    en: /[A-Za-z]/,
    ja: /[぀-ヿㇰ-ㇿ一-鿿]/,
    zh: /[一-鿿㐀-䶿]/,
};

/**
 * Whether a piece of text still contains letters that are not in the target language's script.
 * @param {string} text masked text (placeholders already removed)
 * @param {string} targetLang
 */
export function needsTranslation(text, targetLang) {
    const letters = text.match(/\p{L}/gu);
    if (!letters) return false;
    const key = scriptKey(targetLang);
    if (!key) return true;
    const test = SCRIPT_TESTS[key];
    let foreign = 0;
    for (const ch of letters) {
        if (!test.test(ch)) foreign++;
        if (foreign >= 2) return true;
    }
    return false;
}

/**
 * Masks inline markup inside one line so the model cannot break it.
 * @param {string} body
 */
export function maskInline(body) {
    const tokens = [];
    const masked = body.replace(INLINE_MASK_RE, (match) => {
        tokens.push(match);
        return `${TOKEN_OPEN}${tokens.length}${TOKEN_CLOSE}`;
    });
    return { masked, tokens };
}

export function unmaskInline(text, tokens) {
    return text.replace(new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, 'g'), (match, n) => tokens[Number(n) - 1] ?? match);
}

function makeLinePart(line, targetLang) {
    const lead = (line.match(BLOCK_PREFIX_RE) || [''])[0];
    const rest = line.slice(lead.length);
    const trailMatch = rest.match(/\s*$/);
    const trail = trailMatch ? trailMatch[0] : '';
    const body = rest.slice(0, rest.length - trail.length);
    if (!body) return { raw: line };

    const { masked, tokens } = maskInline(body);
    const check = masked.replace(new RegExp(`${TOKEN_OPEN}\\d+${TOKEN_CLOSE}`, 'g'), ' ');
    if (!needsTranslation(check, targetLang)) return { raw: line };

    return {
        line: true,
        original: line,
        lead,
        body,
        trail,
        masked,
        tokens,
        // Markdown tables break if wrapped in a span.
        nowrap: /^\s*\|/.test(line),
        translated: null,
    };
}

/**
 * Splits text into raw parts (kept as-is) and line parts (to translate).
 * @param {string} text
 * @param {object} options { targetLang, protectedTags, protectUnknownTags, protectHtmlBlocks, customRegexes }
 */
export function buildParts(text, options = {}) {
    const spans = findProtectedSpans(text, options);
    const parts = [];
    let pos = 0;
    const pushNormal = (chunk) => {
        const lines = chunk.split('\n');
        lines.forEach((line, i) => {
            if (i > 0) parts.push({ raw: '\n' });
            if (line) parts.push(makeLinePart(line, options.targetLang));
        });
    };
    for (const [a, b] of spans) {
        if (a > pos) pushNormal(text.slice(pos, a));
        parts.push({ raw: text.slice(a, b), protected: true });
        pos = b;
    }
    if (pos < text.length) pushNormal(text.slice(pos));
    return parts;
}

/**
 * Splits items into request batches.
 * @template T
 * @param {T[]} items
 * @param {number} maxLines
 * @param {number} maxChars
 * @returns {T[][]}
 */
export function makeBatches(items, maxLines = 40, maxChars = 5000) {
    const batches = [];
    let current = [];
    let chars = 0;
    for (const item of items) {
        const len = item.masked.length;
        if (current.length && (current.length >= maxLines || chars + len > maxChars)) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(item);
        chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
}

export function buildUserPrompt(items) {
    return items.map((item, i) => `[[${i + 1}]] ${item.masked}`).join('\n');
}

/**
 * Parses "[[n]] text" lines from the model's reply.
 * @param {string} content
 * @returns {Map<number, string>}
 */
export function parseNumbered(content) {
    const map = new Map();
    let text = String(content || '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/\r\n?/g, '\n');
    let current = null;
    for (const rawLine of text.split('\n')) {
        const m = rawLine.match(/^\s*(?:[-*]\s*)?\[\[\s*(\d+)\s*\]\]\s?(.*)$/);
        if (m) {
            const n = Number(m[1]);
            if (map.has(n)) {
                current = null;
                continue;
            }
            map.set(n, m[2]);
            current = n;
            continue;
        }
        if (/^\s*(`{3,}|~{3,})/.test(rawLine)) continue;
        if (current !== null && rawLine.trim()) {
            map.set(current, `${map.get(current)} ${rawLine.trim()}`.trim());
        }
    }
    return map;
}

/**
 * Checks one translated line and returns the unmasked text, or null if it is unusable.
 * @param {string|undefined} out
 * @param {{tokens: string[], masked: string}} item
 */
export function validateLine(out, item) {
    if (typeof out !== 'string') return null;
    const text = out.trim();
    if (!text) return null;
    if (/\[\[\s*\d+\s*\]\]/.test(text)) return null;
    const found = [...text.matchAll(new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, 'g'))].map(x => Number(x[1]));
    if (found.length !== item.tokens.length) return null;
    const seen = new Set(found);
    if (seen.size !== item.tokens.length) return null;
    for (let i = 1; i <= item.tokens.length; i++) {
        if (!seen.has(i)) return null;
    }
    return unmaskInline(text, item.tokens);
}

/**
 * Puts the translated message back together.
 * @param {Array} parts
 * @param {{wrap: boolean}} options
 * @returns {{display: string, plain: string, originals: string[], translated: number, failed: number}}
 */
export function assemble(parts, { wrap = true } = {}) {
    let display = '';
    let plain = '';
    const originals = [];
    let translated = 0;
    let failed = 0;
    for (const part of parts) {
        if (!part.line) {
            display += part.raw;
            plain += part.raw;
            continue;
        }
        if (part.translated == null) {
            failed++;
            display += part.original;
            plain += part.original;
            continue;
        }
        translated++;
        const line = part.lead + part.translated + part.trail;
        plain += line;
        if (wrap && !part.nowrap) {
            const idx = originals.push(part.original) - 1;
            display += `${part.lead}<span class="mt-line" data-mt="${idx}">${part.translated}</span>${part.trail}`;
        } else {
            display += line;
        }
    }
    return { display, plain, originals, translated, failed };
}
