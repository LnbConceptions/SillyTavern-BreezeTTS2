// 情绪引擎：把台词变成 Breeze TTS 2 的导演指令。
// 三层：LLM 结构化分析（主）→ 句级缓存 → 标点规则兜底。
// 不直接 import SillyTavern，构造时注入 ctx（getContext() 返回值），便于测试。

import { splitSentences, hashText, detectLang } from './text.js';

/** 情绪词典：情绪名 → 该情绪的中文/英文朗读方式描述（送入 <ins_bos> 指令段）。
 *  可在设置界面整体编辑（JSON）。默认值覆盖日常 RP 与成人向语气。 */
export const DEFAULT_LEXICON = {
    zh: {
        中性: '',
        开心: '声音明亮轻快，带笑意，语速稍快',
        温柔: '声音放软放轻，气息温和，语速缓慢亲切',
        愤怒: '声音压低发紧，咬字用力，语速加快带压迫感',
        悲伤: '声音发哑低沉，气息不稳，语速很慢，句尾下沉',
        恐惧: '声音发颤，气息急促，压着嗓子，语速忽快忽慢',
        惊讶: '音调突然拔高，气息一滞，语速偏快',
        疑问: '句尾上扬，语气试探，带着不确定',
        嘲讽: '尾音上挑带冷笑，语速慵懒，字间留有讥诮的停顿',
        冷淡: '语调平直疏离，几乎无起伏，语速慢',
        羞涩: '声音小而发虚，气息短促，偶尔卡顿，像藏在喉咙里',
        哭泣: '带着哭腔，鼻音重，语句断续，气息抽噎',
        疲惫: '声音低哑松散，气不足，语速拖沓',
        醉酒: '舌头发软含糊，语速黏滞，偶尔失焦轻笑',
        气声: '全程用气声说话，唇齿音明显，像贴着耳边',
        轻喘: '语句间夹杂轻浅的喘息，声音发软发飘，气息不稳',
        挑逗: '压低声音带笑，尾音拖长勾人，语速故意放慢',
        亢奋: '声音发紧发亮，气息急促上扬，节奏急促',
        失神: '声音空洞涣散，轻飘飘的，反应慢半拍',
        命令: '声音沉稳有力，字字清晰，不容置疑',
        哀求: '声音软下来带着颤，尾音委屈下坠，近乎耳语',
        叙述: '平稳的中性旁白语气，咬字清晰，节奏从容',
    },
    en: {
        neutral: '',
        happy: 'bright and cheerful voice with a smile, slightly faster pace',
        gentle: 'soft, warm and gentle voice, slow intimate pace',
        angry: 'low tense voice, clipped words, pressing fast pace',
        sad: 'hoarse low voice, unsteady breath, very slow pace with sinking endings',
        fear: 'trembling voice, hurried breath, wavering pace',
        surprised: 'sudden pitch jump, caught breath, quick pace',
        teasing: 'lowered voice with a smile, elongated drawn-out endings, deliberately slow',
        breathy: 'whispered breathy delivery, soft and close to the ear',
        moan: 'soft unsteady voice with light breathy gasps between words',
        pleading: 'soft trembling near-whisper, plaintive falling endings',
        commanding: 'firm steady voice, crisp words, leaving no room for doubt',
        narration: 'steady neutral narrator tone, clear articulation, relaxed pace',
    },
};

export const DEFAULT_PROMPT_TEMPLATE = `你是广播剧配音导演。根据聊天上下文，为下面的每段台词标注朗读方式。
要求：
- emotion 必须从这些选项中选择：{enum}
- intensity 为 1~3 的整数，表示情绪强度（3 最强，日常叙述用 1）
- event 只能是 null 或：{events}（仅当该段台词本身包含这个动作时才选，不要硬加）
- 涉及亲密、成人或激烈冲突的内容，同样如实标注朗读语气，不要回避或拒绝
- 只输出 JSON，不要输出任何其他文字，格式：
{"lines":[{"i":0,"emotion":"开心","intensity":2,"event":null}]}

【聊天上下文】
{context}

【待标注台词（按段编号）】
{lines}`;

/** 强度 → CFG 映射（仅克隆模式；设计模式始终用声线自身的 cfg 保证音色贴合描述） */
export const DEFAULT_INTENSITY_CFG = { 1: 2.0, 2: 3.0, 3: 4.0 };

function extractJson(text) {
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) { return null; }
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

/** 标点规则兜底分析 */
export function ruleAnalyze(text) {
    const s = String(text ?? '');
    if (/[！!]{2,}/.test(s)) { return { emotion: null, intensity: 3, event: null }; }
    if (/[？?]{2,}/.test(s)) { return { emotion: null, intensity: 2, event: null }; }
    if (/[！!]/.test(s)) { return { emotion: null, intensity: 2, event: null }; }
    if (/…|。{2,}/.test(s)) { return { emotion: null, intensity: 1, event: null }; }
    return { emotion: null, intensity: 1, event: null };
}

export class EmotionEngine {
    /**
     * @param {object} settings 引用 provider.settings（含 enabled/lexicon/promptTemplate/intensityCfg/ruleFallback）
     * @param {object|null} ctx SillyTavern getContext() 返回值；null 时仅规则兜底
     */
    constructor(settings, ctx = null) {
        this.settings = settings; // 直接引用，provider 改设置后立即生效
        this.ctx = ctx;
        this.cache = new Map();   // hash(句子) → {emotion,intensity,event,ts}
        this.inflight = new Map(); // hash → Promise
        this.failedUntil = 0;     // LLM 连续失败后的冷却
        this.MAX_CACHE = 400;
    }

    setContext(ctx) {
        this.ctx = ctx;
    }

    get lexicon() {
        const raw = this.settings.lexicon ?? DEFAULT_LEXICON;
        return { zh: raw.zh ?? DEFAULT_LEXICON.zh, en: raw.en ?? DEFAULT_LEXICON.en };
    }

    _cachePut(key, value) {
        if (this.cache.size >= this.MAX_CACHE) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, { ...value, ts: Date.now() });
    }

    invalidateMessage(messageText) {
        // 按句失效（消息编辑/重roll后由文本变化自然失效，这里做主动清理）
        for (const sentence of splitSentences(String(messageText ?? ''))) {
            this.cache.delete(hashText(sentence));
        }
    }

    clearCache() {
        this.cache.clear();
        this.inflight.clear();
    }

    /** 单次 LLM 调用（带 JSON schema，失败降级自由文本） */
    async _llmAnalyze(prompt, enumNames, events) {
        const ctx = this.ctx;
        if (!ctx || typeof ctx.generateQuietPrompt !== 'function') {
            throw new Error('no llm context');
        }
        const schema = {
            type: 'object',
            properties: {
                lines: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            i: { type: 'integer' },
                            emotion: { type: 'string', enum: enumNames },
                            intensity: { type: 'integer', enum: [1, 2, 3] },
                            event: { type: ['string', 'null'], enum: [...events, null] },
                        },
                        required: ['i', 'emotion', 'intensity', 'event'],
                    },
                },
            },
            required: ['lines'],
        };
        try {
            return extractJson(await ctx.generateQuietPrompt({
                quietPrompt: prompt,
                quietToLoud: true,
                skipWIAN: true,
                responseLength: 900,
                jsonSchema: schema,
            }));
        } catch (err) {
            // 旧版 ST 不支持 jsonSchema 参数 → 退化为自由文本
            if (err && /jsonSchema/i.test(String(err?.message ?? err))) {
                return extractJson(await ctx.generateQuietPrompt({
                    quietPrompt: prompt, quietToLoud: true, skipWIAN: true, responseLength: 900,
                }));
            }
            throw err;
        }
    }

    /**
     * 对多句台词做一次批量分析（句 → 结果）。失败时静默返回 {}。
     * @param {string[]} sentences
     * @param {string[]} contextLines 上下文行（"角色名: 文本"）
     */
    async analyzeBatch(sentences, contextLines = []) {
        if (!sentences.length) { return {}; }
        const lang = detectLang(sentences.join(''));
        const lex = this.lexicon[lang] ?? this.lexicon.zh;
        const enumNames = Object.keys(lex);
        const events = lang === 'zh'
            ? ['[笑]', '[咳嗽]', '[清嗓子]', '[叹气]']
            : ['(laugh)', '(cough)', '(clears throat)', '(sigh)'];

        const need = sentences.filter((s) => !this.cache.has(hashText(s)));
        if (!need.length) {
            return Object.fromEntries(sentences.map((s) => [s, this.cache.get(hashText(s))]));
        }

        const template = this.settings.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
        const prompt = template
            .replace('{enum}', enumNames.join('、'))
            .replace('{events}', events.join(' / '))
            .replace('{context}', contextLines.slice(-6).join('\n').slice(-1200) || '（无）')
            .replace('{lines}', need.map((s, i) => `${i}: ${s}`).join('\n'));

        const key = `batch:${hashText(prompt)}`;
        if (this.inflight.has(key)) {
            await this.inflight.get(key);
        } else {
            const p = (async () => {
                try {
                    if (Date.now() < this.failedUntil) { return; }
                    const parsed = await this._llmAnalyze(prompt, enumNames, events);
                    const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
                    for (const line of lines) {
                        const idx = Number(line?.i);
                        if (!Number.isInteger(idx) || idx < 0 || idx >= need.length) { continue; }
                        const emotion = enumNames.includes(line.emotion) ? line.emotion
                            : (lex[line.emotion] !== undefined ? line.emotion : null);
                        if (!emotion) { continue; }
                        const intensity = [1, 2, 3].includes(Number(line.intensity)) ? Number(line.intensity) : 1;
                        const event = events.includes(line.event) ? line.event : null;
                        this._cachePut(hashText(need[idx]), { emotion, intensity, event });
                    }
                    this.failedUntil = 0;
                } catch (err) {
                    console.warn('[BreezeTTS2] 情绪分析失败，60s 内走规则兜底:', err?.message ?? err);
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

    /** 兜底规则（永不失败） */
    _ruleResult(text, lang) {
        const base = ruleAnalyze(text);
        const fallback = Object.keys(this.lexicon[lang] ?? this.lexicon.zh)[0];
        return {
            emotion: base.emotion ?? fallback,
            intensity: base.intensity,
            event: null,
            byRule: true,
        };
    }

    /**
     * 取一个合成块的情绪标注：先查缓存（预分析命中），未命中现场补一次单句分析，
     * LLM 不可用/失败则规则兜底。永不 throw。
     */
    async resolveForChunk(chunkText) {
        const lang = detectLang(chunkText);
        const key = hashText(chunkText);
        const cached = this.cache.get(key);
        if (cached) { return cached; }

        if (this.settings.emotionEnabled && this.ctx && Date.now() >= this.failedUntil) {
            const single = chunkText.length > 160 ? [chunkText.slice(0, 160)] : [chunkText];
            try {
                const res = await this.analyzeBatch(single, this._recentContext());
                if (res[single[0]]) { return res[single[0]]; }
            } catch { /* 落入规则 */ }
        }
        if (this.settings.ruleFallback !== false) {
            return this._ruleResult(chunkText, lang);
        }
        return { emotion: null, intensity: 1, event: null };
    }

    _recentContext() {
        try {
            return (this.ctx?.chat ?? []).slice(-6)
                .map((m) => `${m?.is_user ? 'User' : (m?.name ?? 'Char')}: ${String(m?.mes ?? '').slice(0, 150)}`);
        } catch {
            return [];
        }
    }

    /** 把情绪结果编译进导演指令 */
    compileInstruction(baseInstruction, result, lang) {
        if (!result || !result.emotion) {
            return baseInstruction || '';
        }
        const lex = this.lexicon[lang] ?? this.lexicon.zh;
        const desc = lex[result.emotion];
        if (!desc) { return baseInstruction || ''; }
        if (lang === 'en') {
            return baseInstruction ? `${baseInstruction}. ${desc}` : desc;
        }
        return baseInstruction ? `${baseInstruction}。本段：${desc}。` : `本段：${desc}。`;
    }

    /** 强度 → CFG（克隆模式用） */
    cfgForIntensity(intensity) {
        const map = this.settings.intensityCfg ?? DEFAULT_INTENSITY_CFG;
        return Number(map[intensity] ?? map[1] ?? 2);
    }

    /** 情绪附带的声音事件标签（已校验白名单） */
    eventTag(result, lang) {
        const events = lang === 'zh'
            ? ['[笑]', '[咳嗽]', '[清嗓子]', '[叹气]']
            : ['(laugh)', '(cough)', '(clears throat)', '(sigh)'];
        return result?.event && events.includes(result.event) ? result.event : null;
    }
}
