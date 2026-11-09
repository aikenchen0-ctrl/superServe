# 终端HTTPS信令与私网媒体契约

日期：2026-11-08。显式实验能力，不是公网、物理多机或生产准入。
Web、Android和iOS使用同一会话协议，不能从Web验证推导原生真机已接通。

同日后续新增默认关闭的`client_ice`配置发现，详见[live-ice-discovery-v1](live-ice-discovery-v1.md)。
仅此HTTPS入口挂载；非预检鉴权OPTIONS和成功创建POST可返回有限TURN Link，
匿名、CORS预检和资源读无凭据。原浏览器无需从夹具取得TURN密码；
这不是生产按主体签发/撤销，亦非原生SDK或公网准入。

## 入口与身份

通过绝对路径环境变量`VS_LIVE_SIGNALING_TLS_CONFIG`加载至多16KiB配置，
结构见`live-signaling-tls-v1.example.json`。必须已配置直播JWT和RoomControl；
没有身份或房间控制时拒绝启动，不能静默退回匿名模式。

该监听只合并原WHIP/WHEP会话接口，包括已有的GET/HEAD/OPTIONS、POST、PATCH、
DELETE和显式续权扩展，不提供HTML、脚本、诊断或`/admin`路由。
返回的Location使用配置中的HTTPS名称、端口和房间前缀，不信任Host以外的转发头。
默认443省略端口，其他端口精确匹配。没有通配Host或自动重定向。

终端只需原`vs-live+jwt`，按角色、主体、租户、房间、节点、启动代次、分配版本及期限验证。
不要求客户端证书；无Origin的原生请求仍必须有JWT。
终端不能持控制令牌代替用户JWT，HTTPS握手成功也不授予协调或运维身份。
原内部mTLS装载与服务函数保持显式独立，不在原接口里加入可配置降级。

服务端使用原Rustls验证本地CA链、ServerAuth、名称、有效期、leaf指纹和明确私钥匹配。
沿用TLS1.3/HTTP1.1、有界32连接、2秒握手/头部、32KiB头部缓冲和30秒连接上限；
信令保留64KiB正文和8秒请求期限，鉴权与媒体命令队列继续使用原预算。
这些是当前保护预算，不是容量或延迟基准；未确定最低Android/iOS系统版本。

## 浏览器与原生

`allowed_origins`至多8个唯一精确来源，空列表表示不接浏览器来源请求。
只允许规范HTTPS根来源；HTTP仅允许明确回环IP供本地实验。
拒绝通配符、`null`、凭据、路径、查询、片段和非规范默认端口写法。
未列入的Origin直接拒绝，不靠`Sec-Fetch-Site`或转发头声明可信。

允许的跨源预检仍不创建会话；响应只回显准确来源，设置`Vary: Origin`，
暴露Location、ETag、Accept-Patch和原租期头，不允许凭据式CORS。
原生无Origin不等于匿名，所有修改仍经原JWT中间件和媒体线程。

旧实验页面默认仍请求同源接口；实验夹具可明确设置`window.liveSignalingRoot`，
仅允许同源或HTTPS根地址，返回资源必须处于同一信令来源。
这不是生产客户端发现或登录签发协议，不接受URL查询参数指定任意凭据接收方。

## 私网UDP

省略`media`时保留旧回环UDP。启用时必须指定非零端口与真实RFC1918/ULA网卡地址，
不能使用通配、回环、公网、链路本地或任意宣告地址替代实际绑定地址。
`peer_ips`为1至16个唯一、同地址族的明确私网对端IP，不支持CIDR或任意来源。
接收与str0m输出发送使用同一不可变策略；会话共享Arc，不逐帧复制名单。
新增的blocked字节计数仅表示应用丢弃的UDP负载，不是线路计费或带宽收益。

这允许当前受控私网客户端使用原ICE/DTLS/SRTP，不重写协议、转码或媒体内核。
它不是公网ICE、STUN/TURN、NAT映射或跨机恢复；不能直接删除私网/对端守卫来扩大范围。
修改对端配置需要受控重启和新的节点代次/分配，不代表目录热迁移已经实现。
原多房间构建路径复用该入口，但本轮真实HTTPS播放只验单房间，未认证多房间容量。

## 复测与边界

先显式`cargo build -p vs-tls -p vs-coordination -p vs-live --all-targets`；
单独`cargo test`构建测试目标不保证更新跨包使用的`vs-live.exe`。
所有依赖、目标和临时路径仍须先加载`D:\CodexVideoTools\enter.ps1`。
Windows下构建、Clippy及独立进程实验对同一目标目录必须串行，
不能在媒体/协调可执行文件仍运行时重链它。

`labs/webrtc/run-signaling-tls.ps1 -SkipBuild`验证原生形状HTTPS会话、拒绝路径和自然停机。
`labs/webrtc/run-signaling-browser.ps1`自动准备临时证书、3协调和1媒体、
运行CLI浏览器检查、写入结构化结果并回收进程。
浏览器仅为临时服务SPKI设定向例外，明确禁用该实验浏览器代理；
不修改系统信任、防火墙、用户浏览器或全局证书验证。
浏览器例外本身不证明生产证书链可信；另由无危险开关的Rust HTTP客户端验证CA及错误名称拒绝。

真实播放验收使用H.264+Opus、一发布两订阅、画面变化与音频解码信号、
实际私网ICE选路及桌面/移动宽度截图。移动宽度不是Android/iOS设备。
浏览器模式结束后明确终止实验媒体；非浏览器模式另外验证自然停机，两者分记。
当前没有总体CPU、线路带宽、捕获到显示延迟或推荐效用改善结论。
详见`../../vedioServerRefer/problem-space/live-signaling-tls-evaluation.json`。
