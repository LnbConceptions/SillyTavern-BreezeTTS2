// Breeze TTS 2 — SillyTavern TTS Provider 扩展入口
// 1) 等待官方 TTS 扩展模块就绪后注册 provider；
// 2) 在扩展设置面板渲染一个独立抽屉（状态/一键切换/指引），保证可见性与可诊断性。
import { BreezeTtsProvider } from './src/provider.js';
import { BreezeEngineClient } from './src/engine-client.js';

const PROVIDER_NAME = 'Breeze TTS 2';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9897';

(async function registerProvider() {
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

// ──────────────────── 独立抽屉（扩展设置面板） ────────────────────

async function renderStandaloneDrawer() {
    // 等扩展设置容器就绪（与设置界面同一次渲染流程）
    for (let attempt = 0; attempt < 60; attempt++) {
        if (window.jQuery && window.jQuery('#extensions_settings').length) { break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const $ = window.jQuery;
    if (!$ || !$('#extensions_settings').length) {
        console.warn('[BreezeTTS2] 未找到扩展设置容器，独立抽屉未渲染');
        return;
    }
    if (document.getElementById('breeze2_drawer')) { return; }

    const drawer = `
    <div class="extension_settings" id="breeze2_drawer">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🌬️ Breeze TTS 2</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="breeze2_drawer_status" class="breeze2-hint">状态检测中…</div>
                <div class="breeze2-inline">
                    <a id="breeze2_drawer_switch" class="menu_button"><i class="fa-solid fa-toggle-on"></i><span>启用为当前 TTS Provider</span></a>
                    <a id="breeze2_drawer_refresh" class="menu_button"><i class="fa-solid fa-heart-pulse"></i><span>检测引擎</span></a>
                </div>
                <div class="breeze2-hint">
                    完整设置（引擎地址 / 声线库 / 情绪引擎 / 文本清洗）在
                    <b>用户设置 → 扩展 → TTS</b>：把「TTS Provider」切换为
                    <b>${PROVIDER_NAME}</b> 后显示在此面板下方。
                </div>
                <div class="breeze2-hint">
                    三步开聊：① TTS 面板里建声线（设计模式一句话即可，或克隆模式传参考音频）
                    → ② Voice Map 里把角色映射到声线名 → ③ 想让动作/旁白分声就开启
                    TTS 设置里的多声线选项。
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings').append(drawer);

    const context = (await import('/scripts/extensions.js')).getContext();
    const readEndpoint = () => String(
        context?.extensionSettings?.tts?.[PROVIDER_NAME]?.endpoint ?? DEFAULT_ENDPOINT,
    );

    const check = async () => {
        const $status = $('#breeze2_drawer_status');
        const current = context?.extensionSettings?.tts?.currentProvider;
        const lines = [];
        lines.push(current === PROVIDER_NAME
            ? '✅ 已是当前 TTS Provider（设置面板在 TTS 板块下方）'
            : '⏸️ 尚未选为 TTS Provider——点下方按钮一键启用');
        $status.text('检测中…');
        const health = await new BreezeEngineClient(readEndpoint()).health();
        if (health.ok) {
            lines.push('✅ 引擎在线（24kHz 就绪）');
        } else if (health.loading) {
            lines.push('⏳ 引擎加载中（模型 warmup，约 1 分钟）');
        } else {
            lines.push(`❌ 引擎不可达：${health.error ?? ''}`);
        }
        $status.html(lines.map((l) => `${l}`).join('<br>'));
    };

    $('#breeze2_drawer_refresh').on('click', check);
    $('#breeze2_drawer_switch').on('click', async () => {
        const select = $('#tts_provider');
        if (!select.length || !select.find(`option[value="${PROVIDER_NAME}"]`).length) {
            toastr.error('TTS Provider 下拉框未就绪或未包含 Breeze TTS 2——确认 TTS 扩展已启用并刷新页面');
            return;
        }
        select.val(PROVIDER_NAME).trigger('change');
        toastr.success(`已切换 TTS Provider 为 ${PROVIDER_NAME}`);
        setTimeout(check, 300);
    });

    await check();
}

(async function initDrawer() { await renderStandaloneDrawer(); })();
