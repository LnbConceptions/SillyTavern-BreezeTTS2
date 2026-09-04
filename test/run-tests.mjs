// node --test 风格的轻量断言（无依赖）
import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── text.js ──
const T = await import('../src/text.js');

test('detectLang 中英文判别', () => {
    assert.equal(T.detectLang('你好，世界。'), 'zh');
    assert.equal(T.detectLang('Hello, world! This is a test.'), 'en');
    assert.equal(T.detectLang('混mixed内容with中文'), 'zh');
    assert.equal(T.detectLang(''), 'zh');
});

test('stripForTts 保留已知事件、剔除未知标签', () => {
    const input = '哈哈[笑]，你看那个[标记](链接)。他(叹气)了一声，还有(unknown note)这种。';
    const out = T.stripForTts(input, {});
    assert.ok(out.includes('[笑]'), '保留 [笑]: ' + out);
    assert.ok(!out.includes('[标记]'), '剔除未知方括号');
    assert.ok(out.includes('标记'), 'markdown 链接保留锚文字');
    assert.ok(!out.includes('链接'), 'markdown 链接 URL 不读');
    assert.ok(!out.includes('(sigh)') && !out.includes('叹气'), '中文文本里的英文事件按未知剔除');
    assert.ok(!out.includes('unknown note'), '剔除未知圆括号');
});

test('stripForTts 动作描写与 OOC', () => {
    const out = T.stripForTts('*她轻轻走近* 你来了。((这是OOC)) `代码`', { stripAsterisks: true });
    assert.ok(!out.includes('她轻轻走近'), '删动作');
    assert.ok(out.includes('你来了'), '留台词');
    assert.ok(!out.includes('OOC'), '删 OOC');
    assert.ok(!out.includes('代码'), '删行内代码');
});

test('stripForTts 保留动作开关', () => {
    const out = T.stripForTts('**她轻轻走近。** 你来了。', { stripAsterisks: false });
    assert.ok(out.includes('她轻轻走近'), '不删动作内容');
    assert.ok(out.includes('**'), '保留星号标记（分层切分需要）');
});

test('stripForTts think 块与破折号', () => {
    const out = T.stripForTts('<think>推理过程</think>嗯——好吧。。。', {});
    assert.ok(!out.includes('推理'), '删 think');
    assert.ok(!out.includes('——'), '破折号归一');
    assert.ok(out.includes('……'), '省略号归一');
});

test('splitIntoChunks 长度与句子完整', () => {
    const text = '第一句话。第二句话！这是一个非常非常非常长的句子，里面有很多内容，需要被切成几块才能合成，'.repeat(5) + '结束。';
    const chunks = T.splitIntoChunks(text, 120);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) {
        assert.ok(c.length <= 130, `块长 ${c.length} 超限: ${c}`);
    }
    const joined = chunks.join('');
    assert.equal(joined.replace(/\s/g, '').length, text.replace(/\s/g, '').length, '内容不丢');
});

test('splitIntoChunks 空文本', () => {
    assert.deepEqual(T.splitIntoChunks('', 120), []);
    // 纯事件消息保留（引擎会生成对应的笑声等声音）
    assert.deepEqual(T.splitIntoChunks('[笑]', 120), ['[笑]']);
});

test('hashText 稳定且不同文本不同', () => {
    assert.equal(T.hashText('abc'), T.hashText('abc'));
    assert.notEqual(T.hashText('abc'), T.hashText('abd'));
});

// ── Router 式分层 segmentMessage ──
test('segmentMessage 旁白/引号/内心三分（引号交 LLM 判定）', () => {
    const segs = T.segmentMessage('**她凑到他耳边。**「别动哦。」他的心跳快得厉害。');
    assert.deepEqual(segs.map((s) => s.type), ['inner', 'quote', 'narration']);
    assert.equal(segs[0].text, '她凑到他耳边。');
    assert.equal(segs[1].text, '别动哦。');
    assert.ok(segs[1].before.length > 0, 'quote 段携带前置上下文');
    assert.ok(segs[2].text.includes('心跳'));
});

test('segmentMessage 单星号动作按旁白处理', () => {
    const segs = T.segmentMessage('*她挥了挥手。*走吧。');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, 'narration');
    assert.ok(segs[0].text.includes('她挥了挥手') && segs[0].text.includes('走吧'));
});

test('quoteHeuristic 三态判定', () => {
    // 明确台词
    assert.equal(T.quoteHeuristic('别急着走，好戏才刚开始。', '她贴近他耳边'), 'speech');
    assert.equal(T.quoteHeuristic('滚', '他吼道：'), 'speech');
    // 明确非台词
    assert.equal(T.quoteHeuristic('咚咚', '门外传来'), 'nonspeech');
    assert.equal(T.quoteHeuristic('自由', '他所谓的'), 'nonspeech');
    // 含糊（4~6 字短引号）→ 交 LLM
    assert.equal(T.quoteHeuristic('你好吗朋友', ''), 'ambiguous');
    assert.equal(T.quoteHeuristic('晨光正好啊', '她望着'), 'ambiguous');
});

test('segmentMessage 旁白/引号/内心三分（引号交 LLM 判定）', () => {
    const segs = T.segmentMessage('**她凑到他耳边。**「别动哦。」他的心跳快得厉害。');
    assert.deepEqual(segs.map((s) => s.type), ['inner', 'quote', 'narration']);
    assert.equal(segs[0].text, '她凑到他耳边。');
    assert.equal(segs[1].text, '别动哦。');
    assert.ok(segs[1].before.length > 0, 'quote 段携带前置上下文');
    assert.ok(segs[2].text.includes('心跳'));
});

test('segmentMessage 单星号动作按旁白处理', () => {
    const segs = T.segmentMessage('*她挥了挥手。*走吧。');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, 'narration');
    assert.ok(segs[0].text.includes('她挥了挥手') && segs[0].text.includes('走吧'));
});

test('heuristicIsSpeech 兜底（含糊默认台词）', () => {
    // 拟声词 → 非台词
    assert.equal(T.heuristicIsSpeech('咚咚', '门外传来'), false);
    // 短且无句读、前面无说话动词 → 非台词（强调/引用）
    assert.equal(T.heuristicIsSpeech('自由', '他所谓的'), false);
    // 带句读 → 台词
    assert.equal(T.heuristicIsSpeech('你真的这么想吗？', '她笑了：'), true);
    // 前面是说话动词 → 台词
    assert.equal(T.heuristicIsSpeech('滚', '他吼道：'), true);
    // 含糊 → 默认台词（Router 原则）
    assert.equal(T.heuristicIsSpeech('你好吗朋友', ''), true);
});

// ── engine-client.js ──
const E = await import('../src/engine-client.js');

test('pcm16ToWavDataUrl 头部字节正确', () => {
    const pcm = new Uint8Array(4800); // 0.1s mono 24k
    pcm[0] = 0x34; pcm[1] = 0x12;
    const url = E.pcm16ToWavDataUrl(pcm);
    assert.ok(url.startsWith('data:audio/wav;base64,'));
    const buf = Buffer.from(url.slice('data:audio/wav;base64,'.length), 'base64');
    assert.equal(buf.length, 44 + 4800);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.readUInt32LE(4), 36 + 4800);
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.readUInt32LE(24), 24000);
    assert.equal(buf.readUInt32LE(40), 4800);
    assert.equal(buf[44], 0x34);
});

test('makeSilentWavDataUrl', () => {
    const url = E.makeSilentWavDataUrl(0.05);
    const buf = Buffer.from(url.slice('data:audio/wav;base64,'.length), 'base64');
    assert.equal(buf.readUInt32LE(40), 2400); // 0.05s * 24000 * 2
});

// ── emotion.js ──
const M = await import('../src/emotion.js');

test('情绪枚举：SFW 6 + NSFW 5', () => {
    assert.equal(M.EMOTION_LIST.length, 11);
    assert.deepEqual(M.EMOTION_LIST.slice(0, 6).map((e) => e.key), ['喜', '怒', '哀', '乐', '着急', '平静']);
    assert.deepEqual(M.EMOTION_LIST.slice(6).map((e) => e.key), ['挑逗', '渐入佳境', '激情互动', '高潮迭起', '缠绵悱恻']);
    assert.ok(M.EMOTION_LIST.slice(6).every((e) => e.cat === 'nsfw'));
});

test('ruleAnalyze 标点启发', () => {
    assert.deepEqual([M.ruleAnalyze('你敢！！').emotion, M.ruleAnalyze('你敢！！').intensity], ['怒', 3]);
    assert.equal(M.ruleAnalyze('真的吗？').intensity, 1);
    assert.equal(M.ruleAnalyze('闭嘴！').emotion, '怒');
    assert.equal(M.ruleAnalyze('好的。').emotion, '平静');
});

test('compileInstruction 拼接朗读方式', () => {
    const settings = { delivery: M.DEFAULT_DELIVERY, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { ...M.DEFAULT_INTENSITY_CFG } };
    const engine = new M.EmotionEngine(settings, null);
    const out = engine.compileInstruction('沉稳女声', { emotion: '挑逗', intensity: 2 });
    assert.ok(out.startsWith('沉稳女声'), out);
    assert.ok(out.includes('压低声音'), out);
    assert.equal(engine.compileInstruction('', { emotion: '平静', intensity: 1 }), '');
});

test('cfgForIntensity', () => {
    const settings = { delivery: M.DEFAULT_DELIVERY, intensityCfg: { 1: 2, 2: 3, 3: 4 } };
    const engine = new M.EmotionEngine(settings, null);
    assert.equal(engine.cfgForIntensity(3), 4);
});

test('resolveForChunk 数字协议：LLM 打标 + 缓存', async () => {
    let calls = 0;
    const settings = {
        emotionEnabled: true, llmBackend: 'api', taggerUrl: 'http://tagger.local/v1',
        ruleFallback: true,
        delivery: M.DEFAULT_DELIVERY, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { 1: 2, 2: 3, 3: 4 },
    };
    const engine = new M.EmotionEngine(settings, null);
    engine._callLLM = async (prompt) => {
        calls++;
        assert.ok(prompt.includes('只输出一个数字'));
        // 句1=挑逗(7) 句2=着急(5)
        return '75';
    };
    const r1 = await engine.resolveForChunk('凑过来，小声说：别动哦。别让我等太久！');
    assert.equal(r1.emotion, '挑逗', JSON.stringify(r1)); // 第一个非平静
    assert.equal(r1.intensity, 2, '数字协议固定强度 2');
    assert.equal(engine.deliveryFor(r1.emotion).length > 0, true);
    const r2 = await engine.resolveForChunk('凑过来，小声说：别动哦。别让我等太久！');
    assert.equal(calls, 1, '第二次命中缓存');
    assert.ok(r2.emotion === '挑逗');
});

test('analyzeQuotes：引号判定 0=旁白、情绪数字=台词', async () => {
    const settings = {
        emotionEnabled: true, llmBackend: 'api', taggerUrl: 'http://tagger.local/v1',
        ruleFallback: true,
        delivery: M.DEFAULT_DELIVERY, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE,
        quotePromptTemplate: M.DEFAULT_QUOTE_PROMPT, intensityCfg: {},
    };
    const engine = new M.EmotionEngine(settings, null);
    engine._callLLM = async (prompt) => {
        assert.ok(prompt.includes('引号片段'));
        return '1: 0\n2: 8';
    };
    await engine.analyzeQuotes([
        { text: '自由', before: '他所谓的' },
        { text: '别急着走，好戏才刚开始。', before: '她贴近他耳边' },
    ]);
    const v1 = await engine.resolveQuote('自由');
    assert.equal(v1.isSpeech, false, '强调引用 → 旁白');
    const v2 = await engine.resolveQuote('别急着走，好戏才刚开始。');
    assert.equal(v2.isSpeech, true, '真台词');
    assert.equal(v2.emotion, '渐入佳境');
    // 台词判定的情绪已写入句级缓存 → resolveForChunk 命中
    const r = await engine.resolveForChunk('别急着走，好戏才刚开始。');
    assert.equal(r.emotion, '渐入佳境');
});

test('resolveQuote 启发兜底（LLM 关闭）', async () => {
    const settings = {
        emotionEnabled: true, llmBackend: 'off', ruleFallback: true,
        delivery: M.DEFAULT_DELIVERY, quotePromptTemplate: M.DEFAULT_QUOTE_PROMPT, intensityCfg: {},
    };
    const engine = new M.EmotionEngine(settings, null);
    assert.equal((await engine.resolveQuote('咚咚', { skipLLM: false })).isSpeech, false);
    assert.equal((await engine.resolveQuote('这是一句完整的台词，带着情绪。')).isSpeech, true);
});

test('resolveForChunk 首块 skipLLM 立即出声', async () => {
    const settings = {
        emotionEnabled: true, llmBackend: 'st', ruleFallback: true,
        delivery: M.DEFAULT_DELIVERY, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { 1: 2, 2: 3, 3: 4 },
    };
    let calls = 0;
    const engine = new M.EmotionEngine(settings, {
        chat: [], generateQuietPrompt: async () => { calls++; return '7'; },
    });
    const r = await engine.resolveForChunk('全新的一句话！', { skipLLM: true });
    assert.equal(calls, 0, 'skipLLM 不触发打标');
    assert.equal(r.byRule, true);
    assert.ok(r.emotion);
});

test('analyzeBatch api 后端走 fetch（mock fetch）', async () => {
    const origFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, opts) => {
        captured = { url, body: JSON.parse(opts.body) };
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: '6' } }] }),
        };
    };
    try {
        const settings = {
            emotionEnabled: true, llmBackend: 'api', ruleFallback: true,
            taggerUrl: 'http://127.0.0.1:1120/v1', taggerModel: 'hy-mt2-7b', taggerKey: 'test',
            delivery: M.DEFAULT_DELIVERY, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: {},
        };
        const engine = new M.EmotionEngine(settings, null);
        const res = await engine.analyzeBatch(['今天天气不错。']);
        assert.equal(res['今天天气不错。'].emotion, '平静');
        assert.equal(captured.url, 'http://127.0.0.1:1120/v1/chat/completions');
        assert.equal(captured.body.model, 'hy-mt2-7b');
        assert.equal(captured.body.max_tokens, 16); // 8 + 8*1
        assert.equal(captured.body.reasoning_effort, 'none');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('熔断：失败后冷却期内不再调用', async () => {
    let calls = 0;
    const settings = {
        emotionEnabled: true, llmBackend: 'st', ruleFallback: true,
        delivery: M.DEFAULT_DELIVERY, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: {},
    };
    const engine = new M.EmotionEngine(settings, {
        chat: [], generateQuietPrompt: async () => { calls++; throw new Error('down'); },
    });
    await engine.resolveForChunk('第一句话！');
    await engine.resolveForChunk('第二句话！');
    assert.equal(calls, 1, '冷却期内不再调用');
    assert.ok(Date.now() - (engine.failedUntil - 60_000) < 5000);
});

// ── voices.js ──
const V = await import('../src/voices.js');

test('VoiceStore 增删改查/导出导入', () => {
    const store = new V.VoiceStore(V.defaultVoiceProfiles());
    assert.equal(store.all().length, 2);
    const profile = store.save({ name: '测试', mode: 'design', designInstruction: 'x', cfg: 4 });
    assert.ok(profile.id);
    assert.equal(store.get('测试').id, profile.id);
    const json = store.exportJson();
    const store2 = new V.VoiceStore([]);
    const { imported } = store2.importJson(json);
    assert.equal(imported, 3);
    assert.equal(store2.get('测试').designInstruction, 'x');
    assert.ok(store.remove(profile.id));
    assert.ok(store.toVoiceObjects().some((v) => v.voice_id === V.MUTE_VOICE.voice_id), '声音列表包含静音');
});

test('VoiceStore 无音频的克隆声线导入时跳过', () => {
    const store = new V.VoiceStore([]);
    const { imported } = store.importJson(JSON.stringify({ voices: [{ name: '坏', mode: 'clone', refText: 'x' }] }));
    assert.equal(imported, 0);
});

// ── run ──
let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ❌ ${name}\n     ${err?.stack ?? err}`);
    }
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
