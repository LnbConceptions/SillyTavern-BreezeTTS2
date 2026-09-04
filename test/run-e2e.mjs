// 端到端测试：provider 核心合成管线 → 模拟引擎（:9899）。
// 用桩替换 provider.js 的 ST 导入后动态加载，走真实 HTTP + FormData + WAV 封装。
// 前置：node test/mock-server.mjs 已运行。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = 'http://127.0.0.1:9899';
const PROVIDER_NAME = 'Breeze TTS 2';

// 1. 生成改写导入的临时副本（放 src/ 使相对导入解析正确）
const src = readFileSync(join(HERE, '..', 'src', 'provider.js'), 'utf8');
const patched = src.replace(
    "from '/scripts/extensions.js'",
    "from '../test/stub/extensions.js'",
);
const tempFile = join(HERE, '..', 'src', 'provider.e2e.tmp.mjs');
writeFileSync(tempFile, patched);
process.on('exit', () => rmSync(tempFile, { force: true }));

const { BreezeTtsProvider } = await import(`../src/provider.e2e.tmp.mjs?ts=${Date.now()}`);

// 2. 构造 provider，指向模拟引擎
const provider = new BreezeTtsProvider();
provider.settings.endpoint = ENGINE;
provider.client.setEndpoint(ENGINE);
provider.settings.debug = false;

// LLM 桩：打标协议为纯数字（情绪枚举 1-11）
let llmCalls = 0;
globalThis.__ST_CTX__ = {
    chat: [{ is_user: true, name: 'You', mes: '你在干什么？' }],
    generateQuietPrompt: async ({ quietPrompt }) => {
        llmCalls++;
        const lines = [...quietPrompt.matchAll(/^\d+\.\s.+$/gm)];
        return lines.map((m) => {
            const t = m[0];
            if (/！！/.test(t)) { return '9'; }   // 激情互动
            if (/……/.test(t)) { return '7'; }     // 挑逗
            return '6';                            // 平静
        }).join('');
    },
};
provider.emotion.setContext(globalThis.__ST_CTX__);
provider.settings.llmBackend = 'st';

const SAMPLE = '*她凑到他耳边，声音压得很低。*「别动哦……被别人发现就不好了呢。[笑]」她的心跳快得厉害！！';

async function fetchLast() {
    return (await fetch(`${ENGINE}/engine-debug/last`)).json();
}

// ── 用例 ──
let failed = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ❌ ${name}\n     ${err?.stack ?? err}`);
    }
};

await test('静音声线：0 次 yield', async () => {
    const out = [];
    for await (const x of provider.generateTts('随便什么', 'breeze2:mute', '')) { out.push(x); }
    assert.equal(out.length, 0);
});

await test('完整链路：清洗→分块→情绪→引擎→WAV yield', async () => {
    const voice = provider.store.all()[0]; // 叙述者（设计模式）
    const chunksOut = [];
    for await (const wavUrl of provider.generateTts(SAMPLE, voice.id, 'Alice ("Quotes")')) {
        assert.ok(wavUrl.startsWith('data:audio/wav;base64,'), 'yield 必须是 WAV data URL');
        chunksOut.push(wavUrl);
    }
    assert.ok(chunksOut.length >= 1, `至少 1 块，得到 ${chunksOut.length}`);
    // mock 引擎首个请求 409 一次 → 成功说明重试生效
    const last = await fetchLast();
    assert.ok(last && last.text, '引擎收到了 text 字段');
    assert.ok(typeof last.cfg_scale === 'string' && Number(last.cfg_scale) > 0, `cfg_scale 到达引擎: ${last.cfg_scale}`);
    assert.ok(last.seed !== undefined, 'seed 到达引擎');
    assert.ok(last.instruction && last.instruction.length > 0, `instruction 到达引擎: ${last.instruction}`);
    console.log(`     → ${chunksOut.length} 块, 引擎 instruction="${String(last.instruction).slice(0, 60)}…" cfg=${last.cfg_scale} seed=${last.seed}`);
});

await test('情绪引擎生效：LLM 被调用，指令含词典描述', async () => {
    provider.emotion.clearCache();
    llmCalls = 0;
    const voice = provider.store.all()[0];
    for await (const _ of provider.generateTts(SAMPLE, voice.id, 'Alice ("Quotes")')) { void _; }
    assert.ok(llmCalls >= 1, 'LLM 应被调用');
    const last = await fetchLast();
    assert.ok(/压低|勾人|本段|叙述者/.test(last.instruction ?? ''), `指令包含情绪描述: ${last.instruction}`);
});

await test('克隆声线：ref_audio 与 ref_text 到达引擎', async () => {
    const profile = provider.store.save({
        name: 'E2E克隆', mode: 'clone',
        refAudio: { name: 'ref.wav', mime: 'audio/wav', data: Buffer.from('RIFFfake').toString('base64') },
        refText: '这是参考文字稿', baseDirection: '', cfg: 2, seedMode: 'fixed', seed: 7, lang: 'zh',
    });
    for await (const x of provider.generateTts('你好呀。', profile.id, 'Alice ("Quotes")')) {
        assert.ok(x.startsWith('data:audio/wav'));
    }
    const last = await fetchLast();
    assert.ok(/ref\.wav/.test(last.ref_audio ?? ''), `ref_audio 到达: ${last.ref_audio}`);
    assert.equal(last.ref_text, '这是参考文字稿');
    provider.store.remove(profile.id);
});

await test('清洗后为空：0 次 yield 不报错', async () => {
    const voice = provider.store.all()[0];
    const out = [];
    for await (const x of provider.generateTts('*……* ```js``` ((ooc))', voice.id, '')) { out.push(x); }
    assert.equal(out.length, 0);
});

await test('未知标签被剔除、已知事件保留', async () => {
    const lastBefore = await fetchLast();
    const voice = provider.store.all()[0];
    for await (const _ of provider.generateTts('看招！！(snaps fingers)[叹气]', voice.id, 'Alice (Other text)')) { void _; }
    const last = await fetchLast();
    assert.equal(lastBefore._at === last._at, false, '发起了新请求');
    assert.ok((last.text ?? '').includes('[叹气]'), `保留已知事件: ${last.text}`);
    assert.ok(!(last.text ?? '').includes('snaps'), `剔除未知事件: ${last.text}`);
    assert.ok((last.text ?? '').includes('看招'), `保留正文: ${last.text}`);
});

await test('固定 seed 派生稳定', async () => {
    const profile = provider.store.save({
        name: 'SeedTest', mode: 'design', designInstruction: 'x', cfg: 4, seedMode: 'fixed', seed: 42, lang: 'zh',
    });
    const r1 = await provider._buildRequest('同一句话。', provider.store.get(profile.id));
    const r2 = await provider._buildRequest('同一句话。', provider.store.get(profile.id));
    assert.equal(r1.seed, r2.seed);
    const r3 = await provider._buildRequest('另一句话。', provider.store.get(profile.id));
    assert.notEqual(r1.seed, r3.seed);
    provider.store.remove(profile.id);
});

console.log(failed ? `\n${failed} FAILED` : '\ne2e all passed');
process.exit(failed ? 1 : 0);
