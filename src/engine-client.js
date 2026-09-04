// Breeze TTS 2 引擎 HTTP 客户端：multipart 表单调用 /v1/audio/speech，
// 读回 24kHz s16le PCM 流并封装为 WAV data URL。含 409（引擎单并发）退避重试。
// 除 fetch/atob/btoa 外不依赖浏览器专有 API，可在 node 18+ 下单测。

export const SAMPLE_RATE = 24000;

function base64FromBytes(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
            null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** 把 s16le PCM 原始数据封装成 WAV data URL（44 字节标准头） */
export function pcm16ToWavDataUrl(pcmArrayBuffer, sampleRate = SAMPLE_RATE) {
    const pcm = pcmArrayBuffer instanceof Uint8Array
        ? pcmArrayBuffer
        : new Uint8Array(pcmArrayBuffer);
    const dataLen = pcm.byteLength - (pcm.byteLength % 2); // 16-bit 对齐
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const writeStr = (offset, s) => {
        for (let i = 0; i < s.length; i++) { v.setUint8(offset + i, s.charCodeAt(i)); }
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true);          // fmt 块长
    v.setUint16(20, 1, true);           // PCM
    v.setUint16(22, 1, true);           // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);           // block align
    v.setUint16(34, 16, true);          // bits
    writeStr(36, 'data');
    v.setUint32(40, dataLen, true);

    const out = new Uint8Array(44 + dataLen);
    out.set(new Uint8Array(header), 0);
    out.set(pcm.subarray(0, dataLen), 44);
    return `data:audio/wav;base64,${base64FromBytes(out)}`;
}

/** 短静音（用于占位） */
export function makeSilentWavDataUrl(seconds = 0.05, sampleRate = SAMPLE_RATE) {
    const n = Math.max(1, Math.floor(sampleRate * seconds)) * 2;
    return pcm16ToWavDataUrl(new Uint8Array(n), sampleRate);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BreezeEngineClient {
    /**
     * @param {string} endpoint 例如 http://192.168.1.10:9897
     * @param {number} retries 409 时的额外重试次数
     */
    constructor(endpoint = 'http://127.0.0.1:9897', retries = 4) {
        this.endpoint = endpoint;
        this.retries = retries;
    }

    setEndpoint(url) {
        this.endpoint = String(url || '').replace(/\/+$/, '') || this.endpoint;
    }

    /** @returns {Promise<{ok:boolean, loading:boolean, data:object|null, error:string|null}>} */
    async health() {
        try {
            const res = await fetch(`${this.endpoint}/health`, { method: 'GET' });
            if (res.ok) {
                return { ok: true, loading: false, data: await res.json(), error: null };
            }
            if (res.status === 503) {
                return { ok: false, loading: true, data: null, error: '引擎加载中' };
            }
            return { ok: false, loading: false, data: null, error: `HTTP ${res.status}` };
        } catch (err) {
            return {
                ok: false, loading: false, data: null,
                error: `无法连接引擎（${err?.message ?? err}）。请确认地址正确、引擎已启动，且引擎端已开启 CORS。`,
            };
        }
    }

    /**
     * 合成一段文本，返回 WAV data URL。
     * @param {object} p
     * @param {string} p.text
     * @param {string} [p.instruction]
     * @param {number} [p.cfgScale]
     * @param {number} [p.seed]
     * @param {{data:string,name:string,mime:string}|null} [p.refAudio] base64（不带 data: 前缀）
     * @param {string} [p.refText]
     * @returns {Promise<string>}
     */
    async synthesizeOnce(p) {
        const form = new FormData();
        form.append('text', p.text);
        form.append('instruction', p.instruction || 'Speak clearly and naturally.');
        form.append('cfg_scale', String(p.cfgScale ?? 1.0));
        if (p.seed !== undefined && p.seed !== null) {
            form.append('seed', String(p.seed));
        }
        if (p.refAudio && p.refAudio.data) {
            const bytes = Uint8Array.from(atob(p.refAudio.data), (c) => c.charCodeAt(0));
            form.append('ref_audio', new Blob([bytes], { type: p.refAudio.mime || 'audio/wav' }),
                p.refAudio.name || 'reference.wav');
            form.append('ref_text', p.refText || '');
        }

        let lastError = null;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            if (attempt > 0) {
                await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
            }
            let res;
            try {
                res = await fetch(`${this.endpoint}/v1/audio/speech`, {
                    method: 'POST', body: form,
                });
            } catch (err) {
                throw new Error(`连接引擎失败：${err?.message ?? err}`);
            }
            if (res.status === 409) {
                lastError = new Error('引擎正忙（上一段尚未合成完），已多次重试仍失败');
                continue;
            }
            if (res.status === 503) {
                lastError = new Error('引擎正在加载模型，请稍候再试');
                continue;
            }
            if (!res.ok) {
                const detail = (await res.text()).slice(0, 300);
                throw new Error(`引擎错误 HTTP ${res.status}：${detail}`);
            }
            const pcm = await res.arrayBuffer();
            if (pcm.byteLength < 4800) { // <0.1s 视为空音频
                throw new Error('引擎返回了空音频（文本可能无法发音）');
            }
            return pcm16ToWavDataUrl(pcm);
        }
        throw lastError ?? new Error('合成失败');
    }
}
