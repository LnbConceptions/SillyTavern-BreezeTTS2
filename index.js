// Breeze TTS 2 — SillyTavern TTS Provider 扩展入口
// 等待官方 TTS 扩展模块就绪后，把 provider 注册进 provider 列表。
import { BreezeTtsProvider } from './src/provider.js';

const PROVIDER_NAME = 'Breeze TTS 2';

(async function init() {
    // TTS 扩展加载顺序可能在本扩展之后，轮询等待其模块可导入
    for (let attempt = 0; attempt < 240; attempt++) {
        try {
            const ttsModule = await import('/scripts/extensions/tts/index.js');
            if (typeof ttsModule.registerTtsProvider === 'function') {
                try {
                    ttsModule.registerTtsProvider(PROVIDER_NAME, BreezeTtsProvider);
                    console.info(`[BreezeTTS2] provider 已注册: ${PROVIDER_NAME}`);
                } catch (err) {
                    // 重名注册（热重载等场景）不致命
                    console.warn('[BreezeTTS2] 注册失败:', err?.message ?? err);
                }
                return;
            }
        } catch {
            /* TTS 扩展尚未加载，继续等待 */
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.error('[BreezeTTS2] 等待 TTS 扩展超时——请在扩展面板确认 TTS 扩展已启用');
})();
