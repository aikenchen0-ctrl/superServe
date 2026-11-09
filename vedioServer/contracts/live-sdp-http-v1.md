# 实时SDP HTTP接入实验契约

版本：v1，2026-11-07。三端目标相同：Web、Android、iOS；
本轮仅验证本机Chrome，不提供原生SDK，也不允许从其他设备连接回环实验进程。

后续已增加默认关闭的直播专用凭据模式，见[live-access-v1](live-access-v1.md)。
启用后创建和资源管理均需凭据，旧匿名JSON写入口关闭；
会话仍是同一媒体线程的状态，不提供房间分配或生产登录。

2026-11-08更新：已接入同一ICE代次的候选PATCH，详见[live-trickle-v1](live-trickle-v1.md)。
以下完整候选收集流程仍可用，但不再是唯一方式。Web实验用`?ice=trickle`显式启用增量模式，
默认仍完整收集。新增能力不取消回环、凭据、固定租期或媒体容量边界，不等同完整WHIP/WHEP实现。

## 范围

复用str0m 0.25.0与atm0s固定提交的HTTP资源结构。
实现RFC9725和WHEP草案05的客户端发起SDP、返回回答、资源删除子集，
不宣称完整规范符合性。一个房间、一发布者、最多两订阅者，
支持VP8或固定H.264视频，编码参数见[live-codec-profile-v1](live-codec-profile-v1.md)；
允许一条可选Opus单声道音源，见[live-opus-profile-v1](live-opus-profile-v1.md)；
不提供转码、混音、simulcast或录制。

## 跨端共同流程

1. 用各端WebRTC实现创建一路视频及可选一路音频的SDP offer。发布方向为sendonly或sendrecv，
   观看方向为recvonly或sendrecv；服务端回答固定为对应单向。
2. 完整收集模式先完成ICE候选收集，再将原始SDP文本作为正文提交，Content-Type为application/sdp。
   不用JSON包装。客户端必须实现完整ICE；mDNS候选没有可解析IP时仍可发起检查。
   增量模式可先提交SDP，缓存候选，取得Location和ETag后再按新契约PATCH，不必等待收集完成。
3. 仅201表示创建成功。读取application/sdp回答，并将Location保存为不透明会话地址，
   交给各端WebRTC实现设置远端回答。不要从URL推导节点、房间或会话序号。
4. 主动退出时先对Location发DELETE，再在finally中关闭本地连接。
   服务端已经因断线、发布者退出或租期回收时可能返回404，不能据此判断重复创建。
5. POST结果未知时不自动重发。新建请求可能产生第二个会话或角色冲突；
   固定租期限制残余会话，不提供“恰好一次创建”保证。

实验网页仅允许同源Location并拒绝重定向，不是完整WHIP客户端。
后续Android/iOS应绑定各自原生WebRTC实现，不以WebView替代原生验收。

| 请求 | 结果 |
| --- | --- |
| POST /whip | 发布offer；201及SDP回答、Location |
| POST /whep | 观看offer；201及SDP回答、Location |
| GET /whip、/whep | 204，无正文 |
| OPTIONS /whip、/whep | 200；Accept-Post: application/sdp |
| GET Location | 活动且角色匹配为204，否则404 |
| DELETE Location | 活动且角色匹配为200，否则404；发布者退出级联回收房间 |
| PATCH Location | 同代次候选为204；缺If-Match为428，旧代次为412，不支持的ICE重启为422 |

错误正文为简体中文。正文类型不支持为415，非UTF-8或无效SDP为400，
超过64KiB为413，媒体方向/编码不在实验范围为400，角色冲突为409，
容量或工作线程不可用为503。客户端应按HTTP状态类别处理失败，
不能依赖中文错误句子识别协议状态。

## 资源与权限

X-VS-Session-Lease是实验扩展，首次上限60秒，与媒体连接活动无关。
凭据模式另提供显式POST续权扩展，见[live-session-renewal-v1](live-session-renewal-v1.md)；
匿名实验保持不续租。续权不修改标准PATCH语义，也不重新SDP协商。
资源使用ring生成的128位随机数，再用既有base64库编码；
服务端不复用递增编号，旧进程地址不指向新进程会话。
资源地址只定位会话，不代表用户、租户或房间授权；公网仍需独立鉴权。
存活真相由同一个媒体工作线程维护，没有额外映射表或常驻协调器。

保留64KiB请求、8秒HTTP期限及4条控制队列预算。响应no-store。
同一房间首个发布者确定视频编码，订阅者参数不匹配时拒绝，不返回黑屏成功会话。
HTTP/UDP均为回环，严格检查Host/Origin/Sec-Fetch-Site；
OPTIONS只在允许的同源边界内工作，不提供任意站点CORS。
旧/lab/offer和/lab/peers只保留诊断用途，实验网页不再调用。

## 尚未实现

ICE重启、WHEP空offer/服务器反向offer、重定向、生产TLS与登录/签发、
混音、立体声源、音画同步校准、完整H.264 profile/level矩阵、TURN、
自动失联迁移、物理多机及Android/iOS真机。
当前回答保留固定str0m的a=ice-options:trickle，同时在每个媒体节标明服务端候选结束；
服务端候选已齐备不妨碍接收客户端增量候选。完整offer仍由str0m解析；片段仅有受限外层分节，
候选语法和ICE状态修改使用原库，没有改写上游ICE或DTLS内核。
双媒体节另有结构化解析回归；后续升级或扩大范围时须重新验证。

默认完整收集的等待、增量模式的额外PATCH及60秒租期均是代偿条件，不能用本机连接成功证明低延迟收益。
证据见[接入根复用与验证](../../vedioServerRefer/实时SDP接入根复用与验证.md)。
