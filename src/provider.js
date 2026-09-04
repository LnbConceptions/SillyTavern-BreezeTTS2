// Breeze TTS 2 Provider — 实现 SillyTavern TTS 扩展的 provider 契约。
// 核心链路：generateTts(text, voiceId, voiceMapKey) → 清洗/分块 → 情绪指令编译 →
// 逐块请求引擎 → WAV data URL 逐块 yield（ST 核心边收边播）。
// 仅本文件 import SillyTavern（getContext），其余模块保持可单测。

import { getContext } from '/scripts/extensions.js';

import { BreezeEngineClient, makeSilentWavDataUrl, pcm16ToWavDataUrl } from './engine-client.js';
import { stripForTts, splitIntoChunks, splitSentences, segmentMessage, quoteHeuristic, detectLang, hashText } from './text.js';
import { VoiceStore, MUTE_VOICE, defaultVoiceProfiles } from './voices.js';
import { EmotionEngine, EMOTION_LIST, DEFAULT_DELIVERY, DEFAULT_PROMPT_TEMPLATE, DEFAULT_INTENSITY_CFG } from './emotion.js';

const PROVIDER_NAME = 'Breeze TTS 2';
const REF_MAX_SECONDS = 30;

/** 解码上传的音频并裁剪到 maxSeconds（24kHz 单声道 WAV）。浏览器环境专用。 */
async function decodeAndTrimRef(dataUrl, maxSeconds = REF_MAX_SECONDS) {
    const res = await fetch(dataUrl);
    const arrayBuffer = await res.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const decodeCtx = new AC();
    let audioBuf;
    try {
        audioBuf = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
        decodeCtx.close?.().catch?.(() => {});
    }
    if (audioBuf.duration <= maxSeconds + 0.5) {
        return { dataUrl, duration: audioBuf.duration, trimmed: false };
    }
    const offline = new OfflineAudioContext(1, Math.floor(24000 * maxSeconds), 24000);
    const srcNode = offline.createBufferSource();
    srcNode.buffer = audioBuf;
    srcNode.connect(offline.destination);
    srcNode.start(0);
    const rendered = await offline.startRendering();
    const ch = rendered.getChannelData(0);
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return {
        dataUrl: pcm16ToWavDataUrl(new Uint8Array(pcm.buffer)),
        duration: maxSeconds,
        trimmed: true,
    };
}

const DEFAULT_SETTINGS = () => ({
    endpoint: 'http://127.0.0.1:9897',
    maxChunkChars: 120,
    pieceSeconds: 4,
    retries: 4,
    debug: false,
    speedRate: 1.15,           // 播放倍速（>0 时接管 ST 的 playback_rate，变速不变调）
    // 旁白/台词分层（Router 经验）：旁白平铺直叙不打标
    narrationVoiceId: '',      // 空 = 跟随角色声线
    // 情绪引擎
    emotionEnabled: true,
    llmBackend: 'api',         // 'api' 独立打标 API | 'st' SillyTavern 当前 LLM | 'off' 仅规则
    taggerUrl: 'https://llm.ioioioioio.com:1120/v1',
    taggerModel: 'hy-mt2-7b',
    taggerKey: '',
    taggerTimeout: 12,
    ruleFallback: true,
    delivery: structuredClone(DEFAULT_DELIVERY),
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    intensityCfg: { ...DEFAULT_INTENSITY_CFG },
    // 文本清洗
    stripAsterisks: true,
    // 声线
    voices: defaultVoiceProfiles(),
});

function segmentTypeFromKey(voiceMapKey) {
    const key = String(voiceMapKey ?? '');
    if (!key) { return null; }                    // 单声线模式：由插件自行切分
    if (key.includes('Quotes')) { return 'dialogue'; }
    if (key.includes('asterisks')) { return 'inner'; }  // ST 的 *动作* 段按内心独白处理
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
                <div class="breeze2-row">
                    <select id="breeze2_voice_list" class="breeze2-grow"></select>
                    <a id="breeze2_voice_preview" class="menu_button"><i class="fa-solid fa-play"></i><span>预览</span></a>
                </div>
                <div class="breeze2-row">
                    <a id="breeze2_voice_add" class="menu_button"><i class="fa-solid fa-plus"></i><span>新建</span></a>
                    <a id="breeze2_voice_del" class="menu_button"><i class="fa-solid fa-trash"></i><span>删除</span></a>
                    <a id="breeze2_voice_export" class="menu_button"><i class="fa-solid fa-download"></i><span>导出</span></a>
                    <a id="breeze2_voice_import" class="menu_button"><i class="fa-solid fa-upload"></i><span>导入</span></a>
                    <input id="breeze2_import_file" type="file" accept="application/json" hidden />
                </div>

                <div id="breeze2_editor" class="breeze2-editor" hidden>
                    <div class="breeze2-grid3">
                        <label>声线名称<input id="breeze2_v_name" type="text" class="text_input" /></label>
                        <label>模式
                            <select id="breeze2_v_mode">
                                <option value="design">设计（文字描述音色）</option>
                                <option value="clone">克隆（参考音频）</option>
                            </select>
                        </label>
                        <label>语言
                            <select id="breeze2_v_lang">
                                <option value="auto">自动检测</option>
                                <option value="zh">中文</option>
                                <option value="en">English</option>
                            </select>
                        </label>
                    </div>
                    <div id="breeze2_v_clone_box">
                        <label>参考音频（≤30 秒干净人声，超长自动裁剪）
                            <input id="breeze2_v_file" type="file" accept="audio/*" />
                        </label>
                        <div id="breeze2_v_audio_info" class="breeze2-hint">未选择音频</div>
                        <label>参考音频的文字稿（逐字对应，含语气词）
                            <textarea id="breeze2_v_reftext" class="text_input" rows="2"></textarea>
                        </label>
                    </div>
                    <label id="breeze2_v_design_box">音色描述（设计模式）
                        <textarea id="breeze2_v_design" class="text_input" rows="2"></textarea>
                    </label>
                    <label>基础导演指令（克隆模式的默认语气，可留空）
                        <textarea id="breeze2_v_basedir" class="text_input" rows="2"></textarea>
                    </label>
                    <div class="breeze2-grid3">
                        <label>指令强度 CFG<input id="breeze2_v_cfg" type="number" min="0.5" max="8" step="0.5" /></label>
                        <label>Seed 模式
                            <select id="breeze2_v_seedmode">
                                <option value="random">随机</option>
                                <option value="fixed">固定</option>
                            </select>
                        </label>
                        <label>固定 Seed<input id="breeze2_v_seed" type="number" step="1" /></label>
                    </div>
                    <div class="breeze2-row">
                        <a id="breeze2_v_save" class="menu_button"><i class="fa-solid fa-check"></i><span>保存声线</span></a>
                        <a id="breeze2_v_cancel" class="menu_button"><span>取消</span></a>
                    </div>
                </div>

                <label class="breeze2-checkbox">旁白声线：
                    <select id="breeze2_narrvoice" class="breeze2-grow"></select>
                    <span class="breeze2-hint">引号和 **…** 之外的文字用它平读</span>
                </label>
                <div class="breeze2-hint">在 TTS 扩展的「Voice Map」里把角色映射到声线名称；开启多声线后可按 引号台词 / *动作* / 旁白 分别指定。</div>
            </details>

            <details>
                <summary>🎭 情绪打标（SFW 6 态 + NSFW 5 态）</summary>
                <label class="breeze2-checkbox"><input id="breeze2_emotion_enable" type="checkbox" /> 启用台词情绪打标（旁白永远平读，不打标）</label>
                <label>打标后端
                    <select id="breeze2_llm_backend">
                        <option value="api">独立打标 API（OpenAI 兼容，推荐）</option>
                        <option value="st">SillyTavern 当前 LLM</option>
                        <option value="off">关闭（仅标点规则）</option>
                    </select>
                </label>
                <div id="breeze2_api_box">
                    <label>打标 API 地址（OpenAI 兼容，如 https://…/v1）
                        <input id="breeze2_tagger_url" type="text" class="text_input" />
                    </label>
                    <div class="breeze2-grid3">
                        <label>模型<input id="breeze2_tagger_model" type="text" class="text_input" /></label>
                        <label>API 密钥<input id="breeze2_tagger_key" type="password" class="text_input" /></label>
                        <label>超时（秒）<input id="breeze2_tagger_timeout" type="number" min="3" max="60" step="1" /></label>
                    </div>
                </div>
                <label class="breeze2-checkbox"><input id="breeze2_rule_fallback" type="checkbox" /> 打标失败时用标点规则兜底</label>
                <div class="breeze2-grid3">
                    <label>强度1→CFG<input id="breeze2_cfg1" type="number" min="1" max="8" step="0.5" /></label>
                    <label>强度2→CFG<input id="breeze2_cfg2" type="number" min="1" max="8" step="0.5" /></label>
                    <label>强度3→CFG<input id="breeze2_cfg3" type="number" min="1" max="8" step="0.5" /></label>
                </div>
                <label>情绪朗读方式（JSON：情绪名 → 描述）
                    <textarea id="breeze2_lexicon" class="text_input breeze2-mono" rows="10"></textarea>
                </label>
                <label>打标 Prompt 模板（{context} {lines}；输出数字 1-11）
                    <textarea id="breeze2_prompt" class="text_input breeze2-mono" rows="8"></textarea>
                </label>
                <div class="breeze2-inline">
                    <a id="breeze2_apply_prompts" class="menu_button"><span>应用词典/Prompt</span></a>
                    <a id="breeze2_reset_prompts" class="menu_button"><span>恢复默认</span></a>
                    <a id="breeze2_cache_clear" class="menu_button"><span>清空情绪缓存</span></a>
                    <a id="breeze2_tagger_test" class="menu_button"><i class="fa-solid fa-flask"></i><span>测试打标</span></a>
                </div>
                <div class="breeze2-hint">SFW：1喜 2怒 3哀 4乐 5着急 6平静；NSFW：7挑逗 8渐入佳境 9激情互动 10高潮迭起 11缠绵悱恻。</div>
            </details>

            <details>
                <summary>⚙️ 文本与合成</summary>
                <label class="breeze2-checkbox"><input id="breeze2_strip_asterisks" type="checkbox" /> 删除 *动作描写*（未开启多声线时建议开启）</label>
                <div class="breeze2-grid3">
                    <label>单块最大字数<input id="breeze2_maxchunk" type="number" min="40" max="180" step="10" /></label>
                    <label>流式片长（秒）<input id="breeze2_piecesec" type="number" min="1" max="10" step="0.5" /></label>
                    <label>播放倍速（1.15=快15%）<input id="breeze2_speed" type="number" min="0" max="3" step="0.05" /></label>
                    <label>409 重试次数<input id="breeze2_retries" type="number" min="0" max="8" step="1" /></label>
                    <label class="breeze2-checkbox"><input id="breeze2_debug" type="checkbox" /> 调试日志</label>
                </div>
                <div class="breeze2-hint">流式片长越小首声越快（引擎 TTFA≈0.13s，首片 2 秒即出声），但片段接缝更频繁；出现明显停顿感可调大到 5~6。播放倍速对所有情绪/声线统一生效（变速不变调），设 0 则不接管 ST 的播放速度设置。</div>
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
        this.settings.delivery = {
            zh: { ...DEFAULT_DELIVERY.zh, ...(this.settings.delivery?.zh ?? {}) },
        };
        this.settings.intensityCfg = { ...DEFAULT_INTENSITY_CFG, ...(this.settings.intensityCfg ?? {}) };

        // 旧版(v1.2)设置迁移：老词典/老 Prompt(JSON lines 格式)与新版数字协议不兼容
        if (!settings?.delivery && this.settings.promptTemplate.includes('{enum}')) {
            console.info('[BreezeTTS2] 检测到 v1.2 旧版情绪设置，迁移到 11 情绪数字协议');
            this.settings.promptTemplate = DEFAULT_PROMPT_TEMPLATE;
            this.settings.delivery = structuredClone(DEFAULT_DELIVERY);
        }
        this.settings.voices = Array.isArray(this.settings.voices) && this.settings.voices.length
            ? this.settings.voices : defaults.voices;

        this.store = new VoiceStore(this.settings.voices);
        this.client.setEndpoint(this.settings.endpoint);
        this.client.retries = this.settings.retries;
        this.emotion = new EmotionEngine(this.settings, getContext());

        this._bindUi();
        this._wirePreAnalysis();
        this._applySpeedRate();
        this._refreshVoiceUi();
        this._checkHealth();
    }

    /** 把播放倍速写入 ST 核心的 playback_rate（对所有 TTS 音频生效，变速不变调） */
    _applySpeedRate() {
        try {
            const rate = Number(this.settings.speedRate);
            if (!rate || rate <= 0) { return; } // 0 = 不接管
            const ctx = getContext();
            if (ctx?.extensionSettings?.tts) {
                ctx.extensionSettings.tts.playback_rate = rate;
            }
            const $ = window.jQuery;
            if ($ && $('#playback_rate').length) {
                $('#playback_rate').val(rate);
                $('#playback_rate_counter').val(Number(rate).toFixed(2));
            }
            ctx?.saveSettingsDebounced?.();
            if (this.settings.debug) { console.info(`[BreezeTTS2] 播放倍速已应用: ${rate}x`); }
        } catch (err) {
            console.warn('[BreezeTTS2] 应用播放倍速失败:', err?.message ?? err);
        }
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

        const cleaned = stripForTts(inputText, {
            stripAsterisks: false,      // 星号标记保留给 segmentMessage 分层
            stripOoc: true,
            stripUnknownBrackets: true,
        });
        if (!cleaned) { return; }

        // 分层（纯程序判定）：narration/inner 直确定；quote 交 LLM 判定是否台词
        const stType = segmentTypeFromKey(voiceMapKey);
        const segs = voiceMapKey && stType
            ? [{ type: stType, text: cleaned }]
            : segmentMessage(cleaned);
        if (this.settings.debug) {
            console.info(`[BreezeTTS2] 分层: ${segs.map((s) => s.type).join('/')}`, segs);
        }
        if (!segs.length) { return; }

        const narrationProfile = this.store.get(this.settings.narrationVoiceId) ?? profile;

        // 后台预热（不阻塞首块）：① 引号"是否台词"判定 ② 内心想法的情绪打标
        const quotes = segs.filter((s) => s.type === 'quote');
        if (quotes.length && this.settings.emotionEnabled && this.settings.llmBackend !== 'off') {
            this.emotion.analyzeQuotes(quotes, this.emotion._recentContext()).catch(() => {});
        }
        const innerSentences = [...new Set(
            segs.filter((s) => s.type === 'inner').flatMap((s) => splitSentences(s.text)),
        )];
        const missingInner = innerSentences.filter((s) => !this.emotion.cache.has(hashText(s)));
        if (missingInner.length && this.settings.emotionEnabled && this.settings.llmBackend !== 'off') {
            this.emotion.analyzeBatch(missingInner, this.emotion._recentContext()).catch(() => {});
        }

        for (const seg of segs) {
            let segType = seg.type;
            let segText = seg.text;
            let voice = profile;

            // 引号段：程序三态判定优先；只有含糊的短引号才问 LLM
            if (segType === 'quote') {
                const h = quoteHeuristic(segText, seg.before);
                if (h === 'speech') {
                    segType = 'dialogue';
                } else if (h === 'nonspeech') {
                    segType = 'narration';
                } else {
                    const verdict = await this.emotion.resolveQuote(segText);
                    segType = verdict.isSpeech ? 'dialogue' : 'narration';
                }
            }
            if (segType === 'narration') {
                voice = narrationProfile;
                segText = segText.replace(/[*_]+/g, '').trim();
            }
            const chunks = splitIntoChunks(segText, this.settings.maxChunkChars);
            if (!chunks.length) { continue; }
            for (const [i, chunk] of chunks.entries()) {
                // 多块时段首块跳过 LLM 立即出声（后续块用打标结果）；单块则等打标
                const req = await this._buildRequest(chunk, voice, segType, { skipLLM: i === 0 && chunks.length > 1 });
                // 分块级重试：应对反代/网络的瞬断（HTTP2 reset 等）。
                // 已经播出部分片段后失败则不重试（避免整句重复）。
                let attempt = 0;
                for (;;) {
                    let yielded = false;
                    try {
                        for await (const wav of this.client.synthesizeStream(req, this.settings.pieceSeconds, 2)) {
                            yielded = true;
                            yield wav;
                        }
                        break;
                    } catch (err) {
                        attempt++;
                        if (yielded || attempt > 2) { throw err; }
                        console.warn(`[BreezeTTS2] 块合成失败，重试 ${attempt}/2:`, err?.message ?? err);
                        await new Promise((r) => setTimeout(r, 800 * attempt));
                    }
                }
            }
        }
    }

    // segType: 'dialogue' | 'inner' | 'narration'
    async _buildRequest(chunk, profile, segType = 'dialogue', { skipLLM = false } = {}) {
        const lang = profile.lang && profile.lang !== 'auto' ? profile.lang : detectLang(chunk);

        let instruction = profile.mode === 'design'
            ? String(profile.designInstruction ?? '').trim()
            : String(profile.baseDirection ?? '').trim();
        let cfg = profile.mode === 'design'
            ? Math.max(Number(profile.cfg) || 4, 4)   // 设计模式保证音色贴合描述
            : (Number(profile.cfg) || 2);

        let text = chunk;
        const isNarration = segType === 'narration';

        if (!isNarration) {
            // 台词/内心独白：情绪打标（首块可跳过 LLM 立即出声）
            if (this.settings.emotionEnabled) {
                const result = await this.emotion.resolveForChunk(chunk, { skipLLM });
                if (result) {
                    instruction = this.emotion.compileInstruction(instruction, result);
                    if (profile.mode !== 'design') {
                        cfg = Math.max(cfg, this.emotion.cfgForIntensity(result.intensity));
                    }
                }
            }
            if (segType === 'inner') {
                instruction += lang === 'en'
                    ? ' Spoken softly like an inner monologue.'
                    : '。以内心的声音轻声自语';
            }
        }
        // 旁白：不打标不叠加情绪，声线自身描述即"平铺直叙"
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
                    const cleaned = stripForTts(msg.mes, { stripAsterisks: false, stripOoc: true });
                    const segs = segmentMessage(cleaned);
                    if (!segs.length || !this.settings.emotionEnabled
                        || this.settings.llmBackend === 'off') { return; }
                    const contextLines = this.emotion._recentContext();
                    // ① 含糊引号"是否台词"判定 ② 内心想法情绪打标 —— 都在后台跑
                    const quotes = segs.filter((s) => s.type === 'quote'
                        && quoteHeuristic(s.text, s.before) === 'ambiguous');
                    if (quotes.length) {
                        this.emotion.analyzeQuotes(quotes, contextLines).catch(() => {});
                    }
                    const innerSentences = [...new Set(
                        segs.filter((s) => s.type === 'inner').flatMap((s) => splitSentences(s.text)),
                    )];
                    const missing = innerSentences.filter((s) => !this.emotion.cache.has(hashText(s)));
                    if (missing.length) {
                        this.emotion.analyzeBatch(missing, contextLines).catch(() => {});
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
        $('#breeze2_speed').val(this.settings.speedRate).on('change', (e) => {
            this.settings.speedRate = Math.min(3, Math.max(0, Number(e.target.value) || 0));
            this._save();
            this._applySpeedRate();
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
        $('#breeze2_llm_backend').val(this.settings.llmBackend).on('change', (e) => {
            this.settings.llmBackend = String(e.target.value); this._save();
        });
        $('#breeze2_tagger_url').val(this.settings.taggerUrl).on('change', (e) => {
            this.settings.taggerUrl = String(e.target.value ?? '').trim(); this._save();
        });
        $('#breeze2_tagger_model').val(this.settings.taggerModel).on('change', (e) => {
            this.settings.taggerModel = String(e.target.value ?? '').trim(); this._save();
        });
        $('#breeze2_tagger_key').val(this.settings.taggerKey).on('change', (e) => {
            this.settings.taggerKey = String(e.target.value ?? '').trim(); this._save();
        });
        $('#breeze2_tagger_timeout').val(this.settings.taggerTimeout).on('change', (e) => {
            this.settings.taggerTimeout = Math.min(60, Math.max(3, Number(e.target.value) || 12)); this._save();
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
        $('#breeze2_lexicon').val(JSON.stringify(this.settings.delivery, null, 2));
        $('#breeze2_prompt').val(this.settings.promptTemplate);
        $('#breeze2_apply_prompts').on('click', () => {
            try {
                const parsed = JSON.parse(val('breeze2_lexicon'));
                this.settings.delivery = {
                    zh: { ...DEFAULT_DELIVERY.zh, ...(parsed.zh ?? parsed) },
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
            this.settings.delivery = structuredClone(DEFAULT_DELIVERY);
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
        $('#breeze2_tagger_test').on('click', async () => {
            // 用当前填写的连接信息做一次真实打标（NSFW 递进样例，应返回 8=渐入佳境）
            this.settings.llmBackend = String($('#breeze2_llm_backend').val());
            this.settings.taggerUrl = val('breeze2_tagger_url');
            this.settings.taggerModel = val('breeze2_tagger_model');
            this.settings.taggerKey = val('breeze2_tagger_key');
            const prompt = (this.settings.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE)
                .replace('{context}', '（测试）')
                .replace('{lines}', '1. 她贴近他的耳边，压低声音：别急着走，好戏才刚开始。');
            const t0 = performance.now();
            try {
                const out = await this.emotion._callLLM(prompt, 16);
                const ms = (performance.now() - t0).toFixed(0);
                const num = (String(out).match(/\d/g) || [])[0];
                const emo = num ? (EMOTION_LIST[Number(num) - 1]?.key ?? '?') : '（无数字）';
                toastr.success(`打标正常：${ms}ms → "${String(out).trim()}"（${emo}）`);
            } catch (err) {
                toastr.error(`打标测试失败：${err?.message ?? err}`);
            }
        });

        // 声线库
        $('#breeze2_voice_list').on('change', () => this._fillEditor());
        $('#breeze2_narrvoice').on('change', (e) => {
            this.settings.narrationVoiceId = String(e.target.value ?? ''); this._save();
        });
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
        // 旁白声线选择器
        const narr = String(this.settings.narrationVoiceId ?? '');
        const narrOptions = [`<option value="">（跟随角色声线）</option>`]
            .concat(this.store.all().map((v) => `<option value="${v.id}">${v.name}</option>`))
            .join('');
        $('#breeze2_narrvoice').html(narrOptions);
        if (narr && this.store.get(narr)) { $('#breeze2_narrvoice').val(narr); }
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
        reader.onload = async () => {
            const dataUrl = String(reader.result ?? '');
            try {
                const { dataUrl: finalUrl, duration, trimmed } = await decodeAndTrimRef(dataUrl, REF_MAX_SECONDS);
                this._pendingAudio = {
                    name: file.name,
                    mime: 'audio/wav',
                    data: finalUrl.slice(finalUrl.indexOf(',') + 1),
                };
                $('#breeze2_v_audio_info').text(
                    `已选择：${file.name}（${duration.toFixed(1)}s）`
                    + (trimmed ? ' ⚠️ 超长已自动裁剪为前 30 秒' : ''));
            } catch (err) {
                toastr.error(`音频解码失败：${err?.message ?? err}`);
            }
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
