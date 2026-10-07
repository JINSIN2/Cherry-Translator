// Cherry Translator - SillyTavern extension
// Line-by-line LLM translation that never touches status windows, code blocks or custom tags.

import {
    buildParts,
    makeBatches,
    buildUserPrompt,
    parseNumbered,
    validateLine,
    assemble,
    parseTagList,
    parseRegexList,
} from './core.js';

const MODULE_NAME = 'cherry_translator';
const DATA_KEY = 'cherry_translator';
const LOG = '[Cherry Translator]';

const DEFAULT_STYLE_PROMPT = `You are a skilled literary translator for interactive fiction and roleplay.
Translate the given lines into natural, fluent {{language}} that reads like a well-written native novel.
- Preserve the tone, mood, speech style and each character's voice. Keep polite/casual speech levels consistent with the characters' relationship.
- Keep names and terms consistent. Transliterate names naturally.
- Translate faithfully. Do not censor, soften, summarize, explain or add anything.`;

const FORMAT_RULES = `OUTPUT FORMAT (strict, always follow):
- The input is a list of numbered lines like "[[1]] text". They belong to one passage, in order; use neighboring lines as context.
- Return every line translated, prefixed with exactly the same marker, e.g. "[[1]] translated text".
- Exactly one output line per input line. Never merge, split, reorder, skip or add lines. Never put a line break inside a translated line.
- Keep markdown symbols (*, **, _, ~~, quotation marks, brackets) in the same places, wrapping the same words.
- Tokens like ${'⟦'}1${'⟧'} are placeholders. Copy every placeholder exactly as-is into the matching position.
- If part of a line is already written in {{language}}, keep that part exactly as it is and translate only the rest.
- If a line has nothing to translate, return it unchanged with its marker.
- Output only the numbered lines. No explanations, notes, headers or code fences.`;

const DEFAULT_PROTECTED_TAGS = 'status, choices, choice, options, think, thinking, reasoning, UpdateVariable, StatusPlaceHolderImpl, tableEdit, statusbar, info, panel';

const defaultSettings = Object.freeze({
    profileId: '',
    targetLanguage: 'Korean',
    inputLanguage: 'English',
    autoTranslate: false,
    tapToShowOriginal: true,
    showExtraButtons: true,
    showInputButton: true,
    notifyOtherExtensions: true,
    protectedTags: DEFAULT_PROTECTED_TAGS,
    protectUnknownTags: true,
    protectHtmlBlocks: true,
    customRegexes: '',
    stylePrompt: DEFAULT_STYLE_PROMPT,
    maxTokens: 8192,
    linesPerRequest: 40,
    concurrency: 2,
    includePreset: true,
});

const inProgress = new Set();
let inputBackup = null; // { before, after }
// When the formatter hook is available, translations are swapped in at render time
// instead of living in extra.display_text (which other extensions like to delete).
let useDisplayText = true;

function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = defaultSettings[key];
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Translation engine
// ---------------------------------------------------------------------------

function pipelineOptions(targetLang) {
    const s = getSettings();
    return {
        targetLang,
        protectedTags: parseTagList(s.protectedTags),
        protectUnknownTags: !!s.protectUnknownTags,
        protectHtmlBlocks: !!s.protectHtmlBlocks,
        customRegexes: parseRegexList(s.customRegexes),
    };
}

function buildSystemPrompt(targetLang) {
    const s = getSettings();
    const { substituteParams } = ctx();
    const style = (s.stylePrompt || DEFAULT_STYLE_PROMPT).replaceAll('{{language}}', targetLang);
    const rules = FORMAT_RULES.replaceAll('{{language}}', targetLang);
    let prompt = `${style}\n\n${rules}`;
    try {
        prompt = substituteParams(prompt);
    } catch {
        // Macros are optional.
    }
    return prompt;
}

async function requestBatch(items, targetLang) {
    const s = getSettings();
    const { ConnectionManagerRequestService } = ctx();
    if (!ConnectionManagerRequestService) {
        throw new Error('이 실리태번 버전에서는 연결 프로필 요청을 쓸 수 없어요. 실리태번을 업데이트해주세요.');
    }
    const messages = [
        { role: 'system', content: buildSystemPrompt(targetLang) },
        { role: 'user', content: buildUserPrompt(items) },
    ];
    const result = await ConnectionManagerRequestService.sendRequest(
        s.profileId,
        messages,
        Number(s.maxTokens) || defaultSettings.maxTokens,
        { stream: false, extractData: true, includePreset: !!s.includePreset, includeInstruct: true },
    );
    const content = typeof result === 'string' ? result : (result?.content ?? '');
    return parseNumbered(content);
}

async function runWithLimit(tasks, limit) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]();
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Translates every translatable line in the given parts (mutates part.translated).
 * Lines that still fail after a retry stay untranslated instead of breaking alignment.
 */
async function translateParts(parts, targetLang) {
    const s = getSettings();
    const pending = parts.filter(p => p.line);
    if (!pending.length) return { error: null };

    let lastError = null;
    const runRound = async (items, maxLines) => {
        const batches = makeBatches(items, maxLines, 5000);
        const tasks = batches.map(batch => async () => {
            try {
                const map = await requestBatch(batch, targetLang);
                batch.forEach((item, i) => {
                    const ok = validateLine(map.get(i + 1), item);
                    if (ok !== null) item.translated = ok;
                });
            } catch (error) {
                lastError = error;
                console.error(LOG, 'Batch failed', error);
            }
        });
        await runWithLimit(tasks, Number(s.concurrency) || 1);
    };

    await runRound(pending, Math.max(1, Number(s.linesPerRequest) || 40));
    const missing = pending.filter(p => p.translated == null);
    if (missing.length) {
        console.warn(LOG, `Retrying ${missing.length} line(s) that came back broken or missing.`);
        await runRound(missing, 8);
    }
    const translatedAny = pending.some(p => p.translated != null);
    return { error: translatedAny ? null : lastError };
}

async function translateText(text, targetLang, { wrap }) {
    const parts = buildParts(text, pipelineOptions(targetLang));
    const { error } = await translateParts(parts, targetLang);
    if (error) throw error;
    return assemble(parts, { wrap });
}

function ensureProfile() {
    const s = getSettings();
    if (!s.profileId) {
        toastr.warning('확장 설정에서 번역에 쓸 연결 프로필을 먼저 골라주세요.', 'Cherry Translator');
        return false;
    }
    return true;
}

function describeError(error) {
    const cause = error?.cause?.message || '';
    const msg = error?.message || String(error);
    return cause ? `${msg} (${cause})` : msg;
}

// ---------------------------------------------------------------------------
// Message state
// ---------------------------------------------------------------------------

function getData(message) {
    const data = message?.extra?.[DATA_KEY];
    return data && typeof data === 'object' ? data : null;
}

function hasValidTranslation(message) {
    const data = getData(message);
    return !!data && data.source === message.mes;
}

function clearTranslation(message) {
    const data = getData(message);
    if (!data) return;
    if (message.extra.display_text === data.display) delete message.extra.display_text;
    delete message.extra[DATA_KEY];
}

function applyDisplay(message) {
    if (!useDisplayText) return;
    const data = getData(message);
    if (!data) return;
    if (data.showing === 'translation') message.extra.display_text = data.display;
    else if (message.extra.display_text === data.display) delete message.extra.display_text;
}

function registerFormatterHook() {
    const { messageFormatter } = ctx();
    if (!messageFormatter?.addHook) {
        console.warn(LOG, 'Message formatter hooks not available; falling back to display_text.');
        return;
    }
    messageFormatter.addHook((mes, info) => {
        if (info.isReasoning) return mes;
        const id = Number(info.messageId);
        if (!Number.isInteger(id) || id < 0) return mes;
        const message = ctx().chat[id];
        const data = getData(message);
        if (!data || data.showing !== 'translation' || data.source !== message.mes) return mes;
        // Only replace the message's own text, not some other text rendered with this id.
        if (mes !== message.mes && !message.mes.endsWith(mes) && mes !== message.extra?.display_text) return mes;
        return data.display;
    }, { stage: messageFormatter.stage.BEFORE_REGEX, order: messageFormatter.order.EARLIEST });
    useDisplayText = false;
}

function refreshMessage(messageId) {
    const c = ctx();
    const message = c.chat[messageId];
    if (!message) return;
    c.updateMessageBlock(messageId, message);
    if (getSettings().notifyOtherExtensions) {
        // Lets Tavern Helper and similar renderers redraw this one message.
        c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, messageId);
    }
}

function setBusy(messageId, busy) {
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    el?.classList.toggle('mt-busy', busy);
}

async function translateMessage(messageId, { force = false, auto = false } = {}) {
    const c = ctx();
    const message = c.chat[messageId];
    if (!message || !message.mes?.trim()) return;
    if (!ensureProfile()) return;

    if (!force && hasValidTranslation(message)) {
        // Already translated: just make sure the translation is showing.
        const data = getData(message);
        if (data.showing !== 'translation') {
            data.showing = 'translation';
            applyDisplay(message);
            refreshMessage(messageId);
            await c.saveChat();
        }
        return;
    }

    if (inProgress.has(messageId)) {
        if (!auto) toastr.info('이미 번역 중이에요.', 'Cherry Translator');
        return;
    }

    const chatId = c.getCurrentChatId();
    const source = message.mes;
    const s = getSettings();
    const lang = s.targetLanguage || 'Korean';

    inProgress.add(messageId);
    setBusy(messageId, true);
    try {
        const result = await translateText(source, lang, { wrap: true });

        // The chat, swipe or text may have changed while waiting.
        const now = ctx();
        const current = now.chat[messageId];
        if (now.getCurrentChatId() !== chatId || current !== message || current.mes !== source) {
            console.info(LOG, 'Message changed during translation; result discarded.');
            return;
        }

        if (!result.translated && !result.failed) {
            if (!auto) toastr.info('번역할 부분이 없어요.', 'Cherry Translator');
            return;
        }

        if (typeof message.extra !== 'object' || !message.extra) message.extra = {};
        message.extra[DATA_KEY] = {
            v: 1,
            source,
            lang,
            display: result.display,
            originals: result.originals,
            showing: 'translation',
        };
        applyDisplay(message);
        refreshMessage(messageId);
        await now.saveChat();

        if (result.failed) {
            toastr.warning(`${result.failed}줄은 번역이 안 돼서 원문 그대로 뒀어요. 다시 번역 버튼으로 재시도할 수 있어요.`, 'Cherry Translator');
        }
    } catch (error) {
        console.error(LOG, error);
        toastr.error(`번역 실패: ${describeError(error)}`, 'Cherry Translator');
    } finally {
        inProgress.delete(messageId);
        setBusy(messageId, false);
    }
}

async function toggleOriginal(messageId) {
    const c = ctx();
    const message = c.chat[messageId];
    if (!message) return;
    if (!hasValidTranslation(message)) {
        toastr.info('이 메시지는 아직 번역되지 않았어요.', 'Cherry Translator');
        return;
    }
    const data = getData(message);
    data.showing = data.showing === 'original' ? 'translation' : 'original';
    applyDisplay(message);
    refreshMessage(messageId);
    await c.saveChat();
}

async function deleteTranslation(messageId) {
    const c = ctx();
    const message = c.chat[messageId];
    if (!getData(message)) {
        toastr.info('지울 번역이 없어요.', 'Cherry Translator');
        return;
    }
    clearTranslation(message);
    refreshMessage(messageId);
    await c.saveChat();
}

async function deleteAllTranslations() {
    const c = ctx();
    const confirmed = await c.Popup.show.confirm('Cherry Translator', '이 채팅의 번역을 전부 지울까요? 원문은 그대로 남아요.');
    if (!confirmed) return;
    let count = 0;
    c.chat.forEach((message, id) => {
        if (getData(message)) {
            clearTranslation(message);
            c.updateMessageBlock(id, message);
            count++;
        }
        // Translations stored in other swipes
        message.swipe_info?.forEach(info => {
            if (info?.extra?.[DATA_KEY]) {
                if (info.extra.display_text === info.extra[DATA_KEY].display) delete info.extra.display_text;
                delete info.extra[DATA_KEY];
            }
        });
    });
    await c.saveChat();
    toastr.success(`번역 ${count}개를 지웠어요.`, 'Cherry Translator');
}

// ---------------------------------------------------------------------------
// Tap a translated line to see its original line
// ---------------------------------------------------------------------------

function onLineClick(event) {
    if (!getSettings().tapToShowOriginal) return;
    const line = event.target.closest('.custom-mt-line');
    if (!line) return;
    if (event.target.closest('a, button, input, textarea, select, summary, .mt-orig')) return;
    const selection = window.getSelection?.();
    if (selection && String(selection).length > 0) return;

    const mes = line.closest('.mes');
    if (!mes || mes.querySelector('.mes_text textarea')) return;
    const messageId = Number(mes.getAttribute('mesid'));
    const message = ctx().chat[messageId];
    const data = getData(message);
    const idx = Number(line.dataset.mt);
    const original = data?.originals?.[idx];
    if (original == null) return;

    const next = line.nextElementSibling;
    if (next && next.classList.contains('mt-orig')) {
        next.remove();
        line.classList.remove('mt-open');
        return;
    }
    const box = document.createElement('span');
    box.className = 'mt-orig';
    const html = ctx().messageFormatting(original, message.name, false, message.is_user, -1);
    box.innerHTML = html.replace(/^\s*<p>/, '').replace(/<\/p>\s*$/, '');
    line.after(box);
    line.classList.add('mt-open');
}

// ---------------------------------------------------------------------------
// Input box translation
// ---------------------------------------------------------------------------

async function translateInput() {
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    if (!textarea) return;
    const value = textarea.value;

    // Second click right after translating restores what was typed.
    if (inputBackup && value === inputBackup.after) {
        textarea.value = inputBackup.before;
        inputBackup = null;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        toastr.info('번역 전 내용으로 되돌렸어요.', 'Cherry Translator');
        return;
    }
    if (!value.trim()) {
        toastr.info('입력창이 비어 있어요.', 'Cherry Translator');
        return;
    }
    if (!ensureProfile()) return;

    const button = document.getElementById('mt_input_button');
    if (button?.classList.contains('mt-busy')) return;
    button?.classList.add('mt-busy');
    try {
        const lang = getSettings().inputLanguage || 'English';
        const result = await translateText(value, lang, { wrap: false });
        if (!result.translated) {
            toastr.info('번역할 부분이 없어요.', 'Cherry Translator');
            return;
        }
        if (textarea.value !== value) {
            toastr.info('번역하는 동안 입력창 내용이 바뀌어서 적용하지 않았어요.', 'Cherry Translator');
            return;
        }
        textarea.value = result.plain;
        inputBackup = { before: value, after: result.plain };
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (result.failed) {
            toastr.warning(`${result.failed}줄은 번역이 안 돼서 그대로 뒀어요.`, 'Cherry Translator');
        }
    } catch (error) {
        console.error(LOG, error);
        toastr.error(`입력 번역 실패: ${describeError(error)}`, 'Cherry Translator');
    } finally {
        button?.classList.remove('mt-busy');
    }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const MESSAGE_BUTTONS_HTML = `
<div class="mes_button mt_btn mt_btn_translate ct-icon-cherry interactable" title="Cherry: 번역" tabindex="0"></div>
<div class="mes_button mt_btn mt_btn_original fa-solid fa-magnifying-glass interactable" title="Cherry: 원문 / 번역 전환" tabindex="0"></div>
<div class="mes_button mt_btn mt_btn_retranslate mt_extra fa-solid fa-rotate interactable" title="Cherry: 다시 번역" tabindex="0"></div>
<div class="mes_button mt_btn mt_btn_delete mt_extra fa-solid fa-eraser interactable" title="Cherry: 번역 지우기" tabindex="0"></div>`;

function addMessageButtons() {
    const template = document.querySelector('#message_template .extraMesButtons');
    if (template && !template.querySelector('.mt_btn_translate')) {
        template.insertAdjacentHTML('afterbegin', MESSAGE_BUTTONS_HTML);
    }
    document.querySelectorAll('#chat .mes .extraMesButtons').forEach(el => {
        if (!el.querySelector('.mt_btn_translate')) el.insertAdjacentHTML('afterbegin', MESSAGE_BUTTONS_HTML);
    });
}

function updateInputButton() {
    const s = getSettings();
    const existing = document.getElementById('mt_input_button');
    if (!s.showInputButton) {
        existing?.remove();
        return;
    }
    if (existing) return;
    const sendButton = document.getElementById('send_but');
    const html = '<div id="mt_input_button" class="ct-icon-bubble interactable" title="Cherry: 입력창 번역 (한 번 더 누르면 되돌리기)" tabindex="0"></div>';
    if (sendButton) sendButton.insertAdjacentHTML('beforebegin', html);
    else document.getElementById('rightSendForm')?.insertAdjacentHTML('afterbegin', html);
}

function addWandMenuItems() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('mt_wand_input')) return;
    menu.insertAdjacentHTML('beforeend', `
<div id="mt_wand_input" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <div class="ct-icon-bubble extensionsMenuExtensionButton"></div><span>Cherry: 입력창 번역</span>
</div>
<div id="mt_wand_last" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <div class="ct-icon-cherry extensionsMenuExtensionButton"></div><span>Cherry: 마지막 메시지 번역</span>
</div>
<div id="mt_wand_clear" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <div class="fa-solid fa-eraser extensionsMenuExtensionButton"></div><span>Cherry: 이 채팅 번역 전부 지우기</span>
</div>`);
}

function applyBodyClasses() {
    const s = getSettings();
    document.body.classList.toggle('mt-hide-extra', !s.showExtraButtons);
    document.body.classList.toggle('mt-tap-enabled', !!s.tapToShowOriginal);
}

function settingsHtml() {
    return `
<div id="cherry_translator_settings" class="extension_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Cherry Translator</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content mt-settings">
            <label for="mt_profile">번역에 쓸 연결 프로필</label>
            <select id="mt_profile" class="text_pole"></select>
            <small class="mt-hint">가볍고 빠른 모델로 프로필을 하나 만들어두면 좋아요. (예: Gemini Flash)</small>

            <div class="mt-row">
                <div class="mt-col">
                    <label for="mt_target_lang">번역 언어</label>
                    <input id="mt_target_lang" class="text_pole" type="text" placeholder="Korean" />
                </div>
                <div class="mt-col">
                    <label for="mt_input_lang">입력 번역 언어</label>
                    <input id="mt_input_lang" class="text_pole" type="text" placeholder="English" />
                </div>
            </div>

            <label class="checkbox_label"><input id="mt_auto" type="checkbox" /><span>봇 답장 오면 자동 번역</span></label>
            <label class="checkbox_label"><input id="mt_tap" type="checkbox" /><span>번역문 줄을 누르면 그 줄 원문 보기</span></label>
            <label class="checkbox_label"><input id="mt_extra" type="checkbox" /><span>다시 번역 / 번역 지우기 버튼 보이기</span></label>
            <label class="checkbox_label"><input id="mt_input_btn" type="checkbox" /><span>입력창 옆 번역 버튼 보이기</span></label>
            <label class="checkbox_label"><input id="mt_notify" type="checkbox" /><span>번역 후 상태창 다시 그리기 알림 (태번 헬퍼 상태창용)</span></label>

            <hr />
            <b>번역하지 않을 부분</b>
            <label for="mt_tags">보호할 태그 (쉼표로 구분)</label>
            <textarea id="mt_tags" class="text_pole" rows="2"></textarea>
            <small class="mt-hint">\`\`\` 코드블록은 항상 보호돼요. 여기 적은 태그는 &lt;태그&gt; ~ &lt;/태그&gt; 전체가 그대로 남아요.</small>
            <label class="checkbox_label"><input id="mt_unknown" type="checkbox" /><span>처음 보는 태그(&lt;tf_status&gt; 같은)도 자동 보호</span></label>
            <label class="checkbox_label"><input id="mt_html" type="checkbox" /><span>HTML 블록(&lt;div&gt;, &lt;details&gt;, &lt;table&gt; 등) 보호</span></label>
            <label for="mt_regex">추가 보호 정규식 (한 줄에 하나, 고급)</label>
            <textarea id="mt_regex" class="text_pole" rows="2" placeholder="/\\[STATUS\\][\\s\\S]*?\\[\\/STATUS\\]/gi"></textarea>

            <hr />
            <label for="mt_prompt">번역 스타일 프롬프트 <small>({{language}} = 번역 언어)</small></label>
            <textarea id="mt_prompt" class="text_pole" rows="6"></textarea>
            <small class="mt-hint">줄 번호 형식 규칙은 확장이 따로 붙여서 보내요. 여기엔 문체나 용어 지시만 적으면 돼요.</small>
            <div class="menu_button" id="mt_prompt_reset">기본 프롬프트로 되돌리기</div>

            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>고급 설정</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="mt-row">
                        <div class="mt-col">
                            <label for="mt_max_tokens">최대 출력 토큰</label>
                            <input id="mt_max_tokens" class="text_pole" type="number" min="256" step="256" />
                        </div>
                        <div class="mt-col">
                            <label for="mt_lines">요청당 줄 수</label>
                            <input id="mt_lines" class="text_pole" type="number" min="1" max="200" />
                        </div>
                        <div class="mt-col">
                            <label for="mt_concurrency">동시 요청 수</label>
                            <input id="mt_concurrency" class="text_pole" type="number" min="1" max="6" />
                        </div>
                    </div>
                    <label class="checkbox_label"><input id="mt_preset" type="checkbox" /><span>프로필에 연결된 프리셋의 생성 설정(온도 등) 사용</span></label>
                </div>
            </div>
        </div>
    </div>
</div>`;
}

function bindCheckbox(id, key, after) {
    const s = getSettings();
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    el.checked = !!s[key];
    el.addEventListener('change', () => {
        s[key] = el.checked;
        save();
        after?.();
    });
}

function bindText(id, key, { number = false } = {}) {
    const s = getSettings();
    const el = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (document.getElementById(id));
    el.value = s[key];
    el.addEventListener('input', () => {
        s[key] = number ? Number(el.value) : el.value;
        save();
    });
}

function setupSettings() {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container || document.getElementById('cherry_translator_settings')) return;
    container.insertAdjacentHTML('beforeend', settingsHtml());

    const s = getSettings();
    try {
        ctx().ConnectionManagerRequestService.handleDropdown('#mt_profile', s.profileId, (profile) => {
            s.profileId = profile?.id ?? '';
            save();
        });
    } catch (error) {
        console.error(LOG, error);
        const select = document.getElementById('mt_profile');
        select.innerHTML = '<option value="">연결 관리자(Connection Manager)를 켜주세요</option>';
    }

    bindText('mt_target_lang', 'targetLanguage');
    bindText('mt_input_lang', 'inputLanguage');
    bindCheckbox('mt_auto', 'autoTranslate');
    bindCheckbox('mt_tap', 'tapToShowOriginal', applyBodyClasses);
    bindCheckbox('mt_extra', 'showExtraButtons', applyBodyClasses);
    bindCheckbox('mt_input_btn', 'showInputButton', updateInputButton);
    bindCheckbox('mt_notify', 'notifyOtherExtensions');
    bindText('mt_tags', 'protectedTags');
    bindCheckbox('mt_unknown', 'protectUnknownTags');
    bindCheckbox('mt_html', 'protectHtmlBlocks');
    bindText('mt_regex', 'customRegexes');
    bindText('mt_prompt', 'stylePrompt');
    bindText('mt_max_tokens', 'maxTokens', { number: true });
    bindText('mt_lines', 'linesPerRequest', { number: true });
    bindText('mt_concurrency', 'concurrency', { number: true });
    bindCheckbox('mt_preset', 'includePreset');

    document.getElementById('mt_prompt_reset').addEventListener('click', () => {
        s.stylePrompt = DEFAULT_STYLE_PROMPT;
        /** @type {HTMLTextAreaElement} */ (document.getElementById('mt_prompt')).value = DEFAULT_STYLE_PROMPT;
        save();
    });
}

function messageIdFrom(el) {
    const mes = el.closest('.mes');
    if (!mes) return null;
    const id = Number(mes.getAttribute('mesid'));
    return Number.isInteger(id) ? id : null;
}

function bindGlobalHandlers() {
    document.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (!(target instanceof Element)) return;

        const button = target.closest('.mt_btn');
        if (button) {
            const id = messageIdFrom(button);
            if (id === null) return;
            if (button.classList.contains('mt_btn_translate')) translateMessage(id);
            else if (button.classList.contains('mt_btn_original')) toggleOriginal(id);
            else if (button.classList.contains('mt_btn_retranslate')) translateMessage(id, { force: true });
            else if (button.classList.contains('mt_btn_delete')) deleteTranslation(id);
            return;
        }

        if (target.closest('#mt_input_button') || target.closest('#mt_wand_input')) {
            translateInput();
            return;
        }
        if (target.closest('#mt_wand_last')) {
            const { chat } = ctx();
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) {
                    translateMessage(i);
                    break;
                }
            }
            return;
        }
        if (target.closest('#mt_wand_clear')) {
            deleteAllTranslations();
            return;
        }

        if (target.closest('#chat .custom-mt-line')) onLineClick(event);
    });
}

function bindEvents() {
    const { eventSource, eventTypes } = ctx();

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
        const s = getSettings();
        if (!s.autoTranslate || !s.profileId) return;
        if (type === 'impersonate') return;
        const id = Number(messageId);
        const message = ctx().chat[id];
        if (!message || message.is_user || message.is_system) return;
        if (hasValidTranslation(message)) return;
        translateMessage(id, { auto: true });
    });

    eventSource.on(eventTypes.MESSAGE_EDITED, (messageId) => {
        const id = Number(messageId);
        const message = ctx().chat[id];
        const data = getData(message);
        if (!data) return;
        if (data.source !== message.mes) {
            // Original text changed: the old translation no longer matches.
            clearTranslation(message);
            const s = getSettings();
            if (s.autoTranslate && s.profileId && !message.is_user) {
                setTimeout(() => translateMessage(id, { auto: true }), 50);
            }
        } else if (useDisplayText && data.showing === 'translation') {
            // Editing re-renders the raw text; put the translation back afterwards.
            setTimeout(() => ctx().updateMessageBlock(id, message), 50);
        }
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        inputBackup = null;
    });

    eventSource.on(eventTypes.APP_READY, () => {
        addMessageButtons();
        addWandMenuItems();
        updateInputButton();
    });
}

function registerSlashCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cherry-translate',
        callback: async (_args, value) => {
            const { chat } = ctx();
            let id = Number(String(value ?? '').trim());
            if (String(value ?? '').trim() === '' || !Number.isInteger(id)) id = chat.length - 1;
            await translateMessage(id);
            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'message id (default: last message)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: '<div>Cherry Translator로 메시지를 번역해요. 번호를 안 적으면 마지막 메시지.</div>',
    }));
}

(function init() {
    try {
        getSettings();
        registerFormatterHook();
        setupSettings();
        addMessageButtons();
        addWandMenuItems();
        updateInputButton();
        applyBodyClasses();
        bindGlobalHandlers();
        bindEvents();
        registerSlashCommand();
        console.log(LOG, 'Loaded');
    } catch (error) {
        console.error(LOG, 'Init failed', error);
    }
})();
