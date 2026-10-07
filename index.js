// MultiCast TTS — ElevenLabs multi-voice TTS for SillyTavern
// (internal ids stay 'voice_cast' so existing settings and saved scripts keep working)
// Extracts dialogue + inner thoughts with a separate LLM call, tags speaker/gender/emotion,
// and plays each line with its own ElevenLabs voice (audio tags supported on v3/v4).

const MODULE_NAME = 'voice_cast';
const LOG = '[MultiCast TTS]';

// Text to Speech page — the generation History panel lives here
const ELEVENLABS_HISTORY_URL = 'https://elevenlabs.io/app/speech-synthesis/text-to-speech';

const MODELS = [
    { id: 'eleven_v4', label: 'Eleven v4 (오디오 태그 O)', tags: true },
    { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo (오디오 태그 O)', tags: true },
    { id: 'eleven_v3', label: 'Eleven v3 (오디오 태그 O)', tags: true, snapStability: true },
    { id: 'eleven_multilingual_v2', label: 'Multilingual v2 (태그 X)', tags: false },
    { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (태그 X)', tags: false },
    { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 (태그 X)', tags: false },
];

const defaultSettings = Object.freeze({
    enabled: true,
    autoPlay: false,
    pregenerate: false,
    highlight: true,
    quickButtons: false,
    lineButtons: false,      // small ▶ next to each line that already has audio     // show 🔊/📜 on the message itself instead of only in the … menu
    includeThoughts: true,
    preferTranslation: true, // legacy, replaced by voiceLang
    voiceLang: 'display',    // 'display' (what's on screen) | 'original' | 'translate'
    translateTo: 'English',
    translationWaitSec: 0,

    profileId: '',
    maxTokens: 4096,
    contextChars: 1500,
    extraInstructions: '',

    model: 'eleven_v4',
    stability: 0.5,
    similarity: 0.75,
    useTags: true,
    thoughtTag: 'whispering',
    concurrency: 2,
    volume: 1,
    audioCacheMB: 300,

    maleVoiceId: '',
    femaleVoiceId: '',
    unknownVoiceId: '',
    cast: [],        // shared cast (applies to every bot)
    castByBot: {},   // { 'char:<avatar>' | 'group:<id>': [entries] }
    castAutoSeen: {}, // { botKey: [names already auto-filled] }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!Array.isArray(s.cast)) s.cast = [];
    if (!s.castByBot || typeof s.castByBot !== 'object') s.castByBot = {};
    if (!s.castAutoSeen || typeof s.castAutoSeen !== 'object') s.castAutoSeen = {};
    if (!s._migratedVoiceLang) {
        if (s.preferTranslation === false) s.voiceLang = 'original';
        s._migratedVoiceLang = true;
    }
    if (!['display', 'original', 'translate'].includes(s.voiceLang)) s.voiceLang = 'display';
    // v1.2 migration: thinking models need more room than the old 2048 default
    if (!s._migratedMaxTokens) {
        if (Number(s.maxTokens) === 2048) s.maxTokens = 4096;
        s._migratedMaxTokens = true;
    }
    return s;
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function modelInfo(id) {
    // Unknown (custom-typed) models: assume audio tags work — the "use tags" checkbox still controls it.
    return MODELS.find(m => m.id === id) ?? { id, label: id, tags: true, snapStability: /^eleven_v3/.test(id) };
}

function isPresetModel(id) {
    return MODELS.some(m => m.id === id);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function cleanMessageText(text) {
    if (!text) return '';
    return String(text)
        .replace(/```[\s\S]*?```/g, ' ')          // code blocks
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')                  // html tags
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/** Translation currently shown on screen (LLM Translator → display_text, Mirror Translator → its own data). */
function getShownTranslation(message) {
    const mirror = message?.extra?.mirror_translator;
    if (mirror && typeof mirror === 'object' && mirror.showing === 'translation' && mirror.source === message.mes && mirror.display) {
        return mirror.display;
    }
    return message?.extra?.display_text || '';
}

/** LLM Translator's side-by-side mode puts both languages in display_text as paired spans. */
function bilingualParts(displayText) {
    const grab = cls => [...String(displayText ?? '').matchAll(new RegExp(`<span class="${cls}[^"]*">([\\s\\S]*?)</span>`, 'g'))].map(m => m[1]);
    const trans = grab('translated_text');
    const orig = grab('original_text');
    return trans.length && trans.length === orig.length ? { trans, orig } : null;
}

/** Text the voices are based on: what's on screen (translation), or the original message. */
function getMessageText(message) {
    const s = getSettings();
    const shown = getShownTranslation(message);
    const pairs = bilingualParts(shown);
    const translated = pairs ? pairs.trans.join('\n') : shown;
    if (s.voiceLang === 'display' && translated) return cleanMessageText(translated);
    return cleanMessageText(message?.mes ?? '');
}

const VOICE_LANG_LABELS = { display: '화면에 보이는 대로', original: '원문 그대로', translate: 'AI 번역' };

function voiceLangLabel() {
    const s = getSettings();
    return s.voiceLang === 'translate' ? `AI 번역 → ${s.translateTo || 'English'}` : VOICE_LANG_LABELS[s.voiceLang];
}

/** Each language mode keeps its own script per message, so switching back and forth costs nothing. */
function variantKey() {
    const s = getSettings();
    return s.voiceLang === 'translate' ? `tr:${String(s.translateTo || 'English').trim().toLowerCase()}` : s.voiceLang;
}

function getStoredEntry(message) {
    const root = message?.extra?.[MODULE_NAME];
    if (!root) return null;
    if (root.variants?.[variantKey()]) return root.variants[variantKey()];
    if (Array.isArray(root.script) && !root.variants) return root; // pre-1.6 data (validated by hash)
    return null;
}

function setStoredEntry(message, entry) {
    message.extra = message.extra ?? {};
    const root = (message.extra[MODULE_NAME] ??= {});
    if (Array.isArray(root.script) && !root.variants) {
        // migrate pre-1.6 single script into the 'display' slot
        root.variants = { display: { hash: root.hash, textHash: root.textHash, script: root.script, edited: root.edited } };
    }
    root.variants ??= {};
    delete root.script; delete root.hash; delete root.textHash; delete root.edited;
    root.variants[variantKey()] = entry;
}

function normName(str) {
    return String(str ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Per-bot cast
// ---------------------------------------------------------------------------

/** The bot (character card or group) of the open chat, or null when no chat is open. */
function currentBot() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) {
        const g = ctx.groups?.find(x => x.id === ctx.groupId);
        if (!g) return null;
        const members = (g.members ?? []).map(a => ctx.characters?.find(c => c.avatar === a)?.name).filter(Boolean);
        return { key: `group:${g.id}`, name: g.name || '그룹', members };
    }
    if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const c = ctx.characters?.[ctx.characterId];
        if (c) return { key: `char:${c.avatar}`, name: c.name, members: [c.name] };
    }
    return null;
}

function getBotCast(create = false) {
    const s = getSettings();
    const bot = currentBot();
    if (!bot) return null;
    if (!Array.isArray(s.castByBot[bot.key]) && create) s.castByBot[bot.key] = [];
    return s.castByBot[bot.key] ?? null;
}

/** Bot cast first (more specific), then the shared cast. */
function allCastEntries() {
    return [...(getBotCast() ?? []), ...getSettings().cast];
}

function entryNames(entry, userName) {
    const u = normName(userName);
    return String(entry.names ?? '').split(',').map(normName).filter(Boolean)
        .map(n => (n === '{{user}}' ? u : n));
}

/** Like the built-in TTS: make sure the open chat's characters and the persona have a row. */
function ensureBotCast() {
    const bot = currentBot();
    if (!bot) return;
    const userName = SillyTavern.getContext().name1;
    const s = getSettings();
    const list = getBotCast(true);
    // names already auto-added once for this bot — never re-added, so deleting/renaming a row sticks
    const seen = (s.castAutoSeen[bot.key] ??= []);
    const known = name => allCastEntries().some(e => entryNames(e, userName).includes(normName(name)));
    let changed = false;
    for (const name of bot.members) {
        if (!name || seen.includes(normName(name))) continue;
        seen.push(normName(name));
        changed = true;
        if (!known(name)) list.push({ names: name, gender: 'u', voiceId: '' });
    }
    // The persona row: ST may switch to the bot's linked persona a moment after the chat opens,
    // so an auto-added persona row that has no voice yet follows the current persona.
    const autoUser = [...list].reverse().find(e => e.autoUser);
    const untouched = autoUser && !autoUser.voiceId && normName(autoUser.names) === normName(autoUser.autoUser);
    if (userName && untouched && normName(autoUser.names) !== normName(userName)) {
        if (known(userName)) list.splice(list.indexOf(autoUser), 1);
        else { autoUser.names = userName; autoUser.autoUser = userName; }
        if (!seen.includes(normName(userName))) seen.push(normName(userName));
        changed = true;
    } else if (userName && !seen.includes(normName(userName))) {
        seen.push(normName(userName));
        changed = true;
        if (!known(userName)) list.push({ names: userName, gender: 'u', voiceId: '', autoUser: userName });
    }
    if (changed) save();
}

// ---------------------------------------------------------------------------
// Classifier (separate LLM call)
// ---------------------------------------------------------------------------

function buildClassifierPrompt(text, prevText) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const userName = ctx.name1 || 'User';
    const charName = ctx.name2 || '';

    const known = [];
    known.push(`- ${userName} (the user's own character)`);
    if (charName && charName !== userName) known.push(`- ${charName} (main character of this chat)`);
    if (ctx.groupId) {
        const group = ctx.groups?.find(g => g.id === ctx.groupId);
        for (const avatar of group?.members ?? []) {
            const c = ctx.characters?.find(ch => ch.avatar === avatar);
            if (c?.name && c.name !== charName) known.push(`- ${c.name}`);
        }
    }
    for (const entry of allCastEntries()) {
        const names = String(entry.names ?? '').split(',').map(n => n.trim()).filter(Boolean)
            .map(n => (n.toLowerCase() === '{{user}}' ? userName : n));
        if (!names.length) continue;
        const g = entry.gender === 'm' ? 'male' : entry.gender === 'f' ? 'female' : 'unknown gender';
        known.push(`- ${names[0]}${names.length > 1 ? ` (aliases: ${names.slice(1).join(', ')})` : ''} — ${g}`);
    }

    const translating = s.voiceLang === 'translate';
    const targetLang = String(s.translateTo || 'English').trim() || 'English';

    const thoughtRule = s.includeThoughts
        ? `- Inner thoughts are usually written inside *asterisks*, BUT asterisks are also used for narration. Extract asterisk text ONLY when it is clearly a character's internal monologue (first-person thinking), never descriptions of actions, scenery, or third-person narration. Mark these with "type":"thought".`
        : '- Do NOT extract inner thoughts. Extract spoken dialogue only.';

    const system = [
        'You are a voice-acting script extractor for a text-to-speech engine.',
        'Read a roleplay message and extract ONLY spoken dialogue lines' + (s.includeThoughts ? ' and inner thoughts' : '') + ', in the exact order they appear. Ignore all narration.',
        '',
        'Rules:',
        '- Spoken dialogue is usually inside quotes ("...", “...”, 「...」, 『...』). Mark these with "type":"speech".',
        thoughtRule,
        translating
            ? `- "orig": copy the line EXACTLY as written in the message, without the surrounding quotes or asterisks. Remove any narration that interrupts a line.\n- "text": translate "orig" into natural, spoken ${targetLang} that keeps the character's tone, speech style, and emotion (casual stays casual, rough stays rough). Translate the whole line faithfully; do not summarize, censor, or add lines.`
            : '- "text": copy the line EXACTLY as written, in its original language, without the surrounding quotes or asterisks. Never translate, summarize, censor, or add words. Remove any narration that interrupts a line.',
        `- "speaker": who says/thinks it. Use the exact name from the known characters list when it matches. The user's character is "${userName}" — in impersonation-style messages the user's character may also speak. Unnamed side characters get a short descriptive English label (e.g. "waiter", "old man"). Use "unknown" only if truly impossible to tell.`,
        '- "gender": "m", "f", or "u". Infer from names, pronouns, honorifics, and context. Use the gender given in the known characters list when available.',
        '- "tag": ONE short English delivery tag for voice acting, describing HOW the line is said: e.g. angry, sad, laughing, whispering, shouting, sighing, excited, nervous, sarcastic, crying, cold, flustered, playful, tired, pleading. Use "" for neutral delivery.',
        '- Output ONLY a valid JSON array. No prose, no markdown, no code fences. Escape any double quote inside a string as \\". If there is nothing to extract, output [].',
        '',
        'Format:',
        translating
            ? '[{"speaker":"Name","gender":"f","type":"speech","tag":"angry","orig":"...","text":"..."}]'
            : '[{"speaker":"Name","gender":"f","type":"speech","tag":"angry","text":"..."}]',
    ];
    if (s.extraInstructions?.trim()) {
        system.push('', 'Additional instructions from the user:', s.extraInstructions.trim());
    }

    const user = [
        'Known characters:',
        known.join('\n'),
        '',
    ];
    if (prevText) {
        user.push('Previous message (CONTEXT ONLY — do not extract from it):', '<<<', prevText, '>>>', '');
    }
    user.push('Message to extract from:', '<<<', text, '>>>');

    return { system: system.join('\n'), user: user.join('\n') };
}

class ClassifierError extends Error {
    constructor(message, raw) {
        super(message);
        this.raw = raw;
    }
}

/** Pulls every complete top-level {...} object out of a (possibly truncated / messy) string. */
function salvageObjects(str) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (c === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start !== -1) {
                try { out.push(JSON.parse(str.slice(start, i + 1))); } catch { /* skip broken object */ }
                start = -1;
            }
        }
    }
    return out;
}

function parseClassifierOutput(raw) {
    const cleaned = String(raw ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();

    if (!cleaned) {
        throw new ClassifierError('분류 AI가 빈 응답을 보냈어요. 검열에 걸렸거나 "최대 응답 토큰"이 부족했을 수 있어요 (생각하는 모델은 4096 이상 추천).', raw);
    }
    if (cleaned === '[]') return [];

    let arr = null;
    let partial = false;

    // 1) the normal case: one JSON array
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            if (Array.isArray(parsed)) arr = parsed;
        } catch { /* fall through */ }
    }
    // 2) an object wrapping the array, e.g. {"lines":[...]}
    if (!arr) {
        try {
            const obj = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
            const inner = obj && Object.values(obj).find(v => Array.isArray(v));
            if (inner) arr = inner;
        } catch { /* fall through */ }
    }
    // 3) truncated or messy output: keep whatever complete line objects exist
    if (!arr) {
        const objs = salvageObjects(cleaned).filter(o => typeof o?.text === 'string');
        if (objs.length) {
            arr = objs;
            partial = true;
        }
    }
    if (!arr) {
        throw new ClassifierError('분류 결과에서 대사 목록(JSON)을 찾지 못했어요.', raw);
    }
    if (partial) {
        toastr.warning('분류 결과가 중간에 잘려서 일부 대사만 읽어요. "최대 응답 토큰"을 늘려보세요.', 'MultiCast TTS');
    }

    return arr
        .filter(x => x && typeof x.text === 'string' && x.text.trim())
        .map(x => ({
            speaker: String(x.speaker ?? 'unknown').trim() || 'unknown',
            gender: ['m', 'f'].includes(String(x.gender).toLowerCase()) ? String(x.gender).toLowerCase() : 'u',
            type: x.type === 'thought' ? 'thought' : 'speech',
            tag: String(x.tag ?? '').replace(/[[\]]/g, '').trim(),
            text: x.text.trim(),
            ...(typeof x.orig === 'string' && x.orig.trim() ? { orig: x.orig.trim() } : {}),
        }));
}

async function runClassifier(text, prevText) {
    try {
        return await runClassifierOnce(text, prevText);
    } catch (e) {
        if (!(e instanceof ClassifierError)) throw e;
        // one automatic retry — models sometimes answer with prose or get cut off
        console.warn(LOG, 'classifier output unusable, retrying once. Raw output was:', e.raw);
        try {
            return await runClassifierOnce(text, prevText);
        } catch (e2) {
            if (e2 instanceof ClassifierError) {
                console.warn(LOG, 'classifier failed twice. Raw output was:', e2.raw);
                const preview = String(e2.raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
                throw new Error(`${e2.message}${preview ? `\nAI 응답 앞부분: "${preview}…"` : ''}\n(전체 응답은 F12 콘솔에 있어요)`);
            }
            throw e2;
        }
    }
}

async function runClassifierOnce(text, prevText) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const { system, user } = buildClassifierPrompt(text, prevText);

    let raw;
    if (s.profileId) {
        const result = await ctx.ConnectionManagerRequestService.sendRequest(
            s.profileId,
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            Number(s.maxTokens) || 4096,
        );
        raw = typeof result === 'string' ? result : result?.content;
    } else {
        raw = await ctx.generateRaw({
            systemPrompt: system,
            prompt: user,
            responseLength: Number(s.maxTokens) || 4096,
        });
    }
    console.debug(LOG, 'classifier raw output:', raw);
    return parseClassifierOutput(raw);
}

/**
 * Returns the cached script for a message, or classifies it now.
 */
const scriptInflight = new Map(); // messageId -> Promise (avoids classifying the same message twice at once)

function scriptKey(text) {
    const s = getSettings();
    const extra = s.voiceLang === 'translate' ? `|${variantKey()}` : '';
    return hashString(`${text}|${s.includeThoughts ? 1 : 0}${extra}`);
}

async function getScript(messageId, { force = false } = {}) {
    const inflightKey = `${messageId}|${variantKey()}`;
    const running = scriptInflight.get(inflightKey);
    if (running && !force) return running;
    const p = getScriptInner(messageId, { force }).finally(() => {
        if (scriptInflight.get(inflightKey) === p) scriptInflight.delete(inflightKey);
    });
    scriptInflight.set(inflightKey, p);
    return p;
}

async function getScriptInner(messageId, { force = false } = {}) {
    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message) throw new Error('메시지를 찾을 수 없어요.');

    const s = getSettings();
    const text = getMessageText(message);
    if (!text) return [];

    const textHash = hashString(text);
    const key = scriptKey(text);
    const cached = getStoredEntry(message);
    if (!force && Array.isArray(cached?.script)) {
        // A script the user edited is kept as long as the message text itself didn't change
        if (cached.edited && cached.textHash === textHash) return cached.script;
        if (cached.hash === key) return cached.script;
    }

    let prevText = '';
    const contextChars = Number(s.contextChars) || 0;
    if (contextChars > 0 && messageId > 0) {
        const prev = ctx.chat[messageId - 1];
        if (prev) prevText = getMessageText(prev).slice(-contextChars);
    }

    const script = await runClassifier(text, prevText);

    setStoredEntry(message, { hash: key, textHash, script, edited: false });
    await ctx.saveChat();
    return script;
}

async function saveEditedScript(messageId, script) {
    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message) return;
    const text = getMessageText(message);
    setStoredEntry(message, {
        hash: scriptKey(text),
        textHash: hashString(text),
        script,
        edited: true,
    });
    await ctx.saveChat();
}

// ---------------------------------------------------------------------------
// Voice mapping
// ---------------------------------------------------------------------------

function findCastEntry(speaker) {
    const target = normName(speaker);
    if (!target) return null;
    const userName = SillyTavern.getContext().name1;
    const entries = allCastEntries(); // bot cast first, then shared

    const pick = (matches) => matches.find(e => e.voiceId) ?? matches[0] ?? null;
    // exact name/alias match ("{{user}}" counts as the persona name)
    const exact = entries.filter(e => entryNames(e, userName).includes(target));
    if (exact.length) return pick(exact);
    // looser match: one contains the other (e.g. "서윤" vs "한서윤")
    const loose = entries.filter(e => entryNames(e, userName)
        .some(n => n.length >= 2 && (target.includes(n) || n.includes(target))));
    return pick(loose);
}

function pickVoice(line) {
    const s = getSettings();
    if (line.voiceId) return line.voiceId; // manual override from the script editor
    const entry = findCastEntry(line.speaker);
    if (entry?.voiceId) return entry.voiceId;
    // no voice assigned yet: use the gender from the line, or the one set in the cast row
    const gender = line.gender !== 'u' ? line.gender : (entry?.gender ?? 'u');
    if (gender === 'm' && s.maleVoiceId) return s.maleVoiceId;
    if (gender === 'f' && s.femaleVoiceId) return s.femaleVoiceId;
    return s.unknownVoiceId || s.maleVoiceId || s.femaleVoiceId || '';
}

function buildTtsText(line) {
    const s = getSettings();
    if (!s.useTags || !modelInfo(s.model).tags) return line.text;
    const tags = [];
    if (line.type === 'thought' && s.thoughtTag?.trim()) tags.push(s.thoughtTag.trim());
    if (line.tag && !tags.includes(line.tag)) tags.push(line.tag);
    return tags.map(t => `[${t}]`).join(' ') + (tags.length ? ' ' : '') + line.text;
}

// ---------------------------------------------------------------------------
// ElevenLabs (through SillyTavern's server, uses the key saved in ST secrets)
// ---------------------------------------------------------------------------

// --- Audio cache: memory (blob URLs) + persistent IndexedDB (survives reloads) ---

const memoryUrls = new Map(); // key -> blob URL
const MEMORY_URL_LIMIT = 200;
const INDEX_KEY = '__index__';
let store = null;
let storeIndex = null; // { key: { t: lastUsed, size } }

function getStore() {
    if (store) return store;
    const lf = SillyTavern.libs?.localforage ?? globalThis.localforage;
    if (!lf) return null;
    store = lf.createInstance({ name: 'SillyTavern_VoiceCast', storeName: 'audio' });
    return store;
}

async function loadIndex() {
    if (storeIndex) return storeIndex;
    try {
        storeIndex = (await getStore()?.getItem(INDEX_KEY)) ?? {};
    } catch {
        storeIndex = {};
    }
    return storeIndex;
}

let indexSaveTimer = null;
function saveIndexSoon() {
    clearTimeout(indexSaveTimer);
    indexSaveTimer = setTimeout(() => {
        getStore()?.setItem(INDEX_KEY, storeIndex).catch(e => console.warn(LOG, 'index save failed', e));
    }, 1000);
}

function rememberUrl(key, blob) {
    if (memoryUrls.has(key)) return memoryUrls.get(key);
    const url = URL.createObjectURL(blob);
    memoryUrls.set(key, url);
    while (memoryUrls.size > MEMORY_URL_LIMIT) {
        const oldest = memoryUrls.keys().next().value;
        URL.revokeObjectURL(memoryUrls.get(oldest));
        memoryUrls.delete(oldest);
    }
    return url;
}

async function getCachedAudio(key) {
    if (memoryUrls.has(key)) return memoryUrls.get(key);
    const st = getStore();
    if (!st) return null;
    try {
        const blob = await st.getItem(key);
        if (!blob) return null;
        const index = await loadIndex();
        index[key] = { t: Date.now(), size: index[key]?.size ?? blob.size ?? 0 };
        saveIndexSoon();
        return rememberUrl(key, blob);
    } catch (e) {
        console.warn(LOG, 'cache read failed', e);
        return null;
    }
}

async function putCachedAudio(key, blob) {
    const st = getStore();
    if (!st) return;
    try {
        await st.setItem(key, blob);
        const index = await loadIndex();
        index[key] = { t: Date.now(), size: blob.size ?? 0 };
        await pruneCache();
        saveIndexSoon();
    } catch (e) {
        console.warn(LOG, 'cache write failed', e);
    }
}

async function pruneCache() {
    const st = getStore();
    const index = await loadIndex();
    const limit = Math.max(10, Number(getSettings().audioCacheMB) || 300) * 1024 * 1024;
    let total = Object.values(index).reduce((a, v) => a + (v.size || 0), 0);
    if (total <= limit) return;
    const oldestFirst = Object.entries(index).sort((a, b) => a[1].t - b[1].t);
    for (const [key, meta] of oldestFirst) {
        if (total <= limit * 0.9) break;
        await st.removeItem(key).catch(() => {});
        delete index[key];
        total -= meta.size || 0;
    }
}

async function cacheStats() {
    const index = await loadIndex();
    const entries = Object.values(index);
    const bytes = entries.reduce((a, v) => a + (v.size || 0), 0);
    return { count: entries.length, mb: bytes / 1024 / 1024 };
}

async function clearAudioCache() {
    await getStore()?.clear();
    storeIndex = {};
    for (const url of memoryUrls.values()) URL.revokeObjectURL(url);
    memoryUrls.clear();
}

function audioCacheKey(text, voiceId, model, stability, similarity) {
    const raw = `${model}|${voiceId}|${stability}|${similarity}|${text}`;
    // two different 32-bit hashes + length → collision-safe enough for a local cache
    let h2 = 0;
    for (let i = 0; i < raw.length; i++) h2 = (Math.imul(h2, 31) + raw.charCodeAt(i)) | 0;
    return `a_${hashString(raw)}_${(h2 >>> 0).toString(36)}_${raw.length}`;
}

/**
 * @returns {Promise<{url: string, key: string}>}
 * @param {boolean} [fresh] skip the cache and store as a separate take (for "make a new take")
 */
const audioInflight = new Map(); // cacheKey -> Promise (preload + play never pay twice for one line)

/** Stability/similarity for a line: the speaker's cast row can override the global sliders. */
function voiceSettingsFor(line) {
    const s = getSettings();
    const entry = line ? findCastEntry(line.speaker) : null;
    const num = (v, d) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
    return {
        stability: num(entry?.stability, Number(s.stability)),
        similarity: num(entry?.similarity, Number(s.similarity)),
    };
}

async function synthesize(text, voiceId, opts = {}) {
    const s = getSettings();
    const fresh = !!opts.fresh;
    const baseKeyPreview = `${s.model}|${voiceId}|${opts.stability ?? s.stability}|${opts.similarity ?? s.similarity}|${text}`;
    if (!fresh && audioInflight.has(baseKeyPreview)) return audioInflight.get(baseKeyPreview);
    const p = synthesizeInner(text, voiceId, opts);
    if (!fresh) {
        audioInflight.set(baseKeyPreview, p);
        p.finally(() => audioInflight.delete(baseKeyPreview)).catch(() => {});
    }
    return p;
}

async function synthesizeInner(text, voiceId, { fresh = false, stability: stabOverride, similarity: simOverride } = {}) {
    const s = getSettings();
    let stability = Number(stabOverride ?? s.stability);
    const similarity = Number(simOverride ?? s.similarity);
    if (modelInfo(s.model).snapStability) {
        // eleven_v3 only accepts 0.0 / 0.5 / 1.0
        stability = [0, 0.5, 1].reduce((a, b) => (Math.abs(b - stability) < Math.abs(a - stability) ? b : a));
    }

    const baseKey = audioCacheKey(text, voiceId, s.model, stability, similarity);
    const cacheKey = fresh ? `${baseKey}_t${Date.now().toString(36)}` : baseKey;
    if (!fresh) {
        const cached = await getCachedAudio(cacheKey);
        if (cached) return { url: cached, key: cacheKey };
    }

    const { getRequestHeaders } = SillyTavern.getContext();
    const response = await fetch('/api/speech/elevenlabs/synthesize', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            voiceId,
            request: {
                model_id: s.model,
                text,
                voice_settings: {
                    stability,
                    similarity_boost: similarity,
                },
            },
        }),
    });
    if (!response.ok) {
        throw new Error(`ElevenLabs 요청 실패 (HTTP ${response.status}). 실리태번 서버 콘솔을 확인해 주세요. (402 payment_required면 무료 플랜에서 못 쓰는 목소리예요)`);
    }
    const blob = await response.blob();
    await putCachedAudio(cacheKey, blob);
    return { url: rememberUrl(cacheKey, blob), key: cacheKey };
}

async function fetchVoices() {
    const { getRequestHeaders } = SillyTavern.getContext();
    const response = await fetch('/api/speech/elevenlabs/voices', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });
    if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        throw err;
    }
    const json = await response.json();
    return (json.voices ?? []).map(v => ({
        id: v.voice_id,
        name: v.name,
        gender: v.labels?.gender ?? '',
        category: v.category ?? '',
    }));
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

let session = 0;
let currentAudio = null;
let playingMessageId = null;

function setButtonState(messageId, playing) {
    const $btn = $(`.mes[mesid="${messageId}"] .vc_play_btn`);
    $btn.toggleClass('vc_playing', playing)
        .toggleClass('fa-volume-high', !playing)
        .toggleClass('fa-stop', playing)
        .attr('title', playing ? 'MultiCast TTS 정지' : 'MultiCast TTS 재생 (Shift+클릭: 다시 분류)');
}

// --- Status pill next to the speaker name (shows what MultiCast TTS is doing) ---

const statusTimers = new Map();

/**
 * @param {number|null} messageId
 * @param {string|null} html  null removes the pill
 * @param {'busy'|'play'|'done'|'error'} [state]
 */
function setStatus(messageId, html, state = 'busy') {
    if (messageId === null || messageId === undefined) return;
    clearTimeout(statusTimers.get(messageId));
    const $mes = $(`#chat .mes[mesid="${messageId}"]`);
    let $pill = $mes.find('.vc_status');
    if (!html) {
        $pill.remove();
        return;
    }
    if (!$pill.length) {
        $pill = $('<span class="vc_status" title="MultiCast TTS — 클릭하면 정지"></span>');
        const $anchor = $mes.find('.ch_name .name_text').first();
        if ($anchor.length) $anchor.parent().append($pill);
        else $mes.find('.mes_block').first().prepend($pill);
    }
    $pill.attr('data-state', state).html(html);
    if (state === 'done' || state === 'error') {
        statusTimers.set(messageId, setTimeout(() => $pill.remove(), state === 'error' ? 6000 : 1500));
    }
}

// --- Highlight the line being spoken (CSS Custom Highlight API; no DOM changes) ---

const HL_NAME = 'voice-cast-current';

function clearHighlight() {
    try { globalThis.CSS?.highlights?.delete(HL_NAME); } catch { /* unsupported */ }
}

/** Letters and digits only, lowercased: immune to quotes/apostrophes (' vs ’), ellipses, markdown and spacing. */
const MATCH_CHAR = /[\p{L}\p{N}]/u;

function findTextRange(root, needle) {
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let full = '';
    const map = []; // index in `full` -> { node, offset }
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.nodeValue ?? '';
        for (let i = 0; i < t.length; i++) {
            if (!MATCH_CHAR.test(t[i])) continue;
            full += t[i].toLowerCase();
            map.push({ node: n, offset: i });
        }
    }
    const target = [...String(needle ?? '')].filter(ch => MATCH_CHAR.test(ch)).join('').toLowerCase();
    if (!target || !full) return null;
    let start = full.indexOf(target);
    let end = start === -1 ? -1 : start + target.length;
    if (start === -1 && target.length > 8) {
        // line was edited or narration in the middle was cut out → anchor on its start, then
        // follow the rest of the line piece by piece so the highlight still covers all of it
        const k = Math.min(12, Math.floor(target.length / 2));
        start = full.indexOf(target.slice(0, k));
        if (start === -1) return null;
        end = start + k;
        let i = k;
        while (i < target.length) {
            const chunk = target.slice(i, i + Math.min(5, target.length - i));
            const q = full.indexOf(chunk, end);
            if (q === -1 || q - end > 300) { i++; continue; }
            let len = chunk.length;
            while (i + len < target.length && full[q + len] === target[i + len]) len++;
            end = q + len;
            i += len;
        }
    }
    if (start === -1) return null;
    const a = map[start];
    const b = map[end - 1];
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset + 1);
    return range;
}

// --- Original <-> translation mapping, so the highlight follows whichever one is on screen ---

const SEGMENT_RE = /"[^"\n]+"|\u201C[^\u201D\n]+\u201D|\u300C[^\u300D\n]+\u300D|\u300E[^\u300F\n]+\u300F|\*[^*\n]+\*/g;

/** Comparable form: no markdown/quote marks, collapsed spaces, lowercase. */
function normForMatch(str) {
    return String(str ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_~`"\u201C\u201D\u300C\u300D\u300E\u300F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function textLines(str) {
    return cleanMessageText(str).split('\n').map(l => l.trim()).filter(Boolean);
}

/** Every version of this message's text we know about (original first). */
function messageVersions(message) {
    const ex = message?.extra ?? {};
    const list = [message?.mes, ex.mirror_translator?.display, ex.display_text, ex.original_translation_backup];
    const seen = new Set();
    return list.filter(t => {
        if (!t || typeof t !== 'string') return false;
        const key = normForMatch(t);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Where the line sits in a text: { lineIdx, segIdx } (segIdx = which quote/asterisk segment, -1 if none). */
function locateLine(text, needle) {
    const target = normForMatch(needle);
    if (!target) return null;
    const probe = target.length > 16 ? target.slice(0, 16) : target;
    const lines = textLines(text);
    for (let li = 0; li < lines.length; li++) {
        const nl = normForMatch(lines[li]);
        if (!nl.includes(target) && !nl.includes(probe)) continue;
        const segs = lines[li].match(SEGMENT_RE) ?? [];
        const segIdx = segs.findIndex(sg => {
            const ns = normForMatch(sg);
            return ns && (ns.includes(probe) || target.includes(ns));
        });
        return { lineIdx: li, segIdx };
    }
    return null;
}

/** The matching piece of another version of the text (same line, same segment if possible). */
function pieceAt(text, pos) {
    const line = textLines(text)[pos.lineIdx];
    if (!line) return null;
    const segs = line.match(SEGMENT_RE) ?? [];
    const piece = pos.segIdx >= 0 && segs[pos.segIdx] ? segs[pos.segIdx] : line;
    return piece.replace(/^[*"\u201C\u300C\u300E]+|[*"\u201D\u300D\u300F]+$/g, '').replace(/[*_~`]/g, '').trim();
}

/** Side-by-side translation on screen: highlight the line in both languages. */
function findBilingualRanges(root, message, text) {
    const pairs = bilingualParts(message?.extra?.display_text);
    if (!pairs) return [];
    // SillyTavern prefixes classes inside messages with "custom-"
    const els = {
        orig: root.querySelectorAll('.original_text, .custom-original_text'),
        trans: root.querySelectorAll('.translated_text, .custom-translated_text'),
    };
    if (els.orig.length !== pairs.orig.length || els.trans.length !== pairs.trans.length) return [];
    const ranges = [];
    for (const [from, to] of [['orig', 'trans'], ['trans', 'orig']]) {
        for (let p = 0; p < pairs[from].length; p++) {
            const pos = locateLine(pairs[from][p], text);
            if (!pos) continue;
            const own = findTextRange(els[from][p], text) ?? findTextRange(els[from][p], pieceAt(pairs[from][p], pos));
            const piece = pieceAt(pairs[to][p], { lineIdx: 0, segIdx: pos.segIdx });
            const other = piece && findTextRange(els[to][p], piece);
            if (own) ranges.push(own);
            if (other) ranges.push(other);
            if (ranges.length) return ranges;
        }
    }
    return ranges;
}

function findLineRanges(root, messageId, text) {
    const message = SillyTavern.getContext().chat?.[messageId];
    const both = findBilingualRanges(root, message, text);
    if (both.length) return both;
    const single = findLineRange(root, message, text);
    return single ? [single] : [];
}

function findLineRange(root, message, text) {
    const direct = findTextRange(root, text);
    if (direct) return direct;
    // not on screen as-is → the other language is showing; map through the line position
    if (!message) return null;
    const versions = messageVersions(message);
    for (const src of versions) {
        const pos = locateLine(src, text);
        if (!pos) continue;
        for (const other of versions) {
            if (other === src) continue;
            const piece = pieceAt(other, pos);
            const range = piece && findTextRange(root, piece);
            if (range) return range;
        }
    }
    return null;
}

function highlightLine(messageId, text) {
    clearHighlight();
    if (messageId === null || !getSettings().highlight) return;
    if (!globalThis.CSS?.highlights || typeof globalThis.Highlight === 'undefined') return;
    const root = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!root) return;
    try {
        const ranges = findLineRanges(root, messageId, text);
        if (ranges.length) CSS.highlights.set(HL_NAME, new Highlight(...ranges));
    } catch (e) {
        console.debug(LOG, 'highlight failed', e);
    }
}

function stopPlayback() {
    session++;
    clearHighlight();
    setLinePlaying(null);
    setClipPlaying(null);
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    if (playingMessageId !== null) {
        setButtonState(playingMessageId, false);
        setStatus(playingMessageId, null);
        playingMessageId = null;
    }
}

function playUrl(url, mySession) {
    return new Promise((resolve) => {
        if (mySession !== session) return resolve();
        const audio = new Audio(url);
        audio.volume = Math.min(1, Math.max(0, Number(getSettings().volume) || 1));
        currentAudio = audio;
        audio.onended = () => resolve();
        audio.onerror = () => { console.warn(LOG, 'audio error'); resolve(); };
        audio.play().catch((e) => { console.warn(LOG, 'play blocked:', e); resolve(); });
    });
}

/**
 * Starts synthesis for all lines with limited concurrency; returns one promise per line.
 * @param {(ready: number) => void} [onProgress] called whenever another line is ready
 */
function synthesizeAll(lines, isActive, onProgress = null) {
    if (typeof isActive === 'number') {
        const mySession = isActive;
        isActive = () => mySession === session;
    }
    const limit = Math.max(1, Number(getSettings().concurrency) || 2);
    const results = lines.map(() => {
        let resolve;
        const p = new Promise(r => { resolve = r; });
        return { p, resolve };
    });
    let next = 0;
    let ready = 0;
    let firstError = true;
    let pinnedChanged = false;
    let running = 0;
    let doneResolve;
    const done = new Promise(r => { doneResolve = r; });
    const finish = (i, url) => {
        results[i].resolve(url);
        ready++;
        try { onProgress?.(ready); } catch { /* ignore */ }
    };

    async function worker() {
        while (next < lines.length && isActive()) {
            const i = next++;
            const { text, voiceId, src } = lines[i];
            try {
                // 1) audio already pinned to this script line → replay it exactly, whatever the settings are now
                if (src?.audioKey && !src._fresh) {
                    const pinned = await getCachedAudio(src.audioKey);
                    if (pinned) {
                        finish(i, pinned);
                        continue;
                    }
                }
                const fresh = !!src?._fresh;
                if (src) delete src._fresh;
                const { url, key } = await synthesize(text, voiceId, { fresh, ...voiceSettingsFor(src) });
                if (src && src.audioKey !== key) {
                    src.audioKey = key;
                    pinnedChanged = true;
                }
                finish(i, url);
            } catch (e) {
                console.error(LOG, e);
                if (firstError) {
                    firstError = false;
                    toastr.error(String(e.message ?? e), 'MultiCast TTS');
                }
                finish(i, null);
            }
        }
        // cancelled: release anyone still waiting (resolving twice is a no-op for finished ones)
        if (!isActive()) {
            for (const r of results) r.resolve(null);
        }
    }
    const workers = Math.min(limit, lines.length);
    running = workers;
    for (let w = 0; w < workers; w++) {
        worker().finally(() => { if (--running === 0) doneResolve(pinnedChanged); });
    }
    if (!workers) doneResolve(false);
    return { promises: results.map(r => r.p), done };
}

/** Script lines that will actually be voiced, with their voice and final TTS text. */
function buildPlayableLines(script, { keepThoughts = false } = {}) {
    const s = getSettings();
    return script
        .filter(l => keepThoughts || s.includeThoughts || l.type !== 'thought')
        .map(l => ({ src: l, voiceId: pickVoice(l), ttsText: buildTtsText(l) }))
        .filter(l => l.voiceId || l.src.audioKey);
}

function savePinsWhenDone(done, messageId) {
    const chatAtStart = SillyTavern.getContext().chat;
    done.then((changed) => {
        const ctxNow = SillyTavern.getContext();
        if (changed && messageId !== null && ctxNow.chat === chatAtStart) {
            ctxNow.saveChat();
            redecorateMessage(messageId);
        }
    });
}

/**
 * @param {number|null} messageId message to play (null = loose script, e.g. a single-line preview)
 * @param {object} opts
 * @param {boolean} [opts.force] re-classify even if a cached script exists
 * @param {Array} [opts.script] play this script instead of the message's stored one
 */
async function playMessage(messageId, { force = false, script: givenScript = null } = {}) {
    const s = getSettings();
    if (!s.enabled) return;

    stopPlayback();
    const mySession = session;
    playingMessageId = messageId;
    if (messageId !== null) setButtonState(messageId, true);
    let failed = false;

    try {
        let script = givenScript;
        if (!script) {
            const cachedBefore = getStoredEntry(SillyTavern.getContext().chat[messageId]);
            if (force || !cachedBefore) {
                setStatus(messageId, '<i class="fa-solid fa-spinner fa-spin"></i> 대사 분류 중…');
            }
            script = await getScript(messageId, { force });
        }
        if (mySession !== session) return;

        const lines = buildPlayableLines(script, { keepThoughts: !!givenScript });
        if (!lines.length) {
            if (script.length && !s.maleVoiceId && !s.femaleVoiceId && !s.unknownVoiceId) {
                toastr.warning('목소리가 설정되지 않았어요. 확장 설정에서 기본 목소리를 골라주세요.', 'MultiCast TTS');
            } else {
                toastr.info('읽을 대사가 없어요.', 'MultiCast TTS');
            }
            setStatus(messageId, '대사 없음', 'done');
            return;
        }

        const total = lines.length;
        let ready = 0;
        let playingIndex = -1;
        const render = () => {
            if (mySession !== session) return;
            const gen = ready < total ? `<i class="fa-solid fa-spinner fa-spin"></i> 음성 만드는 중 ${ready}/${total}` : '';
            if (playingIndex < 0) {
                setStatus(messageId, gen || '<i class="fa-solid fa-spinner fa-spin"></i> 준비 중…');
            } else {
                setStatus(messageId, `<i class="fa-solid fa-volume-high"></i> ${playingIndex + 1}/${total}${gen ? ` · ${gen}` : ''}`, 'play');
            }
        };
        render();

        console.debug(LOG, 'playing lines:', lines);
        const { promises: audioPromises, done } = synthesizeAll(
            lines.map(l => ({ text: l.ttsText, voiceId: l.voiceId, src: l.src })),
            mySession,
            (n) => { ready = n; render(); },
        );
        // newly generated audio gets pinned to the script lines → save so replays use exactly this take
        savePinsWhenDone(done, messageId);

        for (let i = 0; i < audioPromises.length; i++) {
            const url = await audioPromises[i];
            if (mySession !== session) return;
            if (!url) continue;
            playingIndex = i;
            render();
            highlightLine(messageId, lines[i].src.orig ?? lines[i].src.text);
            await playUrl(url, mySession);
        }
    } catch (e) {
        failed = true;
        console.error(LOG, e);
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
        if (mySession === session) setStatus(messageId, '<i class="fa-solid fa-triangle-exclamation"></i> 실패', 'error');
    } finally {
        if (mySession === session) {
            clearHighlight();
            if (messageId !== null) {
                setButtonState(messageId, false);
                if (!failed) setStatus(messageId, '<i class="fa-solid fa-check"></i> 끝', 'done');
            }
            playingMessageId = null;
            currentAudio = null;
        }
    }
}

// ---------------------------------------------------------------------------
// ▶ next to each line in the chat (only lines that already have audio → never costs credits)
// ---------------------------------------------------------------------------

const LINE_BTN = 'vc_line_play';
let linePlay = null; // { messageId, index }

function setLinePlaying(target) {
    $(`.${LINE_BTN}.vc_line_playing`).removeClass('vc_line_playing fa-circle-stop').addClass('fa-circle-play');
    linePlay = target;
    if (!target) return;
    $(`#chat .mes[mesid="${target.messageId}"] .${LINE_BTN}[data-line="${target.index}"]`)
        .addClass('vc_line_playing fa-circle-stop').removeClass('fa-circle-play');
}

function removeLineButtons(root) {
    if (!root) return;
    root.querySelectorAll(`.${LINE_BTN}`).forEach(el => el.remove());
    root.normalize();
}

function decorateMessage(messageId) {
    if (!getSettings().lineButtons) return;
    const root = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!root || root.querySelector(`.${LINE_BTN}`)) return;
    const message = SillyTavern.getContext().chat?.[messageId];
    if (!message || message.is_user || message.is_system) return;
    const script = getStoredEntry(message)?.script;
    if (!Array.isArray(script) || !script.some(l => l?.audioKey)) return;
    script.forEach((line, index) => {
        if (!line?.audioKey) return;
        let ranges = [];
        try { ranges = findLineRanges(root, messageId, line.orig ?? line.text); } catch { /* ignore */ }
        for (const range of ranges) {
            const btn = document.createElement('span');
            btn.className = `${LINE_BTN} fa-solid fa-circle-play`;
            btn.dataset.line = String(index);
            btn.title = `${line.speaker || ''} 대사 듣기`.trim();
            btn.setAttribute('role', 'button');
            const at = range.cloneRange();
            at.collapse(true);
            at.insertNode(btn);
        }
    });
    if (linePlay?.messageId === Number(messageId)) setLinePlaying(linePlay);
}

function redecorateMessage(messageId) {
    removeLineButtons(document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`));
    decorateMessage(messageId);
}

function refreshLineButtons({ rebuild = false } = {}) {
    document.querySelectorAll('#chat .mes').forEach((mes) => {
        const root = mes.querySelector('.mes_text');
        if (rebuild || !getSettings().lineButtons) removeLineButtons(root);
        decorateMessage(Number(mes.getAttribute('mesid')));
    });
}

let lineObserverTimer = null;
function watchChatForLineButtons() {
    const chat = document.getElementById('chat');
    if (!chat || typeof MutationObserver === 'undefined') return;
    new MutationObserver(() => {
        if (!getSettings().lineButtons) return;
        clearTimeout(lineObserverTimer);
        lineObserverTimer = setTimeout(() => refreshLineButtons(), 300);
    }).observe(chat, { childList: true, subtree: true });
}

async function playScriptLine(messageId, index) {
    if (linePlay && linePlay.messageId === messageId && linePlay.index === index) {
        stopPlayback();
        return;
    }
    stopPlayback();
    const mySession = session;
    const line = getStoredEntry(SillyTavern.getContext().chat[messageId])?.script?.[index];
    if (!line?.audioKey) return;
    const url = await getCachedAudio(line.audioKey);
    if (mySession !== session) return;
    if (!url) {
        toastr.info('이 기기에는 이 대사 음성이 없어요. 🔊로 메시지를 재생하면 다시 만들어져요.', 'MultiCast TTS');
        return;
    }
    setLinePlaying({ messageId, index });
    highlightLine(messageId, line.orig ?? line.text);
    await playUrl(url, mySession);
    if (mySession === session) {
        clearHighlight();
        setLinePlaying(null);
        currentAudio = null;
    }
}

// ---------------------------------------------------------------------------
// Saved line audio of this chat, as a list
// ---------------------------------------------------------------------------

let clipPlayKey = null;

function setClipPlaying(key) {
    $('.vc_clip_play.vc_line_playing').removeClass('vc_line_playing fa-stop').addClass('fa-play');
    clipPlayKey = key;
    if (key) $(`.vc_clip_play[data-key="${key}"]`).addClass('vc_line_playing fa-stop').removeClass('fa-play');
}

function variantLabel(key) {
    if (key === 'display') return '화면';
    if (key === 'original') return '원문';
    if (String(key).startsWith('tr:')) return `번역·${String(key).slice(3)}`;
    return String(key);
}

function collectSavedLines() {
    const chat = SillyTavern.getContext().chat ?? [];
    const out = [];
    for (let mesId = chat.length - 1; mesId >= 0; mesId--) {
        const root = chat[mesId]?.extra?.[MODULE_NAME];
        if (!root) continue;
        const variants = root.variants ?? (Array.isArray(root.script) ? { display: root } : {});
        for (const [vKey, entry] of Object.entries(variants)) {
            (entry?.script ?? []).forEach((line) => {
                if (line?.audioKey) out.push({ mesId, vKey, line });
            });
        }
    }
    return out;
}

async function playClip(key) {
    if (clipPlayKey === key) {
        stopPlayback();
        return;
    }
    stopPlayback();
    const mySession = session;
    const url = await getCachedAudio(key);
    if (mySession !== session) return;
    if (!url) {
        toastr.info('이 기기에는 저장된 음성이 없어요.', 'MultiCast TTS');
        return;
    }
    setClipPlaying(key);
    await playUrl(url, mySession);
    if (mySession === session) {
        setClipPlaying(null);
        currentAudio = null;
    }
}

async function downloadClip(item) {
    try {
        const blob = await getStore()?.getItem(item.line.audioKey);
        if (!blob) {
            toastr.info('이 기기에는 저장된 음성이 없어요.', 'MultiCast TTS');
            return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFileName(item.line.speaker)}_${item.mesId}_${safeFileName(item.line.text).slice(0, 20)}.mp3`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
    }
}

/** Delete one line's audio from this device and unpin it everywhere in this chat (next play makes it again). */
async function deleteClip(key) {
    const ctx = SillyTavern.getContext();
    if (clipPlayKey === key) stopPlayback();
    try { await getStore()?.removeItem(key); } catch { /* ignore */ }
    const index = await loadIndex();
    delete index[key];
    saveIndexSoon();
    if (memoryUrls.has(key)) {
        URL.revokeObjectURL(memoryUrls.get(key));
        memoryUrls.delete(key);
    }
    const touched = new Set();
    (ctx.chat ?? []).forEach((message, mesId) => {
        const root = message?.extra?.[MODULE_NAME];
        if (!root) return;
        const variants = root.variants ?? (Array.isArray(root.script) ? { display: root } : {});
        for (const entry of Object.values(variants)) {
            for (const line of entry?.script ?? []) {
                if (line?.audioKey === key) {
                    delete line.audioKey;
                    touched.add(mesId);
                }
            }
        }
    });
    if (touched.size) await ctx.saveChat();
    touched.forEach(id => redecorateMessage(id));
}

async function openSavedList() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat?.length) {
        toastr.info('열린 채팅이 없어요.', 'MultiCast TTS');
        return;
    }
    const items = collectSavedLines();
    const index = await loadIndex();
    const speakers = [...new Set(items.map(i => i.line.speaker || '?'))].sort();

    const $box = $(`
        <div class="vc_saved">
            <div class="vc_saved_head">
                <b>이 채팅에서 만든 대사 음성</b> <span class="vc_hint">${items.length}개</span>
            </div>
            <div class="vc_saved_filters">
                <select class="text_pole vc_saved_speaker"><option value="">모든 캐릭터</option>${speakers.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</select>
                <input class="text_pole vc_saved_search" type="search" placeholder="대사 검색" />
            </div>
            <div class="vc_saved_list"></div>
        </div>`);
    const $list = $box.find('.vc_saved_list');

    const render = () => {
        const who = String($box.find('.vc_saved_speaker').val() ?? '');
        const q = String($box.find('.vc_saved_search').val() ?? '').trim().toLowerCase();
        const shown = items.filter(i => (!who || (i.line.speaker || '?') === who)
            && (!q || `${i.line.text} ${i.line.orig ?? ''}`.toLowerCase().includes(q)));
        if (!shown.length) {
            $list.html('<div class="vc_empty">저장된 대사 음성이 없어요. 메시지를 🔊로 한 번 재생하면 여기에 쌓여요.</div>');
            return;
        }
        $list.empty();
        let lastGroup = '';
        for (const item of shown) {
            const group = `${item.mesId}|${item.vKey}`;
            if (group !== lastGroup) {
                lastGroup = group;
                const name = ctx.chat[item.mesId]?.name ?? '';
                $list.append(`<div class="vc_saved_group" data-mes="${item.mesId}">#${item.mesId} ${escapeHtml(name)} <span class="vc_hint">· ${escapeHtml(variantLabel(item.vKey))}</span></div>`);
            }
            const missing = !index[item.line.audioKey];
            const $row = $(`
                <div class="vc_saved_row${missing ? ' vc_missing' : ''}">
                    <div class="vc_icon_btn vc_clip_play fa-solid fa-play" data-key="${escapeHtml(item.line.audioKey)}" title="듣기"></div>
                    <div class="vc_saved_text"><b>${escapeHtml(item.line.speaker || '?')}</b> ${escapeHtml(item.line.text)}${missing ? ' <span class="vc_hint">(이 기기에 없음)</span>' : ''}</div>
                    <div class="vc_icon_btn vc_clip_dl fa-solid fa-download" title="mp3로 받기"></div>
                    <div class="vc_icon_btn vc_clip_del fa-solid fa-trash-can" title="이 음성 지우기"></div>
                </div>`);
            $row.find('.vc_clip_play').on('click', () => playClip(item.line.audioKey));
            $row.find('.vc_clip_dl').on('click', () => downloadClip(item));
            $row.find('.vc_clip_del').on('click', async () => {
                const ok = await ctx.Popup.show.confirm('MultiCast TTS', '이 대사 음성을 지울까요? 다음에 메시지를 재생하면 새로 만들어져요(크레딧 사용).');
                if (!ok) return;
                const key = item.line.audioKey;
                await deleteClip(key);
                for (let i = items.length - 1; i >= 0; i--) {
                    if (!items[i].line.audioKey || items[i].line.audioKey === key) items.splice(i, 1);
                }
                $box.find('.vc_saved_head .vc_hint').text(`${items.length}개`);
                render();
                toastr.success('지웠어요.', 'MultiCast TTS', { timeOut: 1200 });
            });
            $list.append($row);
        }
        if (clipPlayKey) setClipPlaying(clipPlayKey);
    };
    $box.find('.vc_saved_speaker').on('change', render);
    $box.find('.vc_saved_search').on('input', render);
    $list.on('click', '.vc_saved_group', function () {
        const el = document.querySelector(`#chat .mes[mesid="${$(this).data('mes')}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else toastr.info('채팅을 위로 스크롤해서 그 메시지를 불러와 주세요.', 'MultiCast TTS');
    });
    render();

    const popup = new ctx.Popup($box, ctx.POPUP_TYPE.TEXT, '', {
        okButton: '닫기',
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    popup.dlg?.classList.add('vc_editor_popup');
    await popup.show();
    if (clipPlayKey) stopPlayback();
}

// ---------------------------------------------------------------------------
// Save a whole message as one mp3
// ---------------------------------------------------------------------------

function safeFileName(str) {
    return String(str ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'voice';
}

async function downloadMessageAudio(messageId, scriptOverride = null) {
    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message) return;
    try {
        const script = scriptOverride ?? await getScript(messageId);
        const lines = buildPlayableLines(script, { keepThoughts: !!scriptOverride });
        if (!lines.length) {
            toastr.info('저장할 대사가 없어요.', 'MultiCast TTS');
            return;
        }
        const total = lines.length;
        toastr.info(`음성 ${total}줄을 준비하고 있어요…`, 'MultiCast TTS', { timeOut: 2000 });
        const { promises, done } = synthesizeAll(
            lines.map(l => ({ text: l.ttsText, voiceId: l.voiceId, src: l.src })),
            session,
        );
        if (!scriptOverride) savePinsWhenDone(done, messageId);
        const urls = await Promise.all(promises);
        const parts = [];
        for (const url of urls) {
            if (!url) continue;
            parts.push(await (await fetch(url)).arrayBuffer());
        }
        if (!parts.length) {
            toastr.error('음성을 만들지 못했어요.', 'MultiCast TTS');
            return;
        }
        // ElevenLabs returns MP3 frames with identical settings, so plain concatenation plays back fine
        const blob = new Blob(parts, { type: 'audio/mpeg' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFileName(message.name)}_${messageId}.mp3`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        toastr.success(`mp3로 저장했어요 (${parts.length}/${total}줄).`, 'MultiCast TTS');
    } catch (e) {
        console.error(LOG, e);
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
    }
}

// ---------------------------------------------------------------------------
// Message buttons
// ---------------------------------------------------------------------------

const BUTTON_HTML = '<div class="mes_button vc_play_btn fa-solid fa-volume-high" title="MultiCast TTS 재생 (Shift+클릭: 다시 분류)"></div>'
    + '<div class="mes_button vc_edit_btn fa-solid fa-scroll" title="MultiCast TTS 대본 편집"></div>';

const QUICK_HTML = `<div class="vc_quick_btns">${BUTTON_HTML}</div>`;

/** "Buttons on the message" option: CSS swaps which copy is visible (… menu or the message itself). */
function applyQuickButtons() {
    document.body.classList.toggle('vc_quick_on', !!getSettings().quickButtons);
}

function injectButtons() {
    // Template: every newly rendered message gets the buttons automatically
    const $tpl = $('#message_template .extraMesButtons');
    if ($tpl.length && !$tpl.find('.vc_play_btn').length) {
        $tpl.prepend(BUTTON_HTML);
    }
    const $tplHint = $('#message_template .mes_buttons .extraMesButtonsHint');
    if ($tplHint.length && !$('#message_template .vc_quick_btns').length) {
        $tplHint.before(QUICK_HTML);
    }
    // Already-rendered messages
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.vc_play_btn').length) $(this).prepend(BUTTON_HTML);
    });
    $('#chat .mes .mes_buttons').each(function () {
        if ($(this).find('.vc_quick_btns').length) return;
        const $hint = $(this).find('.extraMesButtonsHint');
        if ($hint.length) $hint.before(QUICK_HTML);
    });
}

function onEditButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const messageId = Number($(this).closest('.mes').attr('mesid'));
    if (Number.isNaN(messageId)) return;
    openScriptEditor(messageId);
}

function onButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const messageId = Number($(this).closest('.mes').attr('mesid'));
    if (Number.isNaN(messageId)) return;

    if (playingMessageId === messageId && !e.shiftKey) {
        stopPlayback();
        return;
    }
    if (e.shiftKey) {
        reclassifyAndPlay(messageId);
        return;
    }
    playMessage(messageId);
}

async function reclassifyAndPlay(messageId) {
    const ctx = SillyTavern.getContext();
    const cached = getStoredEntry(ctx.chat[messageId]);
    if (cached?.edited) {
        const ok = await ctx.Popup.show.confirm('MultiCast TTS', '직접 고친 대본이 있어요. 다시 분류하면 수정한 내용이 사라져요. 계속할까요?');
        if (!ok) return;
    }
    playMessage(messageId, { force: true });
}

// ---------------------------------------------------------------------------
// Auto play
// ---------------------------------------------------------------------------

async function onCharacterMessageRendered(messageId, type) {
    const s = getSettings();
    if (!s.enabled || (!s.autoPlay && !s.pregenerate)) return;
    if (type === 'first_message') return;

    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    const waitSec = Number(s.translationWaitSec) || 0;
    if (s.voiceLang === 'display' && waitSec > 0) {
        const until = Date.now() + waitSec * 1000;
        while (Date.now() < until && !getShownTranslation(ctx.chat[messageId])) {
            await new Promise(r => setTimeout(r, 300));
        }
    }
    // the chat might have changed while waiting
    if (SillyTavern.getContext().chat[messageId] !== message) return;
    if (s.autoPlay) playMessage(messageId);
    else preloadMessage(messageId);
}

/** Classify + generate a message's audio in the background without playing it. */
async function preloadMessage(messageId) {
    const chatAtStart = SillyTavern.getContext().chat;
    const isActive = () => SillyTavern.getContext().chat === chatAtStart && getSettings().pregenerate;
    const show = (html, state) => { if (playingMessageId !== messageId) setStatus(messageId, html, state); };
    try {
        show('<i class="fa-solid fa-spinner fa-spin"></i> 미리 분류 중…');
        const script = await getScript(messageId);
        if (!isActive()) return show(null);
        const lines = buildPlayableLines(script);
        if (!lines.length) return show(null);
        const total = lines.length;
        show(`<i class="fa-solid fa-spinner fa-spin"></i> 미리 만드는 중 0/${total}`);
        const { done } = synthesizeAll(
            lines.map(l => ({ text: l.ttsText, voiceId: l.voiceId, src: l.src })),
            isActive,
            (n) => show(`<i class="fa-solid fa-spinner fa-spin"></i> 미리 만드는 중 ${n}/${total}`),
        );
        savePinsWhenDone(done, messageId);
        await done;
        if (isActive()) show('<i class="fa-solid fa-check"></i> 준비됨', 'done');
        else show(null);
    } catch (e) {
        console.error(LOG, 'preload failed', e);
        show('<i class="fa-solid fa-triangle-exclamation"></i> 미리 만들기 실패', 'error');
    }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

let voiceList = [];

function voiceOptionsHtml(selected) {
    const opts = ['<option value="">(없음)</option>'];
    for (const v of voiceList) {
        const g = (v.gender ? ` · ${v.gender}` : '') + (v.category ? ` · ${v.category}` : '');
        opts.push(`<option value="${v.id}"${v.id === selected ? ' selected' : ''}>${escapeHtml(v.name)}${g}</option>`);
    }
    if (selected && !voiceList.some(v => v.id === selected)) {
        opts.push(`<option value="${selected}" selected>(저장된 ID: ${selected.slice(0, 8)}…)</option>`);
    }
    return opts.join('');
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function renderVoiceSelects() {
    const s = getSettings();
    $('#voice_cast_male_voice').html(voiceOptionsHtml(s.maleVoiceId));
    $('#voice_cast_female_voice').html(voiceOptionsHtml(s.femaleVoiceId));
    $('#voice_cast_unknown_voice').html(voiceOptionsHtml(s.unknownVoiceId));
    renderCastList();
}

const openAdv = new Set(); // which cast rows have their acting panel open ("scope:index")

function castArray(scope) {
    return scope === 'bot' ? getBotCast(true) : getSettings().cast;
}

function renderCastList() {
    const s = getSettings();
    const bot = currentBot();

    const renderInto = ($list, list, scope) => {
        $list.empty();
        if (!list?.length) {
            $list.append('<div class="vc_hint">(비어 있어요)</div>');
            return;
        }
        list.forEach((entry, i) => {
            const moveTitle = scope === 'bot' ? '공통 캐스트로 옮기기 (모든 봇에 적용)' : '이 봇 캐스트로 옮기기';
            const hasCustom = (entry.stability ?? null) !== null || (entry.similarity ?? null) !== null;
            const $row = $(`
                <div class="vc_cast_row" data-index="${i}" data-scope="${scope}">
                    <input type="text" class="text_pole vc_cast_names" placeholder="이름, 별명 (쉼표로 구분)" />
                    <select class="text_pole vc_cast_gender">
                        <option value="u">?</option>
                        <option value="m">남</option>
                        <option value="f">여</option>
                    </select>
                    <select class="text_pole vc_cast_voice">${voiceOptionsHtml(entry.voiceId)}</select>
                    <div class="vc_cast_btns">
                        <div class="vc_cast_adv_toggle fa-solid fa-sliders ${hasCustom ? 'vc_custom' : ''}" title="이 캐릭터만 연기 설정 따로 (Stability / Similarity)"></div>
                        ${scope === 'global' && !bot ? '' : `<div class="vc_cast_move fa-solid ${scope === 'bot' ? 'fa-globe' : 'fa-user-tag'}" title="${moveTitle}"></div>`}
                        <div class="vc_cast_delete fa-solid fa-trash-can" title="삭제"></div>
                    </div>
                    <div class="vc_cast_adv" style="display:none">
                        <label>Stability: <span class="vc_cast_stab_val"></span></label>
                        <input type="range" class="vc_cast_stab" min="0" max="1" step="0.05" />
                        <label>Similarity: <span class="vc_cast_sim_val"></span></label>
                        <input type="range" class="vc_cast_sim" min="0" max="1" step="0.05" />
                        <div class="vc_row">
                            <span class="vc_hint">낮은 Stability = 감정 폭이 크고 들쭉날쭉 · 높으면 차분하고 일정해요.</span>
                            <div class="menu_button menu_button_icon vc_cast_adv_reset"><i class="fa-solid fa-rotate-left"></i><span>공통 설정 따르기</span></div>
                        </div>
                    </div>
                </div>`);
            const g = getSettings();
            const stab = entry.stability ?? null;
            const sim = entry.similarity ?? null;
            $row.find('.vc_cast_stab').val(stab ?? g.stability);
            $row.find('.vc_cast_sim').val(sim ?? g.similarity);
            $row.find('.vc_cast_stab_val').text(stab === null ? `공통 (${Math.round(g.stability * 100)}%)` : `${Math.round(stab * 100)}%`);
            $row.find('.vc_cast_sim_val').text(sim === null ? `공통 (${Math.round(g.similarity * 100)}%)` : `${Math.round(sim * 100)}%`);
            if (openAdv.has(`${scope}:${i}`)) $row.find('.vc_cast_adv').show();
            $row.find('.vc_cast_names').val(entry.names ?? '');
            $row.find('.vc_cast_gender').val(entry.gender ?? 'u');
            $list.append($row);
        });
    };

    if (bot) {
        $('#voice_cast_bot_cast_title').text(`🎭 이 봇 캐스트 — ${bot.name}`);
        $('#voice_cast_bot_cast_block').show();
        $('#voice_cast_no_bot').hide();
        renderInto($('#voice_cast_bot_cast_list'), getBotCast(true), 'bot');
    } else {
        $('#voice_cast_bot_cast_block').hide();
        $('#voice_cast_no_bot').show();
    }
    renderInto($('#voice_cast_cast_list'), s.cast, 'global');
}

async function loadVoices(showToast = false) {
    try {
        voiceList = await fetchVoices();
        voiceList.sort((a, b) => a.name.localeCompare(b.name));
        $('#voice_cast_key').addClass('success');
        renderVoiceSelects();
        if (showToast) toastr.success(`목소리 ${voiceList.length}개를 불러왔어요.`, 'MultiCast TTS');
    } catch (e) {
        console.warn(LOG, 'voice list failed', e);
        $('#voice_cast_key').removeClass('success');
        renderVoiceSelects();
        if (showToast) {
            const st = e?.status;
            const why = st === 400 ? '실리태번에 ElevenLabs 키가 저장돼 있지 않아요. 🔑 버튼으로 키를 다시 넣어주세요.'
                : st === 404 ? '이 실리태번 버전에는 필요한 기능이 없어요. 실리태번을 최신 버전으로 업데이트해 주세요.'
                : st === 500 ? '일레븐랩스가 요청을 거절했거나 연결이 안 됐어요. 키가 맞는지(권한: Voices 읽기 포함), 인터넷 연결을 확인하고 실리태번 서버 화면(콘솔)의 ElevenLabs 메시지를 봐주세요.'
                : '실리태번 서버와 연결이 안 됐어요.';
            toastr.error(`목소리 목록을 못 불러왔어요 (${st ? `HTTP ${st}` : '연결 오류'}). ${why}`, 'MultiCast TTS', { timeOut: 12000 });
        }
    }
}

async function showLastScript() {
    const ctx = SillyTavern.getContext();
    let id = ctx.chat.length - 1;
    while (id >= 0 && !getStoredEntry(ctx.chat[id])) id--;
    if (id < 0) {
        toastr.info('아직 분류된 메시지가 없어요. 메시지의 📜 버튼으로 바로 편집할 수도 있어요.', 'MultiCast TTS');
        return;
    }
    openScriptEditor(id);
}

// ---------------------------------------------------------------------------
// Script editor
// ---------------------------------------------------------------------------

function voiceName(id) {
    return voiceList.find(v => v.id === id)?.name ?? (id ? `${id.slice(0, 8)}…` : '없음');
}

function editorRowHtml() {
    return `
    <div class="vc_edit_row">
        <div class="vc_edit_head">
            <select class="text_pole vc_e_type" title="종류">
                <option value="speech">💬 대사</option>
                <option value="thought">💭 속마음</option>
            </select>
            <input type="text" class="text_pole vc_e_speaker" placeholder="화자" title="화자 이름 (캐스트 표와 매칭돼요)" />
            <select class="text_pole vc_e_gender" title="성별">
                <option value="u">?</option>
                <option value="m">남</option>
                <option value="f">여</option>
            </select>
            <select class="text_pole vc_e_voice" title="목소리 (자동 = 캐스트 표/성별로 결정)"></select>
            <input type="text" class="text_pole vc_e_tag" placeholder="태그 (예: angry)" title="감정/연기 태그. 비우면 태그 없이 읽어요" />
            <div class="vc_e_btns">
                <div class="vc_icon_btn vc_e_play fa-solid fa-play" title="이 줄만 듣기 (저장된 음성이 있으면 그걸 재생)"></div>
                <div class="vc_icon_btn vc_e_regen fa-solid fa-dice" title="이 줄 음성 새로 뽑기 (크레딧 사용)"></div>
                <div class="vc_icon_btn vc_e_up fa-solid fa-arrow-up" title="위로"></div>
                <div class="vc_icon_btn vc_e_down fa-solid fa-arrow-down" title="아래로"></div>
                <div class="vc_icon_btn vc_e_del fa-solid fa-trash-can" title="삭제"></div>
            </div>
        </div>
        <textarea class="text_pole vc_e_text" rows="2" placeholder="대사"></textarea>
    </div>`;
}

function makeEditorRow(line) {
    const $row = $(editorRowHtml());
    $row.find('.vc_e_type').val(line.type === 'thought' ? 'thought' : 'speech');
    $row.find('.vc_e_speaker').val(line.speaker ?? '');
    $row.find('.vc_e_gender').val(['m', 'f'].includes(line.gender) ? line.gender : 'u');
    $row.find('.vc_e_tag').val(line.tag ?? '');
    $row.find('.vc_e_text').val(line.text ?? '');
    if (line.orig) {
        $row.data('orig', line.orig);
        $row.find('.vc_e_text').attr('title', `원문: ${line.orig}`);
    }
    refreshRowVoiceSelect($row, line.voiceId ?? '');
    // remember which audio take belongs to this line, and what the line looked like when it was made
    if (line.audioKey) {
        $row.data('audioKey', line.audioKey);
        $row.data('sig', lineSignature(readEditorRow($row)));
    }
    return $row;
}

function lineSignature(line) {
    return JSON.stringify([line.speaker, line.gender, line.type, line.tag, line.text, line.voiceId ?? '']);
}

/** Rebuilds the voice dropdown so the "auto" option shows which voice would be used right now. */
function refreshRowVoiceSelect($row, selected) {
    const line = readEditorRow($row, { ignoreVoice: true });
    const auto = voiceName(pickVoice(line));
    const html = `<option value="">(자동: ${escapeHtml(auto)})</option>` + voiceOptionsHtml(selected).replace('<option value="">(없음)</option>', '');
    const $sel = $row.find('.vc_e_voice').html(html);
    $sel.val(selected ?? '');
}

function readEditorRow($row, { ignoreVoice = false } = {}) {
    const line = {
        speaker: String($row.find('.vc_e_speaker').val() ?? '').trim() || 'unknown',
        gender: String($row.find('.vc_e_gender').val() ?? 'u'),
        type: $row.find('.vc_e_type').val() === 'thought' ? 'thought' : 'speech',
        tag: String($row.find('.vc_e_tag').val() ?? '').replace(/[[\]]/g, '').trim(),
        text: String($row.find('.vc_e_text').val() ?? '').trim(),
    };
    if ($row.data('orig')) line.orig = $row.data('orig');
    const voiceId = ignoreVoice ? '' : String($row.find('.vc_e_voice').val() ?? '');
    if (voiceId) line.voiceId = voiceId;
    if (!ignoreVoice) {
        // keep the saved take only while the line is unchanged
        const audioKey = $row.data('audioKey');
        if (audioKey && $row.data('sig') === lineSignature(line)) line.audioKey = audioKey;
    }
    return line;
}

function readEditor($editor) {
    return $editor.find('.vc_edit_row').toArray()
        .map(el => readEditorRow($(el)))
        .filter(l => l.text);
}

function buildEditor(messageId, script) {
    const s = getSettings();
    const tagsOn = s.useTags && modelInfo(s.model).tags;
    const $editor = $(`
        <div class="vc_editor">
            <h3>📜 메시지 #${messageId} 대본</h3>
            <div class="vc_hint">
                화자·성별·목소리·태그·대사를 고칠 수 있어요. 고친 줄만 새로 생성되고, 안 고친 줄은 저장된 음성을 다시 써요.
                ${tagsOn ? '' : '<br>⚠️ 지금 모델/설정에서는 태그가 꺼져 있어서 태그 없이 읽어요.'}
            </div>
            <div class="vc_edit_lines"></div>
            <div class="menu_button menu_button_icon vc_add_line"><i class="fa-solid fa-plus"></i><span>줄 추가</span></div>
        </div>`);
    const $lines = $editor.find('.vc_edit_lines');
    for (const line of script) $lines.append(makeEditorRow(line));
    if (!script.length) $lines.append('<div class="vc_empty">(분류된 대사가 없어요. 직접 추가할 수 있어요)</div>');

    $editor.on('click', '.vc_add_line', () => {
        $lines.find('.vc_empty').remove();
        $lines.append(makeEditorRow({ speaker: '', gender: 'u', type: 'speech', tag: '', text: '' }));
    });
    $editor.on('click', '.vc_e_del', function () {
        $(this).closest('.vc_edit_row').remove();
    });
    $editor.on('click', '.vc_e_up', function () {
        const $row = $(this).closest('.vc_edit_row');
        $row.prev('.vc_edit_row').before($row);
    });
    $editor.on('click', '.vc_e_down', function () {
        const $row = $(this).closest('.vc_edit_row');
        $row.next('.vc_edit_row').after($row);
    });
    const previewRow = async ($row, fresh) => {
        const line = readEditorRow($row);
        if (!line.text) return;
        if (fresh) line._fresh = true;
        await playMessage(null, { script: [line] });
        // the take that just played becomes this line's audio (saved when the script is saved)
        if (line.audioKey) {
            $row.data('audioKey', line.audioKey);
            $row.data('sig', lineSignature(readEditorRow($row, { ignoreVoice: false })));
        }
    };
    $editor.on('click', '.vc_e_play', function () {
        previewRow($(this).closest('.vc_edit_row'), false);
    });
    $editor.on('click', '.vc_e_regen', function () {
        previewRow($(this).closest('.vc_edit_row'), true);
    });
    // keep the "auto" voice label in sync when speaker/gender change
    $editor.on('change', '.vc_e_speaker, .vc_e_gender', function () {
        const $row = $(this).closest('.vc_edit_row');
        refreshRowVoiceSelect($row, String($row.find('.vc_e_voice').val() ?? ''));
    });
    return $editor;
}

const EDITOR_SAVE_ONLY = 1001;  // POPUP_RESULT.CUSTOM1
const EDITOR_RECLASSIFY = 1002; // POPUP_RESULT.CUSTOM2

async function openScriptEditor(messageId) {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat[messageId]) return;
    if (!voiceList.length) await loadVoices(false);

    let script;
    try {
        if (!getStoredEntry(ctx.chat[messageId])) toastr.info('대사 분류 중...', 'MultiCast TTS', { timeOut: 1500 });
        script = await getScript(messageId);
    } catch (e) {
        console.error(LOG, e);
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
        script = [];
    }

    // loop so "re-classify" can reopen the editor with fresh results
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const $editor = buildEditor(messageId, script);
        const popup = new ctx.Popup($editor, ctx.POPUP_TYPE.TEXT, '', {
            okButton: '저장하고 재생',
            cancelButton: '닫기',
            wide: true,
            allowVerticalScrolling: true,
            leftAlign: true,
            customButtons: [
                {
                    text: 'mp3로 받기',
                    icon: 'fa-download',
                    action: () => {
                        const current = readEditor($editor);
                        const isChanged = JSON.stringify(current) !== JSON.stringify(script);
                        downloadMessageAudio(messageId, isChanged ? current : null);
                    },
                },
                { text: '저장만', result: EDITOR_SAVE_ONLY, icon: 'fa-floppy-disk' },
                { text: 'AI로 다시 분류', result: EDITOR_RECLASSIFY, icon: 'fa-rotate' },
            ],
        });
        popup.dlg?.classList.add('vc_editor_popup');
        const result = await popup.show();
        const edited = readEditor($editor);
        const changed = JSON.stringify(edited) !== JSON.stringify(script);

        if (result === EDITOR_RECLASSIFY) {
            const wasEdited = getStoredEntry(ctx.chat[messageId])?.edited || changed;
            if (wasEdited) {
                const ok = await ctx.Popup.show.confirm('MultiCast TTS', '다시 분류하면 직접 고친 내용이 사라져요. 계속할까요?');
                if (!ok) continue;
            }
            try {
                toastr.info('대사 다시 분류 중...', 'MultiCast TTS', { timeOut: 1500 });
                script = await getScript(messageId, { force: true });
            } catch (e) {
                toastr.error(String(e.message ?? e), 'MultiCast TTS');
            }
            continue;
        }

        if (result === ctx.POPUP_RESULT.AFFIRMATIVE || result === EDITOR_SAVE_ONLY) {
            if (changed) {
                await saveEditedScript(messageId, edited);
                redecorateMessage(messageId);
                toastr.success('대본을 저장했어요.', 'MultiCast TTS', { timeOut: 1500 });
            }
            if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
                // unchanged → play the stored script itself so new takes get pinned to it
                playMessage(messageId, changed ? { script: edited } : {});
            }
        }
        return;
    }
}

// ---------------------------------------------------------------------------
// Settings export / import
// ---------------------------------------------------------------------------

function exportSettings() {
    const data = {
        app: 'voice_cast',
        format: 1,
        exportedAt: new Date().toISOString(),
        settings: structuredClone(getSettings()),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `voice-cast-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toastr.success('설정을 파일로 저장했어요.', 'MultiCast TTS');
}

async function importSettings(file) {
    const ctx = SillyTavern.getContext();
    let data;
    try {
        data = JSON.parse(await file.text());
    } catch {
        toastr.error('설정 파일을 읽지 못했어요.', 'MultiCast TTS');
        return;
    }
    const incoming = data?.app === 'voice_cast' ? data.settings : null;
    if (!incoming || typeof incoming !== 'object') {
        toastr.error('MultiCast TTS 설정 파일이 아니에요.', 'MultiCast TTS');
        return;
    }
    const ok = await ctx.Popup.show.confirm('MultiCast TTS', '지금 설정을 이 파일의 설정으로 바꿀까요? (저장된 음성과 대본은 그대로예요)');
    if (!ok) return;

    const s = getSettings();
    for (const key of Object.keys(defaultSettings)) {
        if (Object.hasOwn(incoming, key)) s[key] = structuredClone(incoming[key]);
    }
    // connection profiles are per-install: keep the imported one only if it exists here
    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
    if (s.profileId && !profiles.some(pr => pr.id === s.profileId)) s.profileId = '';
    getSettings(); // re-validate shapes
    save();
    renderVoiceSelects();
    toastr.success('설정을 가져왔어요. 새로고침하면 모든 칸에 반영돼요.', 'MultiCast TTS');
}

// ---------------------------------------------------------------------------
// Voice language quick switch (wand menu + slash command)
// ---------------------------------------------------------------------------

function setVoiceLang(mode) {
    const s = getSettings();
    s.voiceLang = mode;
    save();
    $('#voice_cast_voice_lang').val(mode);
    $('#voice_cast_translate_block').toggle(mode === 'translate');
    updateWandItem();
    refreshLineButtons({ rebuild: true });
    toastr.info(`음성 언어: ${voiceLangLabel()}`, 'MultiCast TTS', { timeOut: 1500 });
}

function cycleVoiceLang() {
    const order = ['display', 'original', 'translate'];
    const cur = order.indexOf(getSettings().voiceLang);
    setVoiceLang(order[(cur + 1) % order.length]);
}

function updateWandItem() {
    $('#voice_cast_wand_label').text(`MultiCast TTS: ${voiceLangLabel()}`);
}

function addWandItem() {
    if ($('#voice_cast_wand').length) return;
    const $menu = $('#extensionsMenu');
    if (!$menu.length) return;
    const $item = $(`
        <div id="voice_cast_wand" class="list-group-item flex-container flexGap5" title="눌러서 음성 언어 바꾸기 (화면대로 → 원문 → AI 번역)">
            <div class="extensionsMenuExtensionButton fa-solid fa-language"></div>
            <span id="voice_cast_wand_label"></span>
        </div>`);
    $item.on('click', cycleVoiceLang);
    $menu.append($item);
    const $list = $(`
        <div id="voice_cast_wand_list" class="list-group-item flex-container flexGap5" title="이 채팅에서 만든 대사 음성 모아보기">
            <div class="extensionsMenuExtensionButton fa-solid fa-list"></div>
            <span>MultiCast TTS: 저장된 대사 음성</span>
        </div>`);
    $list.on('click', openSavedList);
    $menu.append($list);
    updateWandItem();
}

function settingsHtml() {
    const modelOptions = MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('')
        + '<option value="__custom__">✏️ 직접 입력 (새 모델 ID)</option>';
    return `
    <div id="voice_cast_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>MultiCast TTS</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="voice_cast_enabled" type="checkbox" /><span>사용</span></label>
                <label class="checkbox_label"><input id="voice_cast_auto" type="checkbox" /><span>새 답변 자동 재생</span></label>
                <label class="checkbox_label" title="메시지 … 메뉴를 열지 않아도 🔊(재생)과 📜(대본) 버튼이 메시지에 바로 보여요."><input id="voice_cast_quick" type="checkbox" /><span>🔊 📜 버튼 메시지에 바로 보이기</span></label>
                <label class="checkbox_label" title="이미 만든 음성이 있는 대사 앞에 작은 ▶가 생겨요. 누르면 그 대사만 다시 들어요 (크레딧 안 씀)."><input id="voice_cast_line_btns" type="checkbox" /><span>대사 옆에 ▶ 버튼 보이기 (만든 음성만)</span></label>
                <label class="checkbox_label" title="새 답변이 오면 분류와 음성 생성을 미리 해둬요. 🔊를 누르면 바로 나와요. 안 들을 메시지에도 크레딧이 쓰여요. (자동 재생이 켜져 있으면 그쪽이 우선)"><input id="voice_cast_pregen" type="checkbox" /><span>새 답변 음성 미리 만들어두기 (재생은 안 함 · 크레딧 사용)</span></label>
                <label class="checkbox_label"><input id="voice_cast_thoughts" type="checkbox" /><span>속마음(*별표*)도 읽기</span></label>
                <div class="vc_row">
                    <label for="voice_cast_voice_lang">🌐 음성 언어</label>
                    <select id="voice_cast_voice_lang" class="text_pole" style="width:auto">
                        <option value="display">화면에 보이는 대로 (번역본 우선)</option>
                        <option value="original">원문 그대로 (번역 무시)</option>
                        <option value="translate">AI가 번역해서 읽기</option>
                    </select>
                </div>
                <div id="voice_cast_translate_block" class="vc_row" style="display:none">
                    <label for="voice_cast_translate_to">번역할 언어</label>
                    <input id="voice_cast_translate_to" type="text" class="text_pole" style="width:140px" list="voice_cast_lang_list" placeholder="English" />
                    <datalist id="voice_cast_lang_list">
                        <option value="English"></option><option value="Japanese"></option><option value="Korean"></option>
                        <option value="Chinese"></option><option value="French"></option><option value="Spanish"></option><option value="German"></option>
                    </datalist>
                </div>
                <div class="vc_hint">원문/번역은 메시지마다 따로 저장돼서 왔다 갔다 해도 다시 만들지 않아요. 요술봉(🪄) 메뉴에서도 바로 바꿀 수 있어요.</div>
                <label class="checkbox_label"><input id="voice_cast_highlight" type="checkbox" /><span>읽는 대사 채팅에 형광펜 표시</span></label>
                <div class="vc_row">
                    <label for="voice_cast_translation_wait">자동 재생 시 번역 기다리기 (초, 0=안 기다림)</label>
                    <input id="voice_cast_translation_wait" type="number" class="text_pole" min="0" max="60" step="1" style="width:70px" />
                </div>
                <div class="vc_row">
                    <div id="voice_cast_stop" class="menu_button menu_button_icon"><i class="fa-solid fa-stop"></i><span>정지</span></div>
                    <div id="voice_cast_show_script" class="menu_button menu_button_icon"><i class="fa-solid fa-scroll"></i><span>마지막 대본 편집</span></div>
                </div>

                <div class="vc_section_title">🧠 대사 분류 AI</div>
                <div class="vc_hint">비워두면 지금 연결된 메인 API를 써요. 싼 모델 프로필을 따로 골라두는 걸 추천!</div>
                <select id="voice_cast_profile" class="text_pole"></select>
                <div class="vc_row">
                    <label for="voice_cast_max_tokens">최대 응답 토큰</label>
                    <input id="voice_cast_max_tokens" type="number" class="text_pole" min="256" max="16000" step="128" style="width:90px" />
                </div>
                <div class="vc_row">
                    <label for="voice_cast_context_chars">이전 메시지 참고 길이 (글자, 0=안 씀)</label>
                    <input id="voice_cast_context_chars" type="number" class="text_pole" min="0" max="10000" step="100" style="width:90px" />
                </div>
                <label for="voice_cast_extra">추가 지시 (선택, 영어 권장)</label>
                <textarea id="voice_cast_extra" class="text_pole" rows="2" placeholder="e.g. Lines in 「」 are phone calls."></textarea>

                <div class="vc_section_title">🎙️ ElevenLabs</div>
                <div class="vc_row">
                    <div id="voice_cast_key" class="menu_button menu_button_icon manage-api-keys" data-key="api_key_elevenlabs" title="실리태번 비밀 저장소에 키를 저장해요 (기본 TTS와 공유)">
                        <i class="fa-solid fa-key"></i><span>ElevenLabs API 키 설정</span>
                    </div>
                </div>
                <div class="vc_hint">키는 실리태번 서버의 비밀 저장소에 저장돼요. 기본 TTS 확장은 꺼둬도 괜찮아요.</div>
                <div class="vc_row">
                    <a class="menu_button menu_button_icon" href="${ELEVENLABS_HISTORY_URL}" target="_blank" rel="noopener noreferrer" title="일레븐랩스 생성 기록(History)을 새 탭에서 열어요">
                        <i class="fa-solid fa-clock-rotate-left"></i><span>일레븐랩스 기록 열기</span>
                    </a>
                    <a class="menu_button menu_button_icon" href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noopener noreferrer" title="API 키 관리 페이지">
                        <i class="fa-solid fa-up-right-from-square"></i><span>API 키 페이지</span>
                    </a>
                </div>
                <div class="vc_hint">개인 요금제는 로깅을 끌 수 없어서, 기록은 History에서 직접 지워야 해요. MultiCast TTS에 저장된 음성은 지워도 그대로 남아요.</div>
                <label for="voice_cast_model">모델</label>
                <select id="voice_cast_model" class="text_pole">${modelOptions}</select>
                <div id="voice_cast_custom_model_block" style="display:none">
                    <input id="voice_cast_custom_model" type="text" class="text_pole" placeholder="예: eleven_v5" />
                    <div class="vc_hint">일레븐랩스 문서에 나온 model_id를 그대로 적으면 돼요. 새 모델은 태그 지원으로 간주해요 (아래 체크박스로 끌 수 있어요).</div>
                </div>
                <label class="checkbox_label"><input id="voice_cast_use_tags" type="checkbox" /><span>감정 태그로 연기시키기 [angry] 등 (v3/v4만)</span></label>
                <div class="vc_row">
                    <label for="voice_cast_thought_tag">속마음에 붙일 태그</label>
                    <input id="voice_cast_thought_tag" type="text" class="text_pole" style="width:120px" placeholder="whispering" />
                </div>
                <label>Stability: <span id="voice_cast_stability_val"></span></label>
                <input id="voice_cast_stability" type="range" min="0" max="1" step="0.05" />
                <label>Similarity: <span id="voice_cast_similarity_val"></span></label>
                <input id="voice_cast_similarity" type="range" min="0" max="1" step="0.05" />
                <label>볼륨: <span id="voice_cast_volume_val"></span></label>
                <input id="voice_cast_volume" type="range" min="0" max="1" step="0.05" />
                <div class="vc_row">
                    <label for="voice_cast_concurrency">동시 생성 개수</label>
                    <input id="voice_cast_concurrency" type="number" class="text_pole" min="1" max="5" step="1" style="width:60px" />
                </div>

                <div class="vc_section_title">💾 저장된 음성</div>
                <div class="vc_hint">한 번 만든 음성은 이 브라우저에 저장돼서 다시 들을 땐 크레딧을 안 써요. 용량을 넘으면 오래된 것부터 지워져요.</div>
                <div class="vc_row">
                    <label for="voice_cast_cache_mb">최대 용량 (MB)</label>
                    <input id="voice_cast_cache_mb" type="number" class="text_pole" min="10" max="5000" step="10" style="width:90px" />
                </div>
                <div class="vc_row">
                    <span id="voice_cast_cache_stats" class="vc_hint"></span>
                    <div id="voice_cast_saved_list" class="menu_button menu_button_icon"><i class="fa-solid fa-list"></i><span>이 채팅 음성 목록</span></div>
                    <div id="voice_cast_cache_clear" class="menu_button menu_button_icon"><i class="fa-solid fa-broom"></i><span>전부 지우기</span></div>
                </div>

                <div class="vc_section_title">🗣️ 기본 목소리</div>
                <div class="vc_row">
                    <div id="voice_cast_load_voices" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i><span>목소리 목록 불러오기</span></div>
                </div>
                <label for="voice_cast_male_voice">남자</label>
                <select id="voice_cast_male_voice" class="text_pole"></select>
                <label for="voice_cast_female_voice">여자</label>
                <select id="voice_cast_female_voice" class="text_pole"></select>
                <label for="voice_cast_unknown_voice">성별 모름 (비우면 남자 목소리)</label>
                <select id="voice_cast_unknown_voice" class="text_pole"></select>

                <div id="voice_cast_bot_cast_block">
                    <div id="voice_cast_bot_cast_title" class="vc_section_title">🎭 이 봇 캐스트</div>
                    <div class="vc_hint">이 봇 채팅방에서만 쓰는 목소리예요. 새 채팅을 열어도 그대로 유지돼요. 캐릭터와 페르소나 이름은 처음 한 번 자동으로 추가되고, 고치거나 지워도 다시 생기지 않아요.</div>
                    <div id="voice_cast_bot_cast_list"></div>
                    <div class="menu_button menu_button_icon vc_cast_add" data-scope="bot"><i class="fa-solid fa-plus"></i><span>캐릭터 추가</span></div>
                </div>
                <div id="voice_cast_no_bot" class="vc_hint" style="display:none">채팅을 열면 그 봇 전용 캐스트가 여기 나와요.</div>

                <div class="vc_section_title">🌐 공통 캐스트 (모든 봇)</div>
                <div class="vc_hint">어느 봇에서나 같은 목소리를 쓸 캐릭터예요 (예: 내 페르소나는 {{user}}). 이름이 겹치면 이 봇 캐스트가 우선이에요.</div>
                <div id="voice_cast_cast_list"></div>
                <div class="menu_button menu_button_icon vc_cast_add" data-scope="global"><i class="fa-solid fa-plus"></i><span>캐릭터 추가</span></div>

                <div class="vc_section_title">📦 설정 옮기기</div>
                <div class="vc_hint">캐스트(봇별·공통), 기본 목소리, 분류·연기 설정을 파일 하나로 저장하고 다른 기기에서 불러와요. API 키는 들어가지 않아요.</div>
                <div class="vc_row">
                    <div id="voice_cast_export" class="menu_button menu_button_icon"><i class="fa-solid fa-file-export"></i><span>내보내기</span></div>
                    <div id="voice_cast_import" class="menu_button menu_button_icon"><i class="fa-solid fa-file-import"></i><span>가져오기</span></div>
                    <input id="voice_cast_import_file" type="file" accept=".json,application/json" style="display:none" />
                </div>
            </div>
        </div>
    </div>`;
}

function bindSettingsUI() {
    const s = getSettings();
    const ctx = SillyTavern.getContext();

    const bindCheck = (id, key) => {
        $(id).prop('checked', !!s[key]).on('change', function () {
            s[key] = $(this).prop('checked');
            save();
        });
    };
    const bindNumber = (id, key) => {
        $(id).val(s[key]).on('change', function () {
            const v = Number($(this).val());
            s[key] = Number.isFinite(v) ? v : defaultSettings[key];
            save();
        });
    };
    const bindRange = (id, key, fmt) => {
        const $out = $(`${id}_val`);
        $(id).val(s[key]);
        $out.text(fmt(s[key]));
        $(id).on('input', function () {
            s[key] = Number($(this).val());
            $out.text(fmt(s[key]));
            save();
        });
    };
    const pct = v => `${Math.round(Number(v) * 100)}%`;

    bindCheck('#voice_cast_enabled', 'enabled');
    bindCheck('#voice_cast_auto', 'autoPlay');
    bindCheck('#voice_cast_pregen', 'pregenerate');
    bindCheck('#voice_cast_quick', 'quickButtons');
    bindCheck('#voice_cast_line_btns', 'lineButtons');
    $('#voice_cast_line_btns').on('change', () => refreshLineButtons());
    $('#voice_cast_saved_list').on('click', openSavedList);
    $('#voice_cast_quick').on('change', applyQuickButtons);
    bindCheck('#voice_cast_thoughts', 'includeThoughts');
    const syncLangUI = () => {
        $('#voice_cast_voice_lang').val(s.voiceLang);
        $('#voice_cast_translate_block').toggle(s.voiceLang === 'translate');
        updateWandItem();
    };
    $('#voice_cast_translate_to').val(s.translateTo);
    syncLangUI();
    $('#voice_cast_voice_lang').on('change', function () {
        s.voiceLang = String($(this).val());
        save();
        syncLangUI();
    });
    $('#voice_cast_translate_to').on('change', function () {
        s.translateTo = String($(this).val() ?? '').trim() || 'English';
        $(this).val(s.translateTo);
        save();
        updateWandItem();
    });
    bindCheck('#voice_cast_use_tags', 'useTags');
    bindCheck('#voice_cast_highlight', 'highlight');
    bindNumber('#voice_cast_translation_wait', 'translationWaitSec');
    bindNumber('#voice_cast_max_tokens', 'maxTokens');
    bindNumber('#voice_cast_context_chars', 'contextChars');
    bindNumber('#voice_cast_concurrency', 'concurrency');
    bindRange('#voice_cast_stability', 'stability', pct);
    bindRange('#voice_cast_similarity', 'similarity', pct);
    bindRange('#voice_cast_volume', 'volume', pct);

    $('#voice_cast_extra').val(s.extraInstructions).on('input', function () {
        s.extraInstructions = String($(this).val());
        save();
    });
    $('#voice_cast_thought_tag').val(s.thoughtTag).on('input', function () {
        s.thoughtTag = String($(this).val()).replace(/[[\]]/g, '').trim();
        save();
    });
    // Model: preset list or a custom-typed model_id (so new models work without an update)
    const $model = $('#voice_cast_model');
    const $customBlock = $('#voice_cast_custom_model_block');
    const $customInput = $('#voice_cast_custom_model');
    if (isPresetModel(s.model)) {
        $model.val(s.model);
    } else {
        $model.val('__custom__');
        $customInput.val(s.model);
        $customBlock.show();
    }
    $model.on('change', function () {
        const v = String($(this).val());
        if (v === '__custom__') {
            $customBlock.show();
            const typed = String($customInput.val() ?? '').trim();
            if (typed) { s.model = typed; save(); }
            $customInput.trigger('focus');
        } else {
            $customBlock.hide();
            s.model = v;
            save();
        }
    });
    $customInput.on('input', function () {
        const typed = String($(this).val() ?? '').trim();
        if (typed) { s.model = typed; save(); }
    });

    // Audio cache
    bindNumber('#voice_cast_cache_mb', 'audioCacheMB');
    const refreshCacheStats = async () => {
        const { count, mb } = await cacheStats();
        $('#voice_cast_cache_stats').text(`저장된 음성 ${count}개 · ${mb.toFixed(1)}MB`);
    };
    refreshCacheStats();
    $('#voice_cast_settings .inline-drawer-toggle').on('click', refreshCacheStats);
    $('#voice_cast_cache_clear').on('click', async () => {
        const ok = await ctx.Popup.show.confirm('MultiCast TTS', '저장된 음성을 전부 지울까요? 다시 들으면 새로 생성돼요(크레딧 사용).');
        if (!ok) return;
        await clearAudioCache();
        refreshCacheStats();
        toastr.success('저장된 음성을 지웠어요.', 'MultiCast TTS');
    });

    // Connection profile dropdown
    try {
        ctx.ConnectionManagerRequestService.handleDropdown(
            '#voice_cast_profile',
            s.profileId,
            (profile) => {
                s.profileId = profile?.id ?? '';
                save();
            },
        );
        const $first = $('#voice_cast_profile option[value=""]');
        $first.text('(현재 메인 API 사용)');
    } catch (e) {
        console.warn(LOG, 'Connection Manager unavailable:', e);
        $('#voice_cast_profile').html('<option value="">(Connection Manager 꺼짐 — 메인 API 사용)</option>').prop('disabled', true);
        s.profileId = '';
    }

    // Default voices
    $('#voice_cast_male_voice').on('change', function () { s.maleVoiceId = String($(this).val()); save(); });
    $('#voice_cast_female_voice').on('change', function () { s.femaleVoiceId = String($(this).val()); save(); });
    $('#voice_cast_unknown_voice').on('change', function () { s.unknownVoiceId = String($(this).val()); save(); });
    $('#voice_cast_load_voices').on('click', () => loadVoices(true));

    // Cast list (delegated)
    // Cast lists (bot + shared), delegated
    const rowRef = (el) => {
        const $row = $(el).closest('.vc_cast_row');
        return { list: castArray(String($row.data('scope'))), i: Number($row.data('index')), scope: String($row.data('scope')) };
    };
    $('#voice_cast_settings')
        .on('click', '.vc_cast_add', function () {
            castArray(String($(this).data('scope'))).push({ names: '', gender: 'u', voiceId: '' });
            save();
            renderCastList();
            $(`#voice_cast_${$(this).data('scope') === 'bot' ? 'bot_cast_list' : 'cast_list'} .vc_cast_names`).last().trigger('focus');
        })
        .on('input', '.vc_cast_names', function () {
            const { list, i } = rowRef(this);
            if (list?.[i]) { list[i].names = String($(this).val()); save(); }
        })
        .on('change', '.vc_cast_gender', function () {
            const { list, i } = rowRef(this);
            if (list?.[i]) { list[i].gender = String($(this).val()); save(); }
        })
        .on('change', '.vc_cast_voice', function () {
            const { list, i } = rowRef(this);
            if (list?.[i]) { list[i].voiceId = String($(this).val()); save(); }
        })
        .on('click', '.vc_cast_delete', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            list.splice(i, 1);
            openAdv.clear();
            save();
            renderCastList();
        })
        .on('click', '.vc_cast_adv_toggle', function () {
            const { i, scope } = rowRef(this);
            const id = `${scope}:${i}`;
            const $adv = $(this).closest('.vc_cast_row').find('.vc_cast_adv');
            if (openAdv.has(id)) { openAdv.delete(id); $adv.hide(); } else { openAdv.add(id); $adv.show(); }
        })
        .on('input', '.vc_cast_stab, .vc_cast_sim', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const isStab = $(this).hasClass('vc_cast_stab');
            const v = Number($(this).val());
            list[i][isStab ? 'stability' : 'similarity'] = v;
            const $row = $(this).closest('.vc_cast_row');
            $row.find(isStab ? '.vc_cast_stab_val' : '.vc_cast_sim_val').text(`${Math.round(v * 100)}%`);
            $row.find('.vc_cast_adv_toggle').addClass('vc_custom');
            save();
        })
        .on('click', '.vc_cast_adv_reset', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            delete list[i].stability;
            delete list[i].similarity;
            save();
            renderCastList();
        })
        .on('click', '.vc_cast_move', function () {
            const { list, i, scope } = rowRef(this);
            if (!list?.[i]) return;
            const target = castArray(scope === 'bot' ? 'global' : 'bot');
            if (!target) return;
            target.push(list.splice(i, 1)[0]);
            openAdv.clear();
            save();
            renderCastList();
        });

    $('#voice_cast_stop').on('click', stopPlayback);
    $('#voice_cast_export').on('click', exportSettings);
    $('#voice_cast_import').on('click', () => $('#voice_cast_import_file').val('').trigger('click'));
    $('#voice_cast_import_file').on('change', function () {
        const file = this.files?.[0];
        if (file) importSettings(file);
    });
    $('#voice_cast_show_script').on('click', showLastScript);
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = SillyTavern.getContext();
    if (!SlashCommandParser || !SlashCommand) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast',
        aliases: ['multicast'],
        callback: async (args, value) => {
            const chat = SillyTavern.getContext().chat;
            const raw = String(value ?? '').trim();
            const id = raw === '' ? chat.length - 1 : Number(raw);
            if (!Number.isInteger(id) || !chat[id]) {
                toastr.warning('메시지 번호가 올바르지 않아요.', 'MultiCast TTS');
                return '';
            }
            await playMessage(id, { force: String(args?.force) === 'true' });
            return '';
        },
        namedArgumentList: SlashCommandNamedArgument ? [
            SlashCommandNamedArgument.fromProps({
                name: 'force',
                description: 'true면 대사를 다시 분류',
                typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.BOOLEAN] : undefined,
                defaultValue: 'false',
            }),
        ] : [],
        unnamedArgumentList: SlashCommandArgument ? [
            SlashCommandArgument.fromProps({
                description: '메시지 번호 (비우면 마지막 메시지)',
                typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.NUMBER] : undefined,
                isRequired: false,
            }),
        ] : [],
        helpString: '<div>MultiCast TTS로 메시지를 멀티보이스로 읽어요. 예: <code>/voicecast</code>, <code>/voicecast 12</code>, <code>/voicecast force=true</code></div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-list',
        aliases: ['multicast-list'],
        callback: async () => { await openSavedList(); return ''; },
        helpString: '<div>이 채팅에서 만든 대사 음성 목록을 열어요.</div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-save',
        aliases: ['multicast-save'],
        callback: async (_args, value) => {
            const chat = SillyTavern.getContext().chat;
            const raw = String(value ?? '').trim();
            const id = raw === '' ? chat.length - 1 : Number(raw);
            if (!Number.isInteger(id) || !chat[id]) return '';
            await downloadMessageAudio(id);
            return '';
        },
        helpString: '<div>메시지 대사 전체를 mp3 한 파일로 저장해요. 예: <code>/voicecast-save</code>, <code>/voicecast-save 12</code></div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-lang',
        aliases: ['multicast-lang'],
        callback: (_args, value) => {
            const v = String(value ?? '').trim().toLowerCase();
            const map = { display: 'display', screen: 'display', '화면': 'display', original: 'original', '원문': 'original', translate: 'translate', '번역': 'translate' };
            if (!v) cycleVoiceLang();
            else if (map[v]) setVoiceLang(map[v]);
            else { getSettings().translateTo = String(value).trim(); setVoiceLang('translate'); $('#voice_cast_translate_to').val(getSettings().translateTo); }
            return voiceLangLabel();
        },
        helpString: '<div>음성 언어 바꾸기. <code>/voicecast-lang</code> (순서대로 전환), <code>/voicecast-lang 원문</code>, <code>/voicecast-lang 화면</code>, <code>/voicecast-lang English</code> (그 언어로 AI 번역)</div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-stop',
        aliases: ['multicast-stop'],
        callback: () => { stopPlayback(); return ''; },
        helpString: '<div>MultiCast TTS 재생을 멈춰요.</div>',
    }));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();
    getSettings();

    $('#extensions_settings2').append(settingsHtml());
    bindSettingsUI();
    renderVoiceSelects();

    injectButtons();
    applyQuickButtons();
    watchChatForLineButtons();
    refreshLineButtons();
    // capture phase: a ▶ inside a translator's <summary> must not fold/unfold it
    document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.(`.${LINE_BTN}`);
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const messageId = Number(btn.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isNaN(messageId)) playScriptLine(messageId, Number(btn.dataset.line));
    }, true);
    $(document).on('click', '.vc_play_btn', onButtonClick);
    $(document).on('click', '.vc_edit_btn', onEditButtonClick);
    $(document).on('click', '.vc_status', (e) => { e.stopPropagation(); stopPlayback(); });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        stopPlayback();
        setTimeout(injectButtons, 100);
        ensureBotCast();
        renderCastList();
        // the bot's linked persona can be applied right after this event
        setTimeout(() => { ensureBotCast(); renderCastList(); }, 800);
    });
    if (event_types.PERSONA_CHANGED) {
        eventSource.on(event_types.PERSONA_CHANGED, () => { ensureBotCast(); renderCastList(); });
    }
    eventSource.on(event_types.MORE_MESSAGES_LOADED, injectButtons);
    eventSource.on(event_types.MESSAGE_SWIPED, (id) => { if (playingMessageId === Number(id)) stopPlayback(); });
    eventSource.on(event_types.APP_READY, () => { loadVoices(false); addWandItem(); });
    addWandItem();
    // Reload voices when the ElevenLabs key is set/changed from the key button
    for (const ev of [event_types.SECRET_WRITTEN, event_types.SECRET_ROTATED, event_types.SECRET_DELETED]) {
        if (!ev) continue;
        eventSource.on(ev, (key) => {
            if (key === 'api_key_elevenlabs') loadVoices(ev === event_types.SECRET_WRITTEN);
        });
    }

    try {
        registerCommands();
    } catch (e) {
        console.warn(LOG, 'slash command registration failed', e);
    }

    console.log(LOG, 'loaded');
});
