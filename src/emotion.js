// 情绪引擎 v2：学习 TTS Router 的快速打标经验。
// 情绪体系：SFW 六种（喜怒哀乐着急平静）+ NSFW 五段（挑逗→渐入佳境→激情互动→
// 高潮迭起→缠绵悱恻，按情节先后）。打标输出一个数字，max_tokens 极小 → 单条 ~0.2s。
// 后端：独立打标 API（OpenAI 兼容，推荐）/ SillyTavern 当前 LLM / 关闭（仅规则）。
// 不直接 import SillyTavern（ctx 注入），可在 node 下测试。

import { splitSentences, hashText, detectLang } from './text.js';

/** 情绪枚举（序号即打标输出的数字，1-based） */
export const EMOTION_LIST = [
    { key: '喜', cat: 'sfw' },
    { key: '怒', cat: 'sfw' },
    { key: '哀', cat: 'sfw' },
    { key: '乐', cat: 'sfw' },
    { key: '着急', cat: 'sfw' },
    { key: '平静', cat: 'sfw' },
    { key: '挑逗', cat: 'nsfw' },
    { key: '渐入佳境', cat: 'nsfw' },
    { key: '激情互动', cat: 'nsfw' },
    { key: '高潮迭起', cat: 'nsfw' },
    { key: '缠绵悱恻', cat: 'nsfw' },
];

/** 情绪 → 朗读方式（编译进 Breeze 导演指令；描述刻意克制，避免"做作"） */
export const DEFAULT_DELIVERY = {
    zh: {
        喜: '语气轻快，带着笑意',
        怒: '语气冷硬，压着火气',
        哀: '声音低哑，语速放缓',
        乐: '轻松愉悦，带笑意',
        着急: '语速加快，气息变急',
        平静: '语气平稳自然',
        挑逗: '压低声音，带着笑意，语气暧昧',
        渐入佳境: '气息渐重，声音发软',
        激情互动: '气息急促，声音断续发颤',
        高潮迭起: '声音高亢颤抖，气息紊乱',
        缠绵悱恻: '声音轻绵乏力，语速极慢，带着餍足的倦意',
    },
};

export const DEFAULT_PROMPT_TEMPLATE = `你是广播剧配音导演。根据聊天上下文，为角色台词选择朗读情绪。
只输出一个数字，对应关系：
1=喜 2=怒 3=哀 4=乐 5=着急 6=平静（普通场景）
7=挑逗 8=渐入佳境 9=激情互动 10=高潮迭起 11=缠绵悱恻（成人亲密场景，按情节先后递进）
判断要点：
- 多句台词逐句给数字，按顺序输出，不要分隔符
- 引号里的话若是引用、强调、拟声而非说话，选 6
- 成人向内容照常判断，不要回避
【聊天上下文】
{context}
【台词】
{lines}

只输出数字。`;

/** 强度 → CFG 映射（仅克隆模式） */
export const DEFAULT_INTENSITY_CFG = { 1: 2.0, 2: 3.0, 3: 4.0 };

/** 标点规则兜底（首块低延迟路径 / LLM 关闭时） */
export function ruleAnalyze(text) {
    const s = String(text ?? '');
    if (/[！!]{2,}/.test(s)) { return { emotion: '怒', intensity: 3 }; }
    if (/[！!]/.test(s)) { return { emotion: '怒', intensity: 2 }; }
    if (/[？?]{2,}/.test(s)) { return { emotion: '着急', intensity: 2 }; }
    if (/…|。{2,}/.test(s)) { return { emotion: '哀', intensity: 1 }; }
    return { emotion: '平静', intensity: 1 };
}

function digitsOf(text) {
    return [...String(text ?? '').matchAll(/\d/g)].map((m) => Number(m[0]));
}

export class EmotionEngine {
    /**
     * @param {object} settings 引用 provider.settings（emotionEnabled / llmBackend /
     *   taggerUrl / taggerModel / taggerKey / taggerTimeout / promptTemplate /
     *   intensityCfg / ruleFallback / delivery）
     * @param {object|null} ctx SillyTavern getContext()（'st' 后端用）
     */
    constructor(settings, ctx = null) {
        this.settings = settings;
        this.ctx = ctx;
        this.cache = new Map();    // hash(句子) → {emotion, intensity}
        this.inflight = new Map();
        this.failedUntil = 0;      // 连续失败后的冷却（熔断）
        this.MAX_CACHE = 400;
    }

    setContext(ctx) {
        this.ctx = ctx;
    }

    get delivery() {
        const raw = this.settings.delivery ?? DEFAULT_DELIVERY;
        return { zh: raw.zh ?? DEFAULT_DELIVERY.zh, en: raw.en ?? raw.zh ?? DEFAULT_DELIVERY.zh };
    }

    _cachePut(key, value) {
        if (this.cache.size >= this.MAX_CACHE) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, { ...value, ts: Date.now() });
    }

    invalidateMessage(messageText) {
        for (const sentence of splitSentences(String(messageText ?? ''))) {
            this.cache.delete(hashText(sentence));
        }
    }

    clearCache() {
        this.cache.clear();
        this.inflight.clear();
    }

    _recentContext() {
        try {
            return (this.ctx?.chat ?? []).slice(-6)
                .map((m) => `${m?.is_user ? 'User' : (m?.name ?? 'Char')}: ${String(m?.mes ?? '').slice(0, 150)}`);
        } catch {
            return [];
        }
    }

    /** 调用打标后端，返回纯文本 */
    async _callLLM(prompt, maxTokens) {
        const backend = this.settings.llmBackend ?? 'api';
        if (backend === 'off') { throw new Error('打标已关闭'); }
        if (backend === 'api') {
            const base = String(this.settings.taggerUrl ?? '').replace(/\/+$/, '');
            if (!base) { throw new Error('未配置打标 API 地址'); }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), (Number(this.settings.taggerTimeout) || 12) * 1000);
            try {
                const res = await fetch(`${base}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(this.settings.taggerKey ? { Authorization: `Bearer ${this.settings.taggerKey}` } : {}),
                    },
                    body: JSON.stringify({
                        model: this.settings.taggerModel || 'hy-mt2-7b',
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: maxTokens,
                        temperature: 0,
                        reasoning_effort: 'none', // Router 经验：推理模型要显式关思考；不支持的 server 会忽略
                    }),
                    signal: ctrl.signal,
                });
                if (!res.ok) { throw new Error(`打标 API HTTP ${res.status}`); }
                const d = await res.json();
                return d?.choices?.[0]?.message?.content ?? '';
            } finally {
                clearTimeout(timer);
            }
        }
        // 'st'：SillyTavern 当前 LLM
        const ctx = this.ctx;
        if (!ctx || typeof ctx.generateQuietPrompt !== 'function') { throw new Error('ST LLM 不可用'); }
        return await ctx.generateQuietPrompt({
            quietPrompt: prompt, quietToLoud: true, skipWIAN: true, responseLength: 128,
        });
    }

    /**
     * 批量打标（句级缓存）。失败静默 + 熔断 60s。
     * @returns {Promise<Object>} 句 → 结果
     */
    async analyzeBatch(sentences, contextLines = []) {
        if (!sentences.length) { return {}; }
        const need = sentences.filter((s) => !this.cache.has(hashText(s)));
        if (!need.length) {
            return Object.fromEntries(sentences.map((s) => [s, this.cache.get(hashText(s))]));
        }
        const template = this.settings.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
        const prompt = template
            .replace('{context}', contextLines.slice(-6).join('\n').slice(-1200) || '（无）')
            .replace('{lines}', need.map((s, i) => `${i + 1}. ${s}`).join('\n'));
        const key = `batch:${hashText(prompt)}`;
        if (this.inflight.has(key)) {
            await this.inflight.get(key);
        } else {
            const p = (async () => {
                try {
                    if (Date.now() < this.failedUntil) { return; }
                    const digits = digitsOf(await this._callLLM(prompt, 8 + 8 * need.length));
                    digits.forEach((num, idx) => {
                        if (idx >= need.length) { return; }
                        const emotion = EMOTION_LIST[num - 1];
                        if (!emotion) { return; }
                        this._cachePut(hashText(need[idx]), { emotion: emotion.key, intensity: 2 });
                    });
                    this.failedUntil = 0;
                } catch (err) {
                    console.warn('[BreezeTTS2] 情绪打标失败，60s 内走规则:', err?.message ?? err);
                    this.failedUntil = Date.now() + 60_000;
                } finally {
                    this.inflight.delete(key);
                }
            })();
            this.inflight.set(key, p);
            await p;
        }
        return Object.fromEntries(sentences.map((s) => [s, this.cache.get(hashText(s)) ?? null]));
    }

    _ruleResult(text) {
        const base = ruleAnalyze(text);
        return { ...base, byRule: true };
    }

    /**
     * 取一个合成块的情绪：句级缓存命中即合并；首块可 skipLLM 立即走规则。
     */
    async resolveForChunk(chunkText, { skipLLM = false } = {}) {
        const sentences = splitSentences(chunkText);
        if (!sentences.length) { sentences.push(chunkText); }
        const missing = sentences.filter((s) => !this.cache.has(hashText(s)));
        if (missing.length) {
            if (skipLLM || !this.settings.emotionEnabled || this.settings.llmBackend === 'off'
                || (this.settings.llmBackend === 'st' && !this.ctx) || Date.now() < this.failedUntil) {
                return this._ruleResult(chunkText);
            }
            await this.analyzeBatch(missing, this._recentContext());
        }
        const merged = this._mergeResults(
            sentences.map((s) => this.cache.get(hashText(s))).filter(Boolean),
        );
        if (merged) { return merged; }
        return this._ruleResult(chunkText);
    }

    /** 多句合并：情绪取第一个非平静的，强度取最大 */
    _mergeResults(results) {
        if (!results.length) { return null; }
        let emotion = null;
        let intensity = 1;
        let byRule = false;
        for (const r of results) {
            if (!r) { continue; }
            if (r.byRule) { byRule = true; }
            if (emotion === null && r.emotion && r.emotion !== '平静') { emotion = r.emotion; }
            intensity = Math.max(intensity, Number(r.intensity) || 1);
        }
        if (emotion === null) { emotion = results[0]?.emotion ?? '平静'; }
        return { emotion, intensity, byRule };
    }

    /** 情绪 → 朗读方式描述 */
    deliveryFor(emotion) {
        return this.delivery.zh[emotion] ?? '';
    }

    /** 把情绪结果编译进导演指令（平静 = 不叠加） */
    compileInstruction(baseInstruction, result) {
        if (!result || !result.emotion || result.emotion === '平静') { return baseInstruction || ''; }
        const desc = this.deliveryFor(result.emotion);
        if (!desc) { return baseInstruction || ''; }
        return baseInstruction ? `${baseInstruction}。本段：${desc}。` : `本段：${desc}。`;
    }

    /** 强度 → CFG（克隆模式用） */
    cfgForIntensity(intensity) {
        const map = this.settings.intensityCfg ?? DEFAULT_INTENSITY_CFG;
        return Number(map[intensity] ?? map[1] ?? 2);
    }
}
