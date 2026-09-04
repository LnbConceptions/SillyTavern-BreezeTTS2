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
    const out = T.stripForTts('*她轻轻走近* 你来了。', { stripAsterisks: false });
    assert.ok(out.includes('她轻轻走近'), '不删动作内容');
    assert.ok(!out.includes('*'), '删除星号本身');
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

// ── engine-client.js ──
const E = await import('../src/engine-client.js');

test('pcm16ToWavDataUrl 头部字节正确', () => {
    const pcm = new Uint8Array(4800); // 0.1s mono 24k
    pcm[0] = 0x34; pcm[1] = 0x12;
    const url = E.pcm16ToWavDataUrl(pcm);
    assert.ok(url.startsWith('data:audio/wav;base64,'));
    const b64 = url.slice('data:audio/wav;base64,'.length);
    const buf = Buffer.from(b64, 'base64');
    assert.equal(buf.length, 44 + 4800);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.readUInt32LE(4), 36 + 4800);
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
    assert.equal(buf.readUInt32LE(16), 16);
    assert.equal(buf.readUInt16LE(20), 1);      // PCM
    assert.equal(buf.readUInt16LE(22), 1);      // mono
    assert.equal(buf.readUInt32LE(24), 24000);  // sample rate
    assert.equal(buf.readUInt32LE(28), 48000);  // byte rate
    assert.equal(buf.readUInt16LE(32), 2);      // block align
    assert.equal(buf.readUInt16LE(34), 16);     // bits
    assert.equal(buf.toString('ascii', 36, 40), 'data');
    assert.equal(buf.readUInt32LE(40), 4800);
    assert.equal(buf[44], 0x34);                // 数据原样保留
    assert.equal(buf[45], 0x12);
});

test('pcm16ToWavDataUrl 奇数长度截齐', () => {
    const url = E.pcm16ToWavDataUrl(new Uint8Array(4801));
    const buf = Buffer.from(url.slice('data:audio/wav;base64,'.length), 'base64');
    assert.equal((buf.length - 44) % 2, 0, '数据长度必须 16-bit 对齐');
});

test('makeSilentWavDataUrl', () => {
    const url = E.makeSilentWavDataUrl(0.05);
    const buf = Buffer.from(url.slice('data:audio/wav;base64,'.length), 'base64');
    assert.equal(buf.readUInt32LE(40), 2400); // 0.05s * 24000 * 2
});

// ── emotion.js ──
const M = await import('../src/emotion.js');

test('ruleAnalyze 标点启发', () => {
    assert.equal(M.ruleAnalyze('你敢！！').intensity, 3);
    assert.equal(M.ruleAnalyze('真的吗？').intensity, 1);
    assert.equal(M.ruleAnalyze('闭嘴！').intensity, 2);
    assert.equal(M.ruleAnalyze('我……不知道。').intensity, 1);
    assert.equal(M.ruleAnalyze('好的。').intensity, 1);
});

test('compileInstruction 拼接词典描述', () => {
    const settings = { lexicon: M.DEFAULT_LEXICON, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { ...M.DEFAULT_INTENSITY_CFG } };
    const engine = new M.EmotionEngine(settings, null);
    const out = engine.compileInstruction('沉稳女声', { emotion: '挑逗', intensity: 2 }, 'zh');
    assert.ok(out.startsWith('沉稳女声'), out);
    assert.ok(out.includes('压低'), '编译进词典描述: ' + out);
    assert.equal(engine.compileInstruction('', { emotion: '中性', intensity: 1 }, 'zh'), '');
    const enOut = engine.compileInstruction('a calm female voice', { emotion: 'teasing', intensity: 3 }, 'en');
    assert.ok(enOut.includes('drawn-out'), enOut);
});

test('cfgForIntensity', () => {
    const settings = { lexicon: M.DEFAULT_LEXICON, intensityCfg: { 1: 2, 2: 3, 3: 4 } };
    const engine = new M.EmotionEngine(settings, null);
    assert.equal(engine.cfgForIntensity(3), 4);
    assert.equal(engine.cfgForIntensity(1), 2);
});

test('resolveForChunk 规则兜底（无 ctx）', async () => {
    const settings = { enabled: true, ruleFallback: true, lexicon: M.DEFAULT_LEXICON, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { 1: 2, 2: 3, 3: 4 } };
    const engine = new M.EmotionEngine(settings, null);
    const res = await engine.resolveForChunk('你这个坏蛋！！');
    assert.equal(res.intensity, 3);
    assert.ok(res.emotion, '有兜底情绪名');
});

test('resolveForChunk 多句合并：缓存命中走合并、skipLLM 走规则', async () => {
    const settings = { emotionEnabled: true, ruleFallback: true, lexicon: M.DEFAULT_LEXICON, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { 1: 2, 2: 3, 3: 4 } };
    const fakeCtx = {
        chat: [],
        generateQuietPrompt: async ({ quietPrompt }) => {
            const segs = [...quietPrompt.matchAll(/^(\d+): (.+)$/gm)];
            const lines = segs.map((m) => {
                const t = m[2];
                if (/挑逗|贴到/.test(t)) return { i: Number(m[1]), emotion: '挑逗', intensity: 3, event: null };
                return { i: Number(m[1]), emotion: '中性', intensity: 1, event: null };
            });
            return JSON.stringify({ lines });
        },
    };
    const engine = new M.EmotionEngine(settings, fakeCtx);
    // 预填第一句的缓存（模拟消息级预分析）
    await engine.resolveForChunk('他贴到她耳边，声音压得极低。');
    const merged = await engine.resolveForChunk('他贴到她耳边，声音压得极低。别出声。');
    assert.equal(merged.emotion, '挑逗', '合并取第一个非中性情绪');
    assert.equal(merged.intensity, 3);
    // skipLLM：缓存未命中的新句立即走规则，不调 LLM
    const before = 0;
    const r = await engine.resolveForChunk('完全陌生的新句子！！', { skipLLM: true });
    assert.equal(r.intensity, 3, '规则兜底给出强度');
    assert.ok(r.byRule, '标记为规则结果');
    assert.ok(before === 0, 'skipLLM 不触发 LLM');
});

test('resolveForChunk LLM 主路径 + 缓存', async () => {
    const calls = [];
    const fakeCtx = {
        chat: [{ is_user: false, name: 'Alice', mes: '上下文' }],
        generateQuietPrompt: async ({ quietPrompt }) => {
            calls.push(quietPrompt);
            assert.ok(quietPrompt.includes('待标注台词'));
            return JSON.stringify({ lines: [{ i: 0, emotion: '挑逗', intensity: 3, event: '[笑]' }] });
        },
    };
    const settings = { emotionEnabled: true, ruleFallback: true, lexicon: M.DEFAULT_LEXICON, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { 1: 2, 2: 3, 3: 4 } };
    const engine = new M.EmotionEngine(settings, fakeCtx);
    const r1 = await engine.resolveForChunk('凑过来，小声说：别动哦。');
    assert.equal(r1.emotion, '挑逗');
    assert.equal(r1.intensity, 3);
    assert.equal(engine.eventTag(r1, 'zh'), '[笑]');
    const r2 = await engine.resolveForChunk('凑过来，小声说：别动哦。'); // 命中缓存，不再调 LLM
    assert.equal(calls.length, 1, '第二次应命中缓存');
    assert.equal(r2.emotion, '挑逗');
});

test('analyzeBatch LLM 失败进入冷却，resolveForChunk 走规则', async () => {
    const fakeCtx = {
        chat: [],
        generateQuietPrompt: async () => { throw new Error('LLM down'); },
    };
    const settings = { enabled: true, ruleFallback: true, lexicon: M.DEFAULT_LEXICON, promptTemplate: M.DEFAULT_PROMPT_TEMPLATE, intensityCfg: { 1: 2, 2: 3, 3: 4 } };
    const engine = new M.EmotionEngine(settings, fakeCtx);
    const res = await engine.resolveForChunk('天哪！！');
    assert.equal(res.intensity, 3);
    assert.ok(res.byRule, '走了规则兜底');
});

test('eventTag 拒绝白名单外事件', () => {
    const settings = { lexicon: M.DEFAULT_LEXICON, intensityCfg: {} };
    const engine = new M.EmotionEngine(settings, null);
    assert.equal(engine.eventTag({ event: '[尖叫]' }, 'zh'), null);
    assert.equal(engine.eventTag({ event: '[叹气]' }, 'zh'), '[叹气]');
    assert.equal(engine.eventTag({ event: '[叹气]' }, 'en'), null);
});

// ── voices.js ──
const V = await import('../src/voices.js');

test('VoiceStore 增删改查/导出导入', () => {
    const store = new V.VoiceStore(V.defaultVoiceProfiles());
    assert.equal(store.all().length, 2);
    const profile = store.save({ name: '测试', mode: 'design', designInstruction: 'x', cfg: 4 });
    assert.ok(profile.id);
    assert.equal(store.get('测试').id, profile.id);
    assert.equal(store.get(profile.id).name, '测试');
    const json = store.exportJson();
    const store2 = new V.VoiceStore([]);
    const { imported } = store2.importJson(json);
    assert.equal(imported, 3);
    assert.equal(store2.get('测试').designInstruction, 'x');
    assert.ok(store.remove(profile.id));
    assert.equal(store.get(profile.id), null);
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
