# Breeze TTS 2 for SillyTavern

一个 SillyTavern 第三方 TTS 扩展，让 SillyTavern **直连** [Breeze TTS 2](https://huggingface.co/BreezeBlue/breeze-tts-2) 推理引擎（不经过 TTS-Router）。

目标是把 Breeze TTS 2 的表达能力全部用起来，让 RP 朗读"像广播剧"：

- 🎭 **台词情绪导演**：学习 TTS-Router 的分层经验——**旁白（引号和 \*\*…\*\* 之外的全部文字）平铺直叙，不打标**；引号台词与 \*\*内心想法\*\* 用快速打标 API（OpenAI 兼容，约 0.2s/条）标注情绪。
- 🗂️ **11 情绪体系**：SFW 六种（喜/怒/哀/乐/着急/平静）+ NSFW 五段（挑逗/渐入佳境/激情互动/高潮迭起/缠绵悱恻，按情节先后）；词典与 Prompt 均可编辑。
- 🎙️ **声线库（克隆 + 设计双模式）**：每个角色可以上传参考音频 + 精确文字稿克隆音色，也可以纯文字描述设计音色；克隆模式下情绪指令只"偏移"克隆底色（cfg 语义由引擎模板层保证），音色不飘。
- 😂 **内嵌声音事件**：`[笑] [咳嗽] [清嗓子] [叹气]` / `(laugh) (cough) (clears throat) (sigh)` 由 LLM 按剧情注入朗读副本，或直接透传角色卡里已有的标签；其余未知括号标签自动剔除，**不会被念出来**。
- 🗣️ **三路分声**：配合 ST 多声线模式，引号台词 / 星号动作 / 旁白 各自映射不同声线（动作和旁白可设为静音）。
- ⚡ **流式低延迟**：句级分块 + **PCM 流式切片**（引擎 TTFA≈0.13s，首片 2 秒音频约 2 秒出声）；
  消息渲染即后台预分析情绪，首块不等 LLM（规则兜底即时出声，后续块应用 LLM 结果）；
  引擎单并发 409 自动退避重试。
- 🧰 **安全清洗**：markdown、代码块、`<think>`、OOC 括号全部剥离后再送 TTS。

## 系统要求

- SillyTavern ≥ 1.12.0（在 release 分支 1.18.x 上开发验证）
- 一个已启动的 Breeze TTS 2 推理引擎（`breeze_infer.api`，默认端口 9897），且已开启 CORS
  （本仓库配套的引擎入口默认开启 CORS，可用环境变量 `BREEZE_CORS_ORIGINS` 收紧来源）
- 显卡显存 ≥ 12GB（引擎约需 10.9GB；官方 `--fast-all` 需要 24GB，12GB 卡请保持默认 fast 组合）

## 安装

### 方式一：SillyTavern 扩展安装器（推荐）

把本项目推到一个 git 仓库后，在 SillyTavern 的
**扩展面板 → Install extension → 用 git URL 安装** 填入仓库地址即可。

### 方式二：手动拷贝

把整个文件夹拷到 SillyTavern 的扩展目录：

```
SillyTavern/public/scripts/extensions/third-party/breeze-tts-2/
```

刷新浏览器，在 **扩展面板** 里启用 **Breeze TTS 2**。

> 旧 TTS-Router 时代的 `gpt-sovits-adapter.js` 补丁与本扩展无冲突，但请在
> TTS 扩展的 Provider 下拉里选择 **Breeze TTS 2**（不要再选 GPT-SoVITS-Adapter）。

## 快速上手

> **设置在哪里？** 本扩展是 TTS Provider，**没有独立标签页**。它的设置面板出现在：
> **用户设置（最上方滑块图标）→ 扩展(Extensions) → TTS 板块 → 「TTS Provider」下拉选择
> `Breeze TTS 2`**，面板随即显示在下拉框下方。另外扩展设置列表里还有一个
> 「🌬️ Breeze TTS 2」独立抽屉（引擎状态、一键启用、快速指引），装好后即可见。

1. **引擎地址**：TTS 面板的 Breeze 设置区顶部填引擎地址（如 `http://<GPU机IP>:9897`），点「检测」应显示 ✅。
2. **建声线**：在「声线库」新建——
   - *设计模式*：一句话描述音色（如"温柔的年轻女性，声音清晰柔软"），CFG 建议 4；
   - *克隆模式*：上传一段 ≤30 秒的干净人声 + 与之**一字不差**的文字稿，CFG 建议 1.5~2.5。
3. **绑定角色**：TTS 扩展的 **Voice Map** 里把角色映射到刚建的声线名称。
4. （可选）**多声线**：在 TTS 扩展设置勾选
   **Different voices for "quotes", \*text inside asterisks\* and other text**
   （该选项建议配合 **Pass Asterisks to TTS Engine** 开启、并关闭 "Only narrate quotes"
   与 "Ignore \*text\*" 两个选项）。之后 Voice Map 里每个角色会出现三个条目
   （Quotes / \*Text inside asterisks\* / Other text），动作与旁白可以指到
   「叙述者」声线或 🔇 静音。
5. 开聊。每条角色消息渲染后会先经 LLM 标注情绪（有句级缓存），随后逐句合成播放。

## 情绪引擎

- **分层**：消息先按 Router 经验切分——`**…**` 为内心想法，`"…" “…” 「…」 『…` 为台词候选
  （引号内容默认按台词处理；拟声词、≤4 字且无句读且引号前没有说话动词的，按强调/引用归入旁白），
  其余全部为旁白。**旁白不打标、不叠情绪**，用「旁白声线」平铺直叙（可在设置中指定）。
- **打标**：台词与内心想法逐句送打标后端，输出 1~11 的数字（max_tokens 很小，约 0.2s/条）。
  后端三选一：**独立打标 API**（OpenAI 兼容：地址+模型+密钥，推荐，例如 TTS-Router 时代
  的快速分类模型）/ **SillyTavern 当前 LLM** / **关闭**。失败自动熔断 60s，退回标点规则。
- **时序**：消息一渲染就后台预分析（与 TTS 排队并行）；合成首块若缓存未就绪则立即用
  标点规则出声（不等打标），第 2 块起应用打标结果。
- **缓存**：句级缓存（同一句不重复分析，编辑/重 roll 自动失效）。
- **词典与 Prompt 均可编辑**（设置面板 → 情绪打标）。默认词典刻意克制，避免"做作"。
- **语速**：整体提速用 TTS 扩展自带的「Playback Rate / 播放速度」设为 1.15（浏览器变速
  不变调），比 Prompt 提示语速更可控；特殊情绪的语速差异由词典描述表达。

## 声线的最佳实践（来自 Breeze 官方说明）

- 参考音频：干净人声、无背景噪声；文字稿必须是**逐字转录**（含语气词）。
- 参考 ≤30 秒：参考音频按 12.5 token/秒 计入 2048 帧总预算，过长会挤压生成空间。
- 设计模式指令写"音色+气质"（人称、年龄、质感、语速），中文角色用中文描述。
- 想强化指令遵循就提高 CFG（克隆模式 2~4），但过高的 CFG 在克隆模式下会
  削弱音色稳定性，请自行权衡。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 「检测」显示无法连接 | 引擎没起 / 地址错 / **CORS 未开**（浏览器 F12 里看到 CORS 报错即此类） |
| 全部请求 409 | 引擎单并发被占（预览播放中/其他客户端在用），插件会自动重试 4 次，仍失败请稍后再试 |
| 503 | 引擎在加载模型（冷启动 warmup 约 1 分钟），等待即可 |
| 声音里念出括号内容 | 关闭了「剔除未知标签」？或角色卡用了非白名单事件（可把其改写为 8 个合法标签） |
| 音色和预期不符 | 克隆模式检查文字稿是否逐字一致；设计模式尝试提高 CFG 到 4 并丰富描述 |
| 情绪永远"中性" | LLM 分析失败走了规则兜底——打开浏览器控制台看 `[BreezeTTS2]` 日志；或在设置里关闭「模拟 LLM 失败」类选项/检查当前 API 是否可用 |
| Voice Map 里找不到声线 | 点 TTS 面板的刷新，或先在本扩展设置里「保存声线」（会触发 Voice Map 重建） |

## 开发与测试

```bash
node test/run-tests.mjs    # 纯逻辑单测（清洗/分块/WAV/情绪/声线库）
node test/mock-server.mjs  # 起模拟 ST + 模拟引擎（:8125 控制台 / :9899 引擎）
# 浏览器打开 http://127.0.0.1:8125/ 可视化联调完整链路
node test/run-e2e.mjs      # 无头端到端：provider 管线 → 模拟引擎（含 409 重试）
```

## 目录结构

```
manifest.json          # ST 扩展清单
index.js               # 入口：等待 TTS 扩展后注册 provider
src/provider.js        # provider 契约实现 + 设置界面
src/engine-client.js   # 引擎 HTTP 客户端（409 退避、PCM→WAV）
src/emotion.js         # 情绪引擎（LLM 分析/缓存/词典编译/规则兜底）
src/text.js            # 清洗、事件白名单、分句分块
src/voices.js          # 声线库存取、导入导出、静音声线
style.css              # 设置面板样式
test/                  # 单测 / 模拟环境 / 端到端
```

## 许可与致谢

- 本扩展代码仅供自用学习。
- [BreezeBlue/breeze-tts](https://github.com/breezeblue-ai/breeze-tts)（Apache-2.0）；
  Breeze TTS 2 模型权重与产出受 BreezeBlue 研究与非商业许可约束，请遵守。
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) 及其 TTS 扩展框架。
