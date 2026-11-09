# 真实媒体交接实验

在项目根目录，先加载工具环境，再构建两个Rust程序：

```powershell
. 'D:\CodexVideoTools\enter.ps1' -KeepLocation
cargo +1.96.0 build --manifest-path vedioServer/Cargo.toml --locked -j 1 `
  -p vs-live -p vs-coordination
```

Playwright CLI沿用已缓存版本，浏览器、守护会话和变换缓存均在O/D盘：

```powershell
$env:NO_UPDATE_NOTIFIER = '1'
$env:PWTEST_DAEMON_SESSION_DIR = 'O:/CodexVideoBuild/tmp/webrtc-cli'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:/CodexVideoBuild/tmp/playwright-transform'
node vedioServer/labs/coordination/verify-handoff.mjs `
  O:/CodexVideoBuild/target/debug `
  O:/CodexWorkspaces/superServe-video-b4be/.artifacts/room-handoff/run-new `
  D:/CodexVideoTools/npm-cache/_npx/31e32ef8478fbf80/node_modules/@playwright/cli/playwright-cli.js
```

输出目录必须不存在。Node只作为独立测试编排与签发工具，无新增npm依赖。
脚本创建3个协调进程、2个受控媒体进程和自己的浏览器会话，
验证A播放、协调面先排空再释放、旧请求拒绝、B重新播放、B失联不被抢占。
清理只针对脚本自己创建的子进程与命名浏览器，不清理其他实验。
失败保留receipt.json和进程日志；通过不表示物理多机或自动故障接管。

生成的配置及浏览器输入夹具含内部凭据和短期JWT，
留在忽略的.artifacts目录，日志自动隐藏这些值。
不要将其加入源码、公开回执或源码指纹清单。
接口和迁移约束见../../contracts/room-handoff-v1.md。

在命令最后追加`--renewal`，先在A上执行真实有限续权实验：
一发布两订阅，仅续发布者与观看者1，跨过原60秒租限后仍使用原会话，
未续观看者回收，停止更新后全部到期，再执行原交接流程。
本轮延长约80秒，浏览器验证分阶段执行，生成renewal-*.json。
续权契约见../../contracts/live-session-renewal-v1.md。

追加`--revocation`验证受控逐令牌撤权：观看者停止、其他观看者继续，
原JWT建连/续权/管理与跨节点重放拒绝，独立新授权可建新连接，
发布者撤权级联回收。可与`--renewal`组合，生成revocation.json。
这不是生产登录、主体封禁或物理集群撤权证明。

追加`--reclamation`会在原A房间播放期间填入64条短期撤权，
验证满额503、重复幂等、到期后槽位释放、原会话持续播放及旧授权仍拒绝，
不通过排空清空记录。可与前两项组合，生成reclamation-{fill,reclaim}.json。
原始时钟回拨在Rust用例注入，脚本不修改本机系统时间。

追加`--h264`让A和B的实验网页均使用固定42e01f/mode1 H.264；
默认仍为VP8。可与续权、撤权和回收组合。
browser-b.json会记录实际RTP编码/解码帧和640×360像素证据，
不能以SDP回答包含H264代替实际解码。
当前编码子集见../../contracts/live-codec-profile-v1.md。

追加`--opus`给视频会话增加一条Opus音频轨，实验页生成440Hz单声道，
观看端使用静音分析链验证实际解码波形；不调用麦克风或播放到扬声器。
可与`--h264`、续权、撤权和回收组合。browser-b.json记录audio_evidence，
撤权/排空回执额外核对音频包停止；总能量元数据不充当解码依据。
源端音画同步和原生音频会话仍待独立验证。

若全局镜像索引缺少锁定版本，优先使用已存在的rsproxy缓存；
以下命令只覆盖本次调用，不修改全局配置或升级锁文件：

```powershell
cargo +1.96.0 build --manifest-path vedioServer/Cargo.toml --offline --locked `
  --config 'source.crates-io.replace-with="rsproxy"' `
  --config 'source.rsproxy.registry="sparse+https://rsproxy.cn/index/"' `
  -p vs-live -p vs-coordination
```
