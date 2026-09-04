// Breeze TTS 2 Provider — 实现 SillyTavern TTS 扩展的 provider 契约。
// 核心链路：generateTts(text, voiceId, voiceMapKey) → 清洗/分块 → 情绪指令编译 →
// 逐块请求引擎 → WAV data URL 逐块 yield（ST 核心边收边播）。
// 仅本文件 import SillyTavern（getContext），其余模块保持可单测。

import { getContext } from '/scripts/extensions.js';

import { BreezeEngineClient, makeSilentWavDataUrl } from './engine-client.js';
import { stripForTts, splitIntoChunks, splitSentences, detectLang, hashText } from './text.js';
import { VoiceStore, MUTE_VOICE, defaultVoiceProfiles } from './voices.js';
import { EmotionEngine, DEFAULT_LEXICON, DEFAULT_PROMPT_TEMPLATE, DEFAULT_INTENSITY_CFG } from './emotion.js';

const PROVIDER_NAME = 'Breeze TTS 2';

const DEFAULT_SETTINGS = () => ({
    endpoint: 'http://127.0.0.1:9897',
    maxChunkChars: 120,
    pieceSeconds: 4,
    retries: 4,
    debug: false,
    // 情绪引擎
    emotionEnabled: true,
    ruleFallback: true,
    lexicon: structuredClone(DEFAULT_LEXICON),
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    intensityCfg: { ...DEFAULT_INTENSITY_CFG },
    // 文本清洗
    stripAsterisks: true,
    // 声线
    voices: defaultVoiceProfiles(),
});

function segmentTypeFromKey(voiceMapKey) {
    const key = String(voiceMapKey ?? '');
    if (!key) { return 'dialogue'; }              // 单声线模式：整段按对话处理
    if (key.includes('Quotes')) { return 'dialogue'; }
    if (key.includes('asterisks')) { return 'action'; }
    return 'narration';
}

export class BreezeTtsProvider {
    constructor() {
        this.settings = DEFAULT_SETTINGS();
        this.store = new VoiceStore(this.settings.voices);
        this.client = new BreezeEngineClient(this.settings.endpoint, this.settings.retries);
        this.emotion = new EmotionEngine(this.settings, null);
        this.silentWav = null;
        this._editingId = null;
    }

    // ────────────────────── Provider 契约 ──────────────────────

    get settingsHtml() {
        const voiceOptions = this.store.all()
            .map((v) => `<option value="${v.id}">${v.name}（${v.mode === 'clone' ? '克隆' : '设计'}）</option>`)
            .join('');
        return `
        <div class="breeze2-settings">
            <div class="breeze2-inline">
                <label for="breeze2_endpoint">引擎地址</label>
                <input id="breeze2_endpoint" type="text" class="text_input" value="${this.settings.endpoint}" />
                <a id="breeze2_check" class="menu_button" title="检测引擎状态"><i class="fa-solid fa-heart-pulse"></i><span>检测</span></a>
            </div>
            <div id="breeze2_status" class="breeze2-status">未检测</div>

            <details open>
                <summary>🎙️ 声线库（克隆 / 设计）</summary>
                <div class="breeze2-inline">
                    <select id="breeze2_voice_list" class="breeze2-grow">${voiceOptions}</select>
                    <a id="breeze2_voice_add" class="menu_button"><i class="fa-solid fa-plus"></i><span>新建</span></a>
                    <a id="breeze2_voice_preview" class="menu_button"><i class="fa-solid fa-play"></i><span>预览</span></a>
                    <a id="breeze2_voice_del" class="menu_button"><i class="fa-solid fa-trash"></i><span>删除</span></a>
                </div>
                <div class="breeze2-inline">
                    <a id="breeze2_voice_export" class="menu_button"><i class="fa-solid fa-download"></i><span>导出</span></a>
                    <a id="breeze2_voice_import" class="menu_button"><i class="fa-solid fa-upload"></i><span>导入</span></a>
                    <input id="breeze2_import_file" type="file" accept="application/json" hidden />
                </div>

                <div id="breeze2_editor" class="breeze2-editor" hidden>
                    <label>声线名称 <input id="breeze2_v_name" type="text" class="text_input" /></label>
                    <label>模式
                        <select id="breeze2_v_mode">
                            <option value="design">设计（纯文字描述音色）</option>
                            <option value="clone">克隆（参考音频 + 精确文字稿）</option>
                        </select>
                    </label>
                    <div id="breeze2_v_clone_box">
                        <label>参考音频（建议 ≤30 秒、干净人声）<input id="breeze2_v_file" type="file" accept="audio/*" /></label>
                        <div id="breeze2_v_audio_info" class="breeze2-hint"></div>
                        <label>参考音频的精确文字稿（一字不差）
                            <textarea id="breeze2_v_reftext" class="text_input" rows="2"></textarea>
                        </label>
                    </div>
                    <label id="breeze2_v_design_box">音色描述（设计模式：如“温柔的年轻女性，声音清晰柔软”）
                        <textarea id="breeze2_v_design" class="text_input" rows="2"></textarea>
                    </label>
                    <label>默认导演指令（克隆模式下的基础语气，可留空）
                        <textarea id="breeze2_v_basedir" class="text_input" rows="2"></textarea>
                    </label>
                    <div class="breeze2-grid3">
                        <label>指令强度 CFG<input id="breeze2_v_cfg" type="number" min="0.5" max="8" step="0.5" /></label>
                        <label>Seed 模式
                            <select id="breeze2_v_seedmode">
                                <option value="random">随机（每次有变化）</option>
                                <option value="fixed">固定（可复现）</option>
                            </select>
                        </label>
                        <label>固定 Seed<input id="breeze2_v_seed" type="number" step="1" /></label>
                    </div>
                    <label>语言
                        <select id="breeze2_v_lang">
                            <option value="auto">自动检测</option>
                            <option value="zh">中文</option>
                            <option value="en">English</option>
                        </select>
                    </label>
                    <div class="breeze2-inline">
                        <a id="breeze2_v_save" class="menu_button"><i class="fa-solid fa-check"></i><span>保存声线</span></a>
                        <a id="breeze2_v_cancel" class="menu_button"><span>取消</span></a>
                    </div>
                </div>
                <div class="breeze2-hint">在 TTS 扩展的「Voice Map」里把角色映射到上面的声线名称；开启多声线后可为
                    引号台词 / *动作* / 旁白 分别指定声线（动作和旁白可选 🔇 静音）。</div>
            </details>

            <details>
                <summary>🎭 情绪引擎（LLM 台词分析）</summary>
                <label class="breeze2-checkbox"><input id="breeze2_emotion_enable" type="checkbox" /> 启用 LLM 情绪分析（用当前角色的 LLM，按上下文标注每段朗读语气）</label>
                <label class="breeze2-checkbox"><input id="breeze2_rule_fallback" type="checkbox" /> LLM 失败时用标点规则兜底</label>
                <div class="breeze2-grid3">
                    <label>强度1→CFG<input id="breeze2_cfg1" type="number" min="1" max="8" step="0.5" /></label>
                    <label>强度2→CFG<input id="breeze2_cfg2" type="number" min="1" max="8" step="0.5" /></label>
                    <label>强度3→CFG<input id="breeze2_cfg3" type="number" min="1" max="8" step="0.5" /></label>
                </div>
                <label>情绪词典（JSON：zh / en 两组，键=情绪名，值=朗读方式描述）
                    <textarea id="breeze2_lexicon" class="text_input breeze2-mono" rows="10"></textarea>
                </label>
                <label>导演 Prompt 模板（{enum} {events} {context} {lines}）
                    <textarea id="breeze2_prompt" class="text_input breeze2-mono" rows="8"></textarea>
                </label>
                <div class="breeze2-inline">
                    <a id="breeze2_apply_prompts" class="menu_button"><span>应用词典/Prompt</span></a>
                    <a id="breeze2_reset_prompts" class="menu_button"><span>恢复默认</span></a>
                    <a id="breeze2_cache_clear" class="menu_button"><span>清空情绪缓存</span></a>
                </div>
            </details>

            <details>
                <summary>⚙️ 文本与合成</summary>
                <label class="breeze2-checkbox"><input id="breeze2_strip_asterisks" type="checkbox" /> 删除 *动作描写*（未开启多声线时建议开启）</label>
                <div class="breeze2-grid3">
                    <label>单块最大字数<input id="breeze2_maxchunk" type="number" min="40" max="180" step="10" /></label>
                    <label>流式片长（秒）<input id="breeze2_piecesec" type="number" min="1" max="10" step="0.5" /></label>
                    <label>409 重试次数<input id="breeze2_retries" type="number" min="0" max="8" step="1" /></label>
                    <label class="breeze2-checkbox"><input id="breeze2_debug" type="checkbox" /> 调试日志</label>
                </div>
                <div class="breeze2-hint">流式片长越小首声越快（引擎 TTFA≈0.13s，首片 2 秒即出声），但片段接缝更频繁；出现明显停顿感可调大到 5~6。</div>
            </details>
        </div>`;
    }

    async loadSettings(settings) {
        // 只接受已知键，避免旧配置脏数据
        const defaults = DEFAULT_SETTINGS();
        for (const key of Object.keys(defaults)) {
            if (settings[key] !== undefined) {
                this.settings[key] = settings[key];
            }
        }
        // 深默认补齐
        this.settings.lexicon = {
            zh: { ...DEFAULT_LEXICON.zh, ...(this.settings.lexicon?.zh ?? {}) },
            en: { ...DEFAULT_LEXICON.en, ...(this.settings.lexicon?.en ?? {}) },
        };
        this.settings.intensityCfg = { ...DEFAULT_INTENSITY_CFG, ...(this.settings.intensityCfg ?? {}) };
        this.settings.voices = Array.isArray(this.settings.voices) && this.settings.voices.length
            ? this.settings.voices : defaults.voices;

        this.store = new VoiceStore(this.settings.voices);
        this.client.setEndpoint(this.settings.endpoint);
        this.client.retries = this.settings.retries;
        this.emotion = new EmotionEngine(this.settings, getContext());

        this._bindUi();
        this._wirePreAnalysis();
        this._refreshVoiceUi();
        this._checkHealth();
    }

    async checkReady() {
        const health = await this.client.health();
        if (!health.ok) {
            throw new Error(health.loading ? 'Breeze 引擎加载中（模型 warmup）' : (health.error ?? '引擎不可用'));
        }
        return true;
    }

    async onRefreshClick() {
        this._refreshVoiceUi();
        this._checkHealth();
    }

    async fetchTtsVoiceObjects() {
        return this.store.toVoiceObjects();
    }

    async getVoice(voiceName) {
        if (voiceName === MUTE_VOICE.name || voiceName === MUTE_VOICE.voice_id) {
            return { ...MUTE_VOICE };
        }
        const voice = this.store.get(voiceName);
        if (!voice) {
            throw new Error(`Breeze 声线 "${voiceName}" 不存在——请在 Breeze TTS 2 设置中创建，或重新应用 Voice Map`);
        }
        return { name: voice.name, voice_id: voice.id, lang: voice.lang, preview_url: null };
    }

    async previewTtsVoice(voiceId) {
        if (voiceId === MUTE_VOICE.voice_id) { return; }
        const profile = this.store.get(voiceId) ?? this.store.get(String(voiceId));
        if (!profile) { throw new Error(`声线 ${voiceId} 不存在`); }
        const lang = profile.lang === 'en' ? 'en' : 'zh';
        const sample = lang === 'en'
            ? 'Hello, this is a preview of my voice. (sigh) Hope you like it.'
            : '你好，这是我的声音预览。[笑] 希望你会喜欢这句台词。';
        const req = await this._buildRequest(sample, profile);
        const dataUrl = await this.client.synthesizeOnce(req);
        if (this.settings.debug) { console.info('[BreezeTTS2] 预览完成'); }
        void new Audio(dataUrl).play().catch(() => {});
        return dataUrl;
    }

    async dispose() { /* 无需清理 */ }

    // ────────────────────── 合成主链路 ──────────────────────

    async *generateTts(inputText, voiceId, voiceMapKey = null) {
        if (voiceId === MUTE_VOICE.voice_id) {
            return; // 静音声线：不产音频，核心直接完成该任务
        }
        const profile = this.store.get(voiceId);
        if (!profile) {
            throw new Error(`Breeze 声线 ${voiceId} 不存在，请在设置里检查 Voice Map`);
        }

        const segType = segmentTypeFromKey(voiceMapKey);
        const cleaned = stripForTts(inputText, {
            stripAsterisks: this.settings.stripAsterisks,
            stripOoc: true,
            stripUnknownBrackets: true,
        });
        const chunks = splitIntoChunks(cleaned, this.settings.maxChunkChars);
        if (this.settings.debug) {
            console.info(`[BreezeTTS2] seg=${segType} 清洗后 ${cleaned.length} 字 → ${chunks.length} 块`, cleaned);
        }
        if (!chunks.length) { return; }

        // 后台预热整段台词的情绪缓存（不阻塞首块）；首块若缓存未就绪则走规则立即出声
        const allSentences = [...new Set(chunks.flatMap((c) => splitSentences(c)))];
        const missing = allSentences.filter((s) => !this.emotion.cache.has(hashText(s)));
        if (missing.length && this.settings.emotionEnabled) {
            this.emotion.analyzeBatch(missing, this.emotion._recentContext()).catch(() => {});
        }

        for (const [i, chunk] of chunks.entries()) {
            const req = await this._buildRequest(chunk, profile, segType, { skipLLM: i === 0 });
            yield* this.client.synthesizeStream(req, this.settings.pieceSeconds, 2);
        }
    }

    // segType: 'dialogue' | 'action' | 'narration'（来自 voiceMapKey）。
    // 当前三路共用同一情绪管线，参数预留给旁白差异化语气。
    async _buildRequest(chunk, profile, segType = 'dialogue', { skipLLM = false } = {}) {
        const lang = profile.lang && profile.lang !== 'auto' ? profile.lang : detectLang(chunk);

        let instruction = profile.mode === 'design'
            ? String(profile.designInstruction ?? '').trim()
            : String(profile.baseDirection ?? '').trim();
        let cfg = profile.mode === 'design'
            ? Math.max(Number(profile.cfg) || 4, 4)   // 设计模式保证音色贴合描述
            : (Number(profile.cfg) || 2);

        let text = chunk;

        if (this.settings.emotionEnabled) {
            const result = await this.emotion.resolveForChunk(chunk, { skipLLM });
            if (result) {
                instruction = this.emotion.compileInstruction(instruction, result, lang);
                if (profile.mode !== 'design') {
                    cfg = Math.max(cfg, this.emotion.cfgForIntensity(result.intensity));
                }
                const tag = this.emotion.eventTag(result, lang);
                if (tag && !text.includes(tag)) {
                    text = `${tag}${lang === 'en' ? ' ' : ''}${text}`;
                }
            }
        }
        if (!instruction) {
            instruction = lang === 'en' ? 'Speak clearly and naturally.' : '自然清晰地朗读。';
        }

        const seed = profile.seedMode === 'fixed'
            ? (Number(profile.seed) || 42) + parseInt(hashText(chunk), 36) % 1000
            : Math.floor(Math.random() * 2147483647);

        return {
            text,
            instruction,
            cfgScale: cfg,
            seed,
            refAudio: profile.mode === 'clone' ? profile.refAudio : null,
            refText: profile.mode === 'clone' ? profile.refText : '',
        };
    }

    /**
     * 消息渲染即后台预分析情绪（与 TTS 排队并行），等 generateTts 到来时
     * 缓存多半已就绪——首块不被 LLM 阻塞的关键之一。
     */
    _wirePreAnalysis() {
        if (this._preAnalysisWired) { return; }
        try {
            const ctx = getContext();
            if (!ctx?.eventSource || !ctx?.eventTypes) { return; }
            this._preAnalysisWired = true;
            ctx.eventSource.on(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, (messageId) => {
                try {
                    const msg = ctx.chat?.[messageId];
                    if (!msg || msg.is_system || !msg.mes) { return; }
                    const cleaned = stripForTts(msg.mes, { stripAsterisks: this.settings.stripAsterisks });
                    const sentences = splitSentences(cleaned);
                    const missing = sentences.filter((s) => !this.emotion.cache.has(hashText(s)));
                    if (missing.length && this.settings.emotionEnabled) {
                        this.emotion.analyzeBatch(missing, this.emotion._recentContext())
                            .catch(() => {});
                    }
                } catch { /* 预分析失败不影响朗读 */ }
            });
        } catch (err) {
            console.warn('[BreezeTTS2] 预分析事件绑定失败:', err?.message ?? err);
        }
    }

    // ────────────────────── UI 绑定 ──────────────────────

    _save() {
        this.settings.voices = this.store.all();
        // 优先走 TTS 扩展的标准保存路径（同步 voiceMap）；异常时退回全局设置保存
        (async () => {
            try {
                const tts = await import('/scripts/extensions/tts/index.js');
                if (typeof tts.saveTtsProviderSettings === 'function') {
                    tts.saveTtsProviderSettings();
                    return;
                }
                throw new Error('saveTtsProviderSettings 不可用');
            } catch {
                const script = await import('/script.js');
                script.saveSettingsDebounced();
            }
        })().catch((err) => console.warn('[BreezeTTS2] 设置保存失败:', err));
    }

    _bindUi() {
        const $ = window.jQuery;
        const val = (id) => String($(`#${id}`).val() ?? '').trim();
        const num = (id, d) => {
            const n = Number($(`#${id}`).val());
            return Number.isFinite(n) ? n : d;
        };
        const checked = (id) => Boolean($(`#${id}`).prop('checked'));

        $('#breeze2_endpoint').val(this.settings.endpoint);
        $('#breeze2_endpoint').on('change', () => {
            this.settings.endpoint = val('breeze2_endpoint');
            this.client.setEndpoint(this.settings.endpoint);
            this._save();
            this._checkHealth();
        });
        $('#breeze2_check').on('click', () => this._checkHealth(true));

        // 文本与合成
        $('#breeze2_strip_asterisks').prop('checked', this.settings.stripAsterisks).on('change', (e) => {
            this.settings.stripAsterisks = Boolean(e.target.checked); this._save();
        });
        $('#breeze2_maxchunk').val(this.settings.maxChunkChars).on('change', (e) => {
            this.settings.maxChunkChars = Math.min(180, Math.max(40, Number(e.target.value) || 120)); this._save();
        });
        $('#breeze2_piecesec').val(this.settings.pieceSeconds).on('change', (e) => {
            this.settings.pieceSeconds = Math.min(10, Math.max(1, Number(e.target.value) || 4)); this._save();
        });
        $('#breeze2_retries').val(this.settings.retries).on('change', (e) => {
            this.settings.retries = Math.min(8, Math.max(0, Number(e.target.value) || 4));
            this.client.retries = this.settings.retries; this._save();
        });
        $('#breeze2_debug').prop('checked', this.settings.debug).on('change', (e) => {
            this.settings.debug = Boolean(e.target.checked); this._save();
        });

        // 情绪引擎
        $('#breeze2_emotion_enable').prop('checked', this.settings.emotionEnabled).on('change', (e) => {
            this.settings.emotionEnabled = Boolean(e.target.checked); this._save();
        });
        $('#breeze2_rule_fallback').prop('checked', this.settings.ruleFallback).on('change', (e) => {
            this.settings.ruleFallback = Boolean(e.target.checked); this._save();
        });
        $('#breeze2_cfg1').val(this.settings.intensityCfg[1]);
        $('#breeze2_cfg2').val(this.settings.intensityCfg[2]);
        $('#breeze2_cfg3').val(this.settings.intensityCfg[3]);
        const readCfgMap = () => {
            this.settings.intensityCfg = {
                1: num('breeze2_cfg1', 2), 2: num('breeze2_cfg2', 3), 3: num('breeze2_cfg3', 4),
            };
        };
        for (const id of ['breeze2_cfg1', 'breeze2_cfg2', 'breeze2_cfg3']) {
            $(`#${id}`).on('change', () => { readCfgMap(); this._save(); });
        }
        $('#breeze2_lexicon').val(JSON.stringify(this.settings.lexicon, null, 2));
        $('#breeze2_prompt').val(this.settings.promptTemplate);
        $('#breeze2_apply_prompts').on('click', () => {
            try {
                const parsed = JSON.parse(val('breeze2_lexicon'));
                this.settings.lexicon = {
                    zh: { ...DEFAULT_LEXICON.zh, ...(parsed.zh ?? {}) },
                    en: { ...DEFAULT_LEXICON.en, ...(parsed.en ?? {}) },
                };
                this.settings.promptTemplate = $('#breeze2_prompt').val() || DEFAULT_PROMPT_TEMPLATE;
                this.emotion.clearCache();
                this._save();
                toastr.success('Breeze TTS 2：词典与 Prompt 已应用');
            } catch (err) {
                toastr.error(`词典 JSON 解析失败：${err.message}`);
            }
        });
        $('#breeze2_reset_prompts').on('click', () => {
            this.settings.lexicon = structuredClone(DEFAULT_LEXICON);
            this.settings.promptTemplate = DEFAULT_PROMPT_TEMPLATE;
            $('#breeze2_lexicon').val(JSON.stringify(this.settings.lexicon, null, 2));
            $('#breeze2_prompt').val(this.settings.promptTemplate);
            this._save();
            toastr.info('已恢复默认词典与 Prompt');
        });
        $('#breeze2_cache_clear').on('click', () => {
            this.emotion.clearCache();
            toastr.info('情绪缓存已清空');
        });

        // 声线库
        $('#breeze2_voice_list').on('change', () => this._fillEditor());
        $('#breeze2_voice_add').on('click', () => {
            this._editingId = null; // 新建
            this._fillEditor(true);
            $('#breeze2_editor').removeAttr('hidden');
        });
        $('#breeze2_voice_preview').on('click', async () => {
            const id = val('breeze2_voice_list');
            try {
                await this.previewTtsVoice(id);
            } catch (err) {
                toastr.error(`预览失败：${err?.message ?? err}`);
            }
        });
        $('#breeze2_voice_del').on('click', async () => {
            const id = val('breeze2_voice_list');
            const profile = this.store.get(id);
            if (!profile) { return; }
            const confirmed = await window.SillyTavern?.getContext?.()
                ?.callGenericPopup?.(`删除声线「${profile.name}」？`, window.POPUP_TYPE?.CONFIRM)
                ?? window.confirm(`删除声线「${profile.name}」？`);
            if (!confirmed) { return; }
            this.store.remove(id);
            this._save();
            this._refreshVoiceUi();
            $('#breeze2_editor').attr('hidden', '');
        });
        $('#breeze2_voice_export').on('click', () => {
            const blob = new Blob([this.store.exportJson()], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'breeze2-voices.json';
            a.click();
            URL.revokeObjectURL(a.href);
        });
        $('#breeze2_voice_import').on('click', () => $('#breeze2_import_file').trigger('click'));
        $('#breeze2_import_file').on('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) { return; }
            try {
                const { imported } = this.store.importJson(await file.text());
                this._save();
                this._refreshVoiceUi();
                toastr.success(`已导入 ${imported} 条声线`);
            } catch (err) {
                toastr.error(`导入失败：${err?.message ?? err}`);
            } finally {
                e.target.value = '';
            }
        });

        // 编辑器
        $('#breeze2_v_mode').on('change', () => this._toggleModeBoxes());
        $('#breeze2_v_file').on('change', (e) => this._onAudioPicked(e));
        $('#breeze2_v_save').on('click', () => this._saveEditor());
        $('#breeze2_v_cancel').on('click', () => $('#breeze2_editor').attr('hidden', ''));
    }

    async _checkHealth(manual = false) {
        const $ = window.jQuery;
        $('#breeze2_status').text('检测中…');
        const health = await this.client.health();
        if (health.ok) {
            $('#breeze2_status').text('✅ 引擎在线（24kHz 就绪）').removeClass('breeze2-bad');
        } else if (health.loading) {
            $('#breeze2_status').text('⏳ 引擎加载中（模型 warmup，请稍候）').removeClass('breeze2-bad');
        } else {
            $('#breeze2_status').text(`❌ ${health.error}`).addClass('breeze2-bad');
            if (manual) { toastr.error(health.error ?? '引擎不可用'); }
        }
    }

    _refreshVoiceUi() {
        const $ = window.jQuery;
        const current = String($('#breeze2_voice_list').val() ?? '');
        const options = this.store.all()
            .map((v) => `<option value="${v.id}">${v.name}（${v.mode === 'clone' ? '克隆' : '设计'}）</option>`)
            .join('');
        $('#breeze2_voice_list').html(options);
        if (current && this.store.get(current)) {
            $('#breeze2_voice_list').val(current);
        }
    }

    _fillEditor(blank = false) {
        const $ = window.jQuery;
        const profile = blank
            ? { name: '', mode: 'design', refAudio: null, refText: '', designInstruction: '', baseDirection: '', cfg: 2, seedMode: 'random', seed: 42, lang: 'auto' }
            : (this.store.get(String($('#breeze2_voice_list').val() ?? '')) ?? null);
        if (!profile) { return; }
        this._editingId = blank ? null : profile.id;
        $('#breeze2_v_name').val(profile.name ?? '');
        $('#breeze2_v_mode').val(profile.mode ?? 'design');
        $('#breeze2_v_reftext').val(profile.refText ?? '');
        $('#breeze2_v_design').val(profile.designInstruction ?? '');
        $('#breeze2_v_basedir').val(profile.baseDirection ?? '');
        $('#breeze2_v_cfg').val(profile.cfg ?? 2);
        $('#breeze2_v_seedmode').val(profile.seedMode ?? 'random');
        $('#breeze2_v_seed').val(profile.seed ?? 42);
        $('#breeze2_v_lang').val(profile.lang ?? 'auto');
        this._pendingAudio = profile.refAudio ?? null;
        $('#breeze2_v_audio_info').text(profile.refAudio ? `已存音频：${profile.refAudio.name}` : '未设置音频');
        this._toggleModeBoxes();
    }

    _toggleModeBoxes() {
        const $ = window.jQuery;
        const isClone = $('#breeze2_v_mode').val() === 'clone';
        $('#breeze2_v_clone_box').toggle(isClone);
        $('#breeze2_v_design_box').toggle(!isClone);
    }

    _onAudioPicked(e) {
        const file = e.target.files?.[0];
        if (!file) { return; }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result ?? '');
            this._pendingAudio = {
                name: file.name,
                mime: file.type || 'audio/wav',
                data: dataUrl.slice(dataUrl.indexOf(',') + 1),
            };
            // 估算时长，超长提示（长参考会挤占 2048 帧上下文：12.5 帧/秒）
            const audio = new Audio();
            audio.preload = 'metadata';
            audio.src = dataUrl;
            audio.onloadedmetadata = () => {
                const sec = Math.round(audio.duration || 0);
                $('#breeze2_v_audio_info').text(
                    `已选择：${file.name}（约 ${sec}s）` + (sec > 30 ? ' ⚠️ 建议裁剪到 30 秒以内' : ''));
            };
        };
        reader.readAsDataURL(file);
    }

    async _saveEditor() {
        const $ = window.jQuery;
        const val = (id) => String($(`#${id}`).val() ?? '').trim();
        const mode = val('breeze2_v_mode');
        const profile = this._editingId ? this.store.get(this._editingId) : null;
        const base = profile ?? { id: null };

        if (mode === 'clone' && !(this._pendingAudio?.data)) {
            toastr.error('克隆模式需要先选择参考音频');
            return;
        }
        if (mode === 'clone' && !val('breeze2_v_reftext')) {
            toastr.error('克隆模式需要填写参考音频的精确文字稿');
            return;
        }
        if (mode === 'design' && !val('breeze2_v_design')) {
            toastr.error('设计模式需要填写音色描述');
            return;
        }

        this.store.save({
            ...base,
            name: val('breeze2_v_name') || base.name,
            mode,
            refAudio: mode === 'clone' ? this._pendingAudio : null,
            refText: mode === 'clone' ? val('breeze2_v_reftext') : '',
            designInstruction: mode === 'design' ? val('breeze2_v_design') : '',
            baseDirection: val('breeze2_v_basedir'),
            cfg: Math.min(8, Math.max(0.5, Number(val('breeze2_v_cfg')) || 2)),
            seedMode: val('breeze2_v_seedmode') === 'fixed' ? 'fixed' : 'random',
            seed: Number(val('breeze2_v_seed')) || 42,
            lang: val('breeze2_v_lang') || 'auto',
        });
        this._save();
        this._refreshVoiceUi();
        $('#breeze2_editor').attr('hidden', '');
        toastr.success('声线已保存');
    }
}
