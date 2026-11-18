# 安卓分支验证记录

日期：2026-11-18（Asia/Hong_Kong），更新至 1.0.5；首版验证于 2026-11-16。上游基线 `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`；发布分支 `android-lite`。1.0.5 为 GitHub 预发布，保留仓库的 `main` 分支。

## 已完成

| 检查 | 结果与边界 |
| --- | --- |
| TypeScript | `pnpm type` 通过 |
| 前端静态检查 | `pnpm lint`：126 个源文件，0 错误、0 警告 |
| 生产前端构建 | Rspack 2.0.2 成功；附带上游 MIT 和运行时依赖原始许可证/NOTICE |
| JS 单元测试 | 38/38通过（另增音频路由Manifest精确权限集合回归）：原有13项 + 17项日志隐私/边界/污染/重载测试 + 6项PCM重采样/WAV格式与时长边界 + 1项真实Java事件wire与前端白名单跨语言契约 |
| 浏览器回归 | Windows Edge headless，29/29 通过（在 1.0.4 的 22 项上新增 4 项长会话流式与 3 项启动回归）；包含模拟授权弹窗/真正后台/迟到流释放、无PCM/ASR错误、日志导出/开关/清空/隐私，以及原有审核/会话/多尺寸回归 |
| 官方接口无凭据检查 | 5 类接口 OPTIONS 均 HTTP 200，允许 `https://appassets.androidplatform.net` 源及请求方法/头；不产生模型调用费用 |
| 源码审阅 | 父 agent 审阅集成 diff，独立 agent 复审桥/启动/音频/附件/来源外链；`git diff --check` 通过 |

浏览器的原有 15 项回归包括（本次另增6项语音/日志回归，见下节）：Key 输入与保存失败、官方请求结构/思考/搜索/历史/复制、返回键层级、ZIP 导入导出及旧数组 API 缺失兼容、取消导出、网络错误、Markdown/代码/KaTeX/Mermaid+CSP、图片上传/预览/保存、模拟 PCM→WAV→ASR 与切后台取消、合成 PCM 朗读收尾，以及主题/布局。

**浏览器的原生桥和 API 响应为模拟实现，不是安卓系统/真实模型服务。** PCM 输入测试直接驱动录音回调以验证编码与状态机，不验证实体麦克风：本机 headless Edge 的合成 16 kHz AudioContext 显示 running 但 currentTime=0，不能把它当成真实音频采集成功。TTS 用合成 PCM 验证 Web Audio 调度/关闭，不验证官方音色质量或音频设备。

“WebView 105 兼容”检查包括源码/API/CSS 下限审查、移除 `toSorted`/`toReversed` 依赖、动态视口单位回退，及在较新 Edge 中主动移除新数组 API 后的发送/导入回归。**没有运行真实 105 版安卓 WebView 或 Android 8 真机。**

## 1.0.5：长对话流式更新与启动解耦

- 同一台 Windows 电脑、同一套 Edge/模拟 Android 桥、相同会话与 SSE 输入，对比已有 1.0.4 前端产物和 1.0.5。分别预置 20、200、1000 条消息；首个增量可见后再逐次发送 6 批文本，确认每批都渲染。各规模的整条历史数组 `map` 调用均由 **18 次降到 0 次**。统计范围不含打开会话、发送时构建上下文、生成收尾与备份；不是帧率、总体 CPU 或真机时延指标。
- 请求对照确认 1000 条历史仍全部送入模拟接口，未截断上下文。回归覆盖流式滚动锚点、后台快照、生成中导出、停止后重载及分支切换；IndexedDB 与 ZIP 格式未变。
- 首屏仍等待 Key 安全初始化和迁移，但不等待原生日志同步应答。模拟日志桥挂起时聊天界面可以输入；模拟密钥桥失败时不启动聊天、不回退到明文 Key。启动同步读取队列执行时的开关值；失败不阻塞后续手动写入。原生已经保存的关闭仍在 WebView 启动前生效；若两侧配置散失或不一致，原生默认行为未改。
- 不改原有录音、权限和大备份实现。安卓性能与实体麦克风仍待真机验证。

## 1.0.4：真机NotReadableError与WebView路由权限

- 读取用户提供的1.0.3导出日志（2026-11-17T08:49:08.651Z）。真实设备Android SDK36 / WebView156.0.8078.47：四次native.permission.result均granted=true/status=0，随后getUserMedia均NotReadableError；没有audio.capture.start或ASR请求，故错误发生于打开音频输入源，不能当作API错误或仅凭错误名断言占用。
- 旧合并Manifest只声明INTERNET/RECORD_AUDIO。补上MODIFY_AUDIO_SETTINGS，依据[Chromium setCommunicationDevice检查](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/base/android/java/src/org/chromium/media/AudioManagerAndroid.java)及[同类Android16报告](https://github.com/NativePHP/mobile-air/issues/144)；当前为高度吻合的配置缺项，不声称已拿到用户设备底层route失败logcat。
- 新增Manifest三权限精确集合回归，禁止误添WRITE_SETTINGS；实际APK还需aapt核对。原生snapshot及前端导出新增独立audioSettingsGranted布尔，JVM检验RECORD_AUDIO=true但route权限=false不被错误合并；浏览器模拟NotReadableError时保留错误分类/两权限状态，不误当作ASR或泄露消息。
- 不增加录音库、代理、无限重试，不放开可信源，不主动设置系统音量/路由/隐私开关。仅补WebView自身选择音频输入所需的普通权限。
- 本机adb仍无设备；此次日志是真机证据，但修复后的成功采音/真实ASR仍须用户覆盖安装确认。不要卸载或清除会话数据；若失败回传1.0.4新日志。

## 1.0.3（历史）：语音路径修复与有界隐私日志

- 用户现象为“点击没反应或立即恢复”。本次 `adb devices -l` 仍无设备，不能确定该手机的所有实际根因，也没有读取到该手机的 crash/exit-info；没有把未见日志当成无崩溃。
- 确认旧代码 onPause 无条件发 android-background，前端取消等待授权的 getUserMedia。改为 onPause 不取消、onStop 才后台取消，并用权限状态机隔离迟到/错误 requestCode；Home→stop→resume 后旧授权不能复活。
- 在用户手势内同步创建/恢复原生采样率 AudioContext，之后请求麦克风并进行有状态降采样，不再强制硬件以16k运行或吞掉resume失败。WAV固定16-bit/mono/16k，默认设备8/16/44.1/48/96/192k转换通过数学/跨块一致性测试；120秒限制、空数据提示、5秒无PCM watchdog、取消/迟到流关闭均覆盖。
- 有界日志采用严格事件/字段/枚举白名单。前端256条/64KiB、原生128条/64KiB；重载再清洗。只有用户手动导出JSON，不记录Key/聊天/录音/转写/附件/原始错误消息或stack、URL/路径/设备唯一ID，不自动上传。
- 新增6个浏览器模拟回归：授权遮挡不误取消、真实后台取消及迟到流释放、拒绝授权和日志隐私、关闭/清空/刷新后不追加、无PCM超时、ASR403原始响应不泄漏。API和原生桥为模拟，输入PCM是确定性夹具，**不是实体麦克风/真实ASR验收**。
- 原生纯逻辑/JVM **43/43通过**：在原有13项上增加权限生命周期、诊断缓冲区、SharedPreferences fake持久化及真实snapshot wire/status契约测试。复审修正native.*前缀与非负状态枚举不一致，防止权限日志在前端导出时被静默丢弃；仅固定映射迁移旧事件名/状态，不放开任意字符串。JVM fake不能替代Android运行时私有存储验证。
- 测试过程还区分了SSE正常结束主动cancel reader产生的 Chromium `ERR_ABORTED` 与在途请求被取消：抓取失败trace确认该次HTTP200且完整回答结束后才中止，审核热切换回归现仅禁止仍由server gate持有的请求发生abort，不把协议正常清理误判为开关失效。

## 1.0.2（历史）：设置开关与热生效边界

- 新增“设置 → 通用设置 → 额外内容安全审核”，默认关闭，使用本机 localStorage 保存；中英文文案、`role=switch`、状态/描述关联及 44px 触摸目标，无额外依赖。
- 开启发送 `safety_check: {"level":"high"}`；关闭省略该字段，恢复默认检查。设置同步更新 Zustand，请求在附件准备结束后、每次实际发起/重试前读取最新设置，不在组件闭包或旧会话快照里固定该值。
- “热生效”指**无需重启，之后发出的请求采用新值**，包括续写/重新生成。已经提交的请求体无法由客户端更改；切换不取消、不自动重发当前生成，也不恢复旧拒答内容。
- 新增模拟接口浏览器回归：保持首个关闭审核的 POST 在途时打开开关，确认原请求不变、下一次续写/重新生成携带 high；保持 high 的请求在途时关闭，确认原请求仍 high、下一次追问不带该字段。另测刷新后持久化、英文切换、键盘 Space 操作与 320px 窄屏。**15/15 浏览器回归通过**；TypeScript、前端 lint（0 错误/警告）、13 个 JS 单元、13 个 JVM 测试、生产构建、离线 APK 打包/资产核对与原生 lint 均通过。
- 这些回归检验真实前端代码构造的 HTTP JSON 和本地状态机，API/原生桥响应是模拟的，**不代表真实服务器审核效果、音视频设备或手机验收**。官方文档将 safety_check 定义为请求参数，未提供修改已提交生成之审核参数的接口。

## 1.0.1（历史）：移除 demo 显式开启的额外审核

以下是 1.0.1 当时的读数和行为；当前 1.0.2 已允许用户在设置里开启 high，并非永久禁止发送该字段。

- 对照 [上游固定提交源码](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/store.ts#L40-L41)、[官方模型内容安全指南](https://api-docs.deepseek.com/zh-cn/guides/safety/) 与 [Anthropic 兼容指南](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)确认：原实现每轮发送 `safety_check: {"level":"high"}`；官方支持不传参数，等同 `low` 默认检查，不是零检查。
- 已删除强制 high 常量、请求字段和必填类型；保留搜索/阅读链接、思考及其他官方功能，不添加绕过服务端限制的提示词或代理。
- 新增浏览器回归实际截获序列化 POST JSON，逐一检查首次发送、续写、重新生成、编辑重发、开启思考/搜索后的追问均无 `safety_check`；通用 mock 也对图片等请求断言该字段不存在。
- 模拟服务端在无该字段时仍返回 `refusal`，确认客户端正确兼容；没有删除服务端拒答处理或伪装成功。编译产物 JavaScript 中检索 `safety_check`/`SAFETY_CHECK` 均无匹配。
- 本次 TypeScript、前端 lint、生产构建、13 个 JS 单元与 13 个浏览器回归通过；安卓离线打包、13 个 JVM 纯逻辑测试、assets 逐字节核对及 APK v2 签名校验通过。签名证书与 1.0.0 相同，versionCode 已增至 2，具备覆盖升级条件（未在手机上验证升级）。
- **未用真实 API Key 做内容审核对照实验**。这里只验证客户端不再显式开启 high，不能宣称模型/服务端默认检查、联网工具拒答或相关计费已被全部取消。公网 OPTIONS 读数沿用 2026-11-16 的结果，见下节。

## 官方 API OPTIONS 读数

未发送 API Key 或聊天/文件内容。所有五类读数均返回对应 origin、方法与请求头：

| 路径 | 方法 |
| --- | --- |
| `/models` | GET |
| `/anthropic/v1/messages` | POST |
| `/anthropic/v1/files` | POST |
| `/v1/tools/asr` | POST |
| `/v1/tools/tts` | POST |

这仅证明当时从本机可达且服务器允许预检；不证明具体账户余额/授权/模型/文件/搜索/语音服务成功，也不保证未来不变。

## 原生与 APK

GitHub 预发布附件使用 `node android/build.mjs preview --offline --no-daemon` 生成的非调试 `app-release.apk`，不是下方的本地调试包。通过 `verify-apk`、`apksigner`、`aapt` 及 ZIP 对齐校验：同包名、同证书、版本 1.0.5/code6、无调试标记、权限未变。预发布附件的确切哈希见 Release 说明。

### 本地调试包对照

- 最终 `node android/build.mjs debug --offline --no-daemon` 成功；最终原生 JVM **44/44** 通过。lint **0 错误 / 1 条 Gradle 更新提示**（不是应用功能或安全告警）。
- 父 agent 独立重跑 `node android/verify-apk.mjs` 与 SDK `apksigner verify --verbose --print-certs`：均退出 0。
- [测试 APK](android/app/build/outputs/apk/debug/app-debug.apk)：**2,667,586 字节（2.54 MiB）**；版本 1.0.5 / code 6；包名 `io.github.swordsifu.dsapichat`；minSdk 26 / targetSdk 35。
- SHA-256：`80a660fe11fc32ae6061e16e1b4317bfd8658da098311f487d741f37c8070d63`。
- 签名 v2 验证通过；签名者 `Android Debug`，证书 SHA-256 `53b689437132de29ccf69b1aecd928bc635dee47368c36e13ddd8204a3207fd7`。这是可调试测试构建，不是正式私有签名版本。
- APK 内 **116 个 assets** 与最终前端产物逐字节一致；保留 **20 个 WOFF2**，只排除 **40 个旧字体**，节省 **816,780 字节未压缩资源**。APK 内前端资源共 3,971,045 字节（不等于安装占用/RAM）。
- `aapt dump permissions/badging` 实查：声明 `INTERNET`、`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`（音频路由普通权限自 1.0.4 起声明，无 WRITE_SETTINGS）；麦克风 optional；Activity 正确展开为 `net.deepseek.chat.MainActivity`；支持 small/normal/large/xlarge 屏幕。源码/Manifest 无 service、存储权限或 largeHeap，禁备份/设备迁移与明文 HTTP。
- 无 ABI 专属 native-code 条目；没有捆绑 Chromium。

## 环境与未完成验证

- Node v24.22.1、pnpm 12.14.0、JDK 21.0.11、Android SDK 35、Gradle 8.13 / AGP 8.13.2。
- `adb devices -l` 在 2026-11-18 探测时无设备；未进行 1.0.5 手机/模拟器安装验收，也未使用真实 Key 进行付费 API 调用。
- 未验证真实 Android Keystore/硬件后端、SAF 文件读取/云提供方/空间不足、实体麦克风与权限框、真实 ASR/TTS、键盘/刘海/返回键、后台回收及覆盖升级。
- 没有实测安卓 RAM/PSS、CPU、耗电、冷启动时延；不以桌面进程或 APK 大小替代这些指标。
- 调试签名 APK 仅用于自用验收；正式签名、商店发布和所有设备上的兼容性均未完成。

详细设计、构建方式、数据范围、回退及真机验收清单见 [ANDROID.md](ANDROID.md)。
