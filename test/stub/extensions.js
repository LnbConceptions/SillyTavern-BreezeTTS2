// Node 环境下的 ST 导入桩：provider.js 里 `import ... from '/scripts/extensions.js'`
// 在测试时被改写为指向本文件。
export function getContext() {
    return globalThis.__ST_CTX__ ?? null;
}
