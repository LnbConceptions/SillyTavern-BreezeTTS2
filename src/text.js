// 文本清洗 / 声音事件白名单 / 分句分块。
// 纯函数模块，不依赖 SillyTavern 与浏览器 API，可在 node 下单测。

// Breeze TTS 2 官方支持的内嵌声音事件（README 仅列这 8 个，均为纯文本模式；
// 未知标签会被当作普通文字念出来，因此必须做白名单清洗）。
export const KNOWN_EVENTS = {
    zh: ['[笑]', '[咳嗽]', '[清嗓子]', '[叹气]'],
    en: ['(laugh)', '(cough)', '(clears throat)', '(sigh)'],
};

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function detectLang(text) {
    const sample = String(text ?? '').slice(0, 400);
    if (!sample) { return 'zh'; }
    let cjk = 0;
    let letters = 0;
    for (const ch of sample) {
        if (CJK_RE.test(ch)) { cjk++; }
        else if (/[a-zA-Z]/.test(ch)) { letters++; }
    }
    return cjk * 2 >= letters ? 'zh' : 'en';
}

/**
 * 清洗一段 RP 文本，使其适合直接送入 TTS。
 * @param {string} text 原始文本
 * @param {object} opts
 * @param {boolean} opts.stripAsterisks 删除 *动作描写*（单声线模式建议开）
 * @param {boolean} opts.stripOoc 删除 OOC/旁注（((...))、[[...]]、<think> 等）
 * @param {boolean} opts.stripUnknownBrackets 删除未知的 [..] / (..) 标签（保留白名单事件）
 * @returns {string}
 */
export function stripForTts(text, opts = {}) {
    const {
        stripAsterisks = true,
        stripOoc = true,
        stripUnknownBrackets = true,
    } = opts;
    let s = String(text ?? '');
    if (!s.trim()) { return ''; }

    // 代码块与行内代码（多为指令/链接，念出来是噪音）
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/`([^`]*)`/g, ' ');

    if (stripOoc) {
        // <think>...</think>、HTML 标签、OOC 双括号
        s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
        s = s.replace(/<think>[\s\S]*$/i, ' ');
        s = s.replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ');
        s = s.replace(/\(\([\s\S]*?\)\)/g, ' ');
        s = s.replace(/（（[\s\S]*?））/g, ' ');
        s = s.replace(/\[\[[\s\S]*?\]\]/g, ' ');
    }

    // Markdown 图片 / 链接
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

    // 注意：**…** 是内心独白、单一 *…* 按用户约定归入旁白；
    // 星号标记是否删除由调用方决定（分层切分 segmentMessage 需要它们）。
    if (stripAsterisks) {
        s = s.replace(/\*{1,2}[^*\n]{1,400}\*{1,2}/g, ' ');
        s = s.replace(/_{1,2}[^_\n]{1,400}_{1,2}/g, ' ');
    }

    if (stripUnknownBrackets) {
        // 方括号：仅保留已知中文事件
        s = s.replace(/\[([^\[\]\n]{1,24})\]/g, (m, inner) => {
            const candidate = `[${inner.trim()}]`;
            return KNOWN_EVENTS.zh.includes(candidate) ? candidate : ' ';
        });
        // 圆括号：仅保留已知英文事件
        s = s.replace(/\(([^()\n]{1,40})\)/g, (m, inner) => {
            const candidate = `(${inner.trim().toLowerCase()})`;
            return KNOWN_EVENTS.en.includes(candidate) ? `(${inner.trim()})` : ' ';
        });
    }

    // 破折号/省略号归一，避免 TTS 怪读
    s = s.replace(/—{2,}/g, '，').replace(/–+/g, '，');
    s = s.replace(/。{3,}/g, '……');

    // 折叠空白
    s = s.replace(/[\t\r]+/g, ' ');
    s = s.replace(/ *\n */g, '\n');
    s = s.replace(/\n{2,}/g, '\n');
    return s.trim();
}

/**
 * 按句切分（保留句末标点）。句末符：。！？!?；;…与换行。
 * @returns {string[]} 非空句列表
 */
export function splitSentences(text) {
    const out = [];
    let buf = '';
    for (const ch of String(text ?? '')) {
        buf += ch;
        if ('。！？!?；;\n…'.includes(ch)) {
            if (buf.trim()) { out.push(buf.trim()); }
            buf = '';
        }
    }
    if (buf.trim()) { out.push(buf.trim()); }
    return out;
}

function hardSplit(sentence, maxChars) {
    // 超长句优先在逗号/顿号处断，再退化为定长切断
    const pieces = [];
    let rest = sentence;
    while (rest.length > maxChars) {
        const window = rest.slice(0, maxChars);
        let cut = Math.max(
            window.lastIndexOf('，'), window.lastIndexOf(','),
            window.lastIndexOf('、'), window.lastIndexOf('：'), window.lastIndexOf(':'),
        );
        cut = cut > maxChars * 0.3 ? cut + 1 : maxChars;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.trim()) { pieces.push(rest); }
    return pieces;
}

/**
 * 切分为 ≤maxChars 的合成块（引擎单请求建议 ≤120 字）。
 * @returns {string[]}
 */
export function splitIntoChunks(text, maxChars = 120) {
    const chunks = [];
    let buf = '';
    for (const sentence of splitSentences(text)) {
        for (const piece of (sentence.length > maxChars ? hardSplit(sentence, maxChars) : [sentence])) {
            if (buf && buf.length + piece.length > maxChars) {
                chunks.push(buf);
                buf = '';
            }
            buf += piece;
        }
    }
    if (buf.trim()) { chunks.push(buf); }
    return chunks.filter((c) => /[\u3400-\u4dbf\u4e00-\u9fff a-zA-Z0-9]/.test(c));
}

/** 稳定文本哈希（djb2），用于情绪缓存键与派生 seed */
export function hashText(text) {
    const s = String(text ?? '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

// 拟声词（引号内容为拟声词 → 不是台词，按旁白平读）
const ONOMATOPOEIA_RE = /^(嗯+|啊+|哦+|噢+|呜+|滴答|哗啦|轰隆|咔嚓|嗡嗡|叮咚|砰|啪|咚|当啷|呼呼|沙沙|咕嘟|哐当|吱呀|哔剥|噗通)+$/;
// 引号开头紧邻说话动词 → 一定是台词
const SPEECH_VERB_RE = /[说问道喊叫答吼念读催嘟囔嘀咕]$/;

/**
 * 引号内容的三态程序判定：
 *  - 'speech'    明确是台词（长句 / 带句读 / 前面是说话动词）→ 直接朗读，不问 LLM
 *  - 'nonspeech' 明确不是台词（拟声词 / ≤3 字的强调引用）→ 按旁白平读，不问 LLM
 *  - 'ambiguous' 含糊（4~6 字短引号）→ 交给 LLM 判定
 */
export function quoteHeuristic(inner, before = '') {
    const t = String(inner ?? '').trim();
    if (!t) { return 'nonspeech'; }
    if (ONOMATOPOEIA_RE.test(t)) { return 'nonspeech'; }
    if (/[。！？!?，,；;…～]$/.test(t)) { return 'speech'; }
    const beforeClean = String(before ?? '').replace(/[：:，,。\s""」』]+$/u, '');
    if (SPEECH_VERB_RE.test(beforeClean.slice(-2))) { return 'speech'; }
    if (t.length <= 3) { return 'nonspeech'; }
    if (t.length <= 6) { return 'ambiguous'; }
    return 'speech';
}

/** LLM 不可用时的兜底判定（含糊引号默认按台词处理——Router 原则） */
export function heuristicIsSpeech(inner, before = '') {
    return quoteHeuristic(inner, before) !== 'nonspeech';
}

/**
 * Router 式旁白/台词切分（纯程序判定，不用 LLM）：
 *  - **…**  → inner（内心想法，角色声线+情绪朗读）
 *  - "…" “…” 「…」 『…』 → quote（引号内容，是否台词由 LLM 判定，程序启发兜底）
 *  - 其余   → narration（旁白，平铺直叙、不打标）
 * @returns {{type:'narration'|'dialogue'|'inner'|'quote', text:string, before?:string}[]}
 */
export function segmentMessage(text) {
    const src = String(text ?? '');
    const out = [];
    const re = /(\*\*([^*\n]+?)\*\*)|"([^"\n]{1,300})"|(“([^”\n]{1,300})”)|(「([^」\n]{1,300})」)|(『([^』\n]{1,300})』)/g;
    let last = 0;
    let m;
    const push = (type, t, before = '') => {
        const trimmed = t.trim();
        if (trimmed) {
            const seg = { type, text: trimmed };
            if (before) { seg.before = before; }
            out.push(seg);
        }
    };
    while ((m = re.exec(src)) !== null) {
        if (m.index > last) { push('narration', src.slice(last, m.index)); }
        if (m[1] !== undefined) {
            push('inner', m[2]);
        } else {
            const inner = (m[3] ?? m[5] ?? m[7] ?? m[9] ?? '').trim();
            const before = src.slice(Math.max(0, m.index - 12), m.index);
            push('quote', inner, before);
        }
        last = m.index + m[0].length;
    }
    if (last < src.length) { push('narration', src.slice(last)); }
    return out;
}
