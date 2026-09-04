// 联调服务器：模拟 SillyTavern 前端模块 + 模拟 Breeze 引擎 + 静态托管扩展源码。
//   http://127.0.0.1:8125/                          → 联调控制页
//   http://127.0.0.1:8125/scripts/extensions.js     → getContext mock
//   http://127.0.0.1:8125/scripts/extensions/tts/index.js → TTS 扩展 mock
//   http://127.0.0.1:8125/scripts/extensions/third-party/breeze-tts-2/* → 扩展源码
//   http://127.0.0.1:9899/health|/v1/audio/speech   → 模拟引擎（可模拟 409）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8125;
const ENGINE_PORT = 9899;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// ── 模拟引擎状态 ──
let simulate409 = true; // 首个请求返回一次 409，测试退避重试
let lastForm = null;

function sinePcm(seconds = 0.8, sampleRate = 24000) {
    const n = Math.floor(sampleRate * seconds);
    const buf = new Uint8Array(n * 2);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, Math.min(i, n - i) / (sampleRate * 0.05)); // 去咔哒
        const v = Math.round(Math.sin(2 * Math.PI * 220 * t) * 8000 * env)
            + Math.round(Math.sin(2 * Math.PI * 340 * t) * 3000 * env);
        view.setInt16(i * 2, v, true);
    }
    return buf;
}

const engine = http.createServer(async (req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
    }
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify({ status: 'ok', sample_rate: 24000 }));
    }
    if (req.url === '/v1/audio/speech' && req.method === 'POST') {
        try {
            const inner = new Request('http://engine/v1/audio/speech', {
                method: 'POST',
                headers: { 'content-type': req.headers['content-type'] ?? '' },
                body: req,
                duplex: 'half',
            });
            const form = await inner.formData();
            lastForm = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `${v.name}(${v.size}B)`]));
            lastForm._at = new Date().toISOString();
        } catch (err) {
            lastForm = { _parseError: String(err) };
        }
        if (simulate409) {
            simulate409 = false;
            res.writeHead(409, { 'Content-Type': 'application/json', ...cors });
            return res.end(JSON.stringify({ detail: 'An inference request is already running.' }));
        }
        const seconds = Math.max(0.4, Math.min(2.5, (lastForm?.text?.length ?? 10) * 0.045));
        const pcm = sinePcm(seconds);
        res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000', ...cors });
        return res.end(pcm);
    }
    if (req.url === '/engine-debug/last') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify(lastForm ?? { _empty: true }));
    }
    if (req.url === '/engine-debug/reset409') {
        simulate409 = true;
        res.writeHead(200, { ...cors });
        return res.end('ok');
    }
    res.writeHead(404, cors);
    res.end('not found');
});

// ── 静态 + mock ST 模块 ──
const MOCK_EXTENSIONS_JS = `
export function getContext() { return window.__ST_CTX__ ?? null; }
`;
const MOCK_TTS_JS = `
const registered = {};
export function registerTtsProvider(name, cls) {
    registered[name] = cls;
    if (typeof window.__onProviderRegistered === 'function') window.__onProviderRegistered(name, cls);
}
export function saveTtsProviderSettings() {
    if (typeof window.__onSettingsSaved === 'function') window.__onSettingsSaved();
}
export function __providers() { return registered; }
`;

const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const send = (body, type = 'text/plain') => {
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
    };
    if (url === '/scripts/extensions.js') { return send(MOCK_EXTENSIONS_JS, MIME.js); }
    if (url === '/scripts/extensions/tts/index.js') { return send(MOCK_TTS_JS, MIME.js); }

    const prefix = '/scripts/extensions/third-party/breeze-tts-2/';
    if (url.startsWith(prefix)) {
        const rel = normalize(decodeURIComponent(url.slice(prefix.length))).replace(/^(\.\.[/\\])+/, '');
        const file = join(ROOT, rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        try {
            const data = await readFile(file);
            res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
            return res.end(data);
        } catch {
            res.writeHead(404);
            return res.end('not found');
        }
    }
    if (url === '/' || url === '/index.html') {
        try {
            return send(await readFile(join(ROOT, 'test', 'harness.html')), MIME['.html']);
        } catch { res.writeHead(500); return res.end(); }
    }
    res.writeHead(404);
    res.end('not found');
});

engine.listen(ENGINE_PORT, () => console.log(`mock engine :${ENGINE_PORT}`));
server.listen(PORT, () => console.log(`harness     http://127.0.0.1:${PORT}/`));
