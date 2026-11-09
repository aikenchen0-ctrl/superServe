# 同代次增量ICE实验契约

日期：2026-11-08。适用Web、Android、iOS使用的共同HTTP接入；仅本机Chrome实测，
不提供原生SDK，不允许跨设备连接当前回环媒体进程。本契约只补候选追加，不实现ICE重启。

## 协商与请求

`POST /whip`、`POST /whep`成功响应新增：

```http
ETag: "<当前会话的随机标识>"
Accept-Patch: application/trickle-ice-sdpfrag
```

ETag是该ICE代次的强验证标签，不是身份凭据。当前不支持ICE重启，同一会话终生使用同一标签。
创建结果未知时不自动重发。拿到Location前须缓存后续候选，不能先丢弃它们。

向不透明Location发送`PATCH`，正文类型为`application/trickle-ice-sdpfrag`，
`If-Match`为201返回的完整ETag。凭据模式仍需相同房间、角色和所有者的直播Bearer，
使用旧代次、已撤权或已到期凭据均不能靠候选更新复活会话。

```sdp
a=ice-ufrag:abcd
a=ice-pwd:abcdefghijklmnopqrstuv
m=video 9 UDP/TLS/RTP/SAVPF 96
a=mid:0
a=candidate:1 1 UDP 2130706431 127.0.0.1 30000 typ host
a=end-of-candidates
```

允许会话级或媒体节级ICE凭据，最多两个音频/视频节；MID、媒体种类及凭据必须匹配原协商。
媒体行只接受现有`UDP/TLS/RTP/SAVPF`及有限数字payload列表，不重新协商方向、编解码或轨道。
不支持任意SDP属性扩展。结束标记是允许的空更新，不触发ICE重启或新的Rtc。

候选语法交给固定str0m。不能解析的合法mDNS候选、合法但未支持的TCP候选按RFC9725忽略，
继续处理其余候选；没有DNS解析器。mDNS校验使用仅用于校验的替代地址，替代地址不注入Rtc。
格式错误、凭据重复或含控制字符的片段拒绝，不能以“忽略未知候选”容忍整个正文任意格式。

## 响应

| 条件 | 状态 |
| --- | --- |
| 同代次更新或已知候选重试 | 204，无正文、不返回新ETag |
| 无单一If-Match | 428 |
| 旧ETag、弱标签或标签列表 | 412 |
| ICE凭据变化或If-Match为`*`的重启请求 | 422 |
| 请求类型不支持 | 415 |
| 非法片段、未知MID或媒体种类不符 | 400 |
| 缺少/失效/撤权凭据 | 401 |
| 角色、所有者不匹配或会话已回收 | 404 |
| 超过8KiB | 413 |
| 队列满或会话候选预算耗尽 | 503 |

校验失败前不注入任何候选；运行期发送或协议错误可能发生在更新之后，发生这种错误时关闭该会话，
不承诺跨网络失败的事务回滚。客户端不自动重发未知请求；相同候选的显式重试只会去重。

## 预算与生命周期

单次最多8KiB、32条候选；同一会话保存最多64个规范化的已信令候选键。
该数量不包含str0m自动发现的对端反射候选，不代表完整ICE状态或RSS硬上限。
候选处理沿用每房间4条命令队列，每次Rtc公开修改后排空输出再处理下一项。
没有新的协调服务、DNS任务、转发服务或依赖包。

PATCH不移动会话租期、授权上限和房间分配下界。取消等待且尚未执行的命令可直接丢弃；
已经执行的修改不能因HTTP响应丢失回滚。会话退出时同时回收候选键。
本轮保留HTTP监听及UDP收发的回环守卫，不能用PATCH把实验进程变成公网UDP探测器。
新增统计`trickle_updates`表示成功更新次数，`trickled_candidates`表示新增信令候选次数；
两者不证明媒体实际选用了这些地址。

## Web实验

默认页面保留完整收集。`?ice=trickle`显式开启候选队列、串行PATCH、ETag校验和取消清理。
配置上限64个待处理标识；退出或切换播放代次会移除监听、停止后续队列并中止在途HTTP。
当前Web实验跳过mDNS候选，并允许完整ICE通过对端反射建立回环连接。

`playwright-trickle-ip.config.json`只用于验证字面IP候选路径，关闭Chrome的mDNS隐藏特性，
不是生产客户端配置。正常mDNS浏览器仅成功提交结束标记的结果与字面IP注入结果分别记录。
两类结果均不能替代真机、TURN、公网TLS、物理多机、弱网或采集到显示延迟验收。

来源、失败保留和最终收据见
`../../vedioServerRefer/problem-space/live-trickle-evaluation.json`。
