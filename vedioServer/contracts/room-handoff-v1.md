# 房间分配接受与排空契约

版本v1，2026-11-07。固定Rust共识、验签与媒体内核继续复用；
新增的是控制面与媒体执行之间的版本约束，不提供自动失联接管。
2026-11-08增加可选[媒体只读mTLS核验](media-authority-mtls-v1.md)；
下文回环协调地址是原明文模式，自动排空连接器仍保持回环。

## 配置与启动

媒体配置VS_LIVE_ROOM_CONTROL_CONFIG，前提是已配置VS_LIVE_ACCESS_CONFIG。
多房间节点可改用互斥的VS_LIVE_ROOMS_CONFIG，完整配置与隔离规则见
[live-node-rooms-v1](live-node-rooms-v1.md)，根排空入口保持兼容。
控制配置包含cluster_id、固定回环coordination_endpoints、
coordination_token和独立control_token。错误配置在开始处理请求前失败。
启用后媒体以关闭接入状态启动，未激活前拒绝创建会话。
未启用仍保留旧本机实验；不能据此宣称全局分配约束已启用。

协调节点的media_control包含固定媒体node_id到回环地址的映射及control_token。
所有协调副本必须使用相同排空配置。配置的规范序列化SHA256作为策略身份，
持久保存于节点redb，并随Raft请求校验；不一致的成员不能交换共识请求。
策略身份不是用户授权，也不是防恶意集群节点的拜占庭机制。
已有数据库缺少策略身份或策略改变时拒绝静默升级，需要显式迁移。
静态模式不支持在线改写名册；可显式选用
[media-node-registry-v1](media-node-registry-v1.md)的共识持久名册模式。
模式切换仍需显式迁移；内部凭据轮换尚未实现。

## 接受分配

GET /v1/room-assignments/{tenant}/{room}在确认线性一致性后返回
cluster_id、租户/房间及最小record，record包含revision和owner。
旧的/v1/rooms读取形状保持。返回值是分配记录，不是媒体运行证明。

可信控制面向媒体POST /admin/room/activate，正文如下：

```json
{
  "cluster_id": "cluster",
  "tenant_id": "tenant",
  "room_id": "room",
  "target": {
    "node_id": "node-a",
    "incarnation": "aaaaaaaaaaaaaaaaaaaaaa"
  },
  "revision": 3
}
```

请求携带内部control_token，拒绝Origin、重复Authorization及用户JWT。
媒体核对房间、节点启动身份和集群，再从固定协调入口执行权威读取。
只在完整身份和revision匹配时投递工作线程激活命令。
读取入口切换只作用于GET；不自动重试写操作，不相信客户端提供的任意URL。
单次权威读取总期限2秒，最多4个控制读取在途；答复最多8KiB。

媒体工作线程维护已接受revision和已排空的版本下界。
相同活动版本可幂等接受；不同活动版本不能直接覆盖。
已排空及更旧版本永久拒绝重新激活，直到进程结束。
重启产生新incarnation并重新关闭接入，因此旧凭据与旧控制请求仍不适用。
这是进程内的执行约束，不需要把短期会话另存为分布式业务状态。

用户JWT仍为vs-live+jwt；新增可选assignment_revision，
启用房间控制时必须匹配媒体工作线程当前接受版本。
不匹配在创建Rtc前拒绝，不增加会话；不会为每帧、每包或每名观众额外执行共识RPC。

## 先排空后释放

协调面处理Release时先确认当前权威记录仍匹配expected_revision和完整target。
若匹配，向固定媒体地址POST /admin/room/drain，正文与上面相同。
媒体工作线程依次：

1. 关闭该版本的新会话接入，并记录不可重新激活的版本下界。
2. 丢弃房间全部Rtc、待转发编码帧及关键帧请求状态。
3. 返回匹配版本、phase=drained、active_peers=0的回执。

协调面核对完整回执后才将原Release提交Raft条件更新。
排空完成但释放未确认时，房间可能保持分配但不可播放；
相同Release可先核对权威记录，再幂等排空/提交，不能重新激活旧版本。
排空超时、拒绝、节点启动代次不匹配或答复损坏时不提交释放。
HTTP结果仍可能未知，不从超时反推排空或Raft提交没有发生。

Release条件已冲突或已提交时，不对可能的新所有者发送排空，
最终conflict/duplicate仍由状态机判断。旧排空命令不能清除更新活动版本。
控制面提交释放墓碑后，才允许按墓碑revision分配新目标并重新授权/协商。

## 保障范围

这条链路依赖可信控制服务、同策略协调组和所有相关媒体均启用受控模式。
用户凭据不会自动签发，未受控旁路进程不属于该保障范围。
排空表示服务端不再持有会话和转发队列，不会撤回网络中已发数据或播放器已缓存帧。
真实屏幕停帧与控制RTT/尾延迟另计，不承诺硬实时“零帧残留”。

旧节点失联时不释放、不抢占；这牺牲故障可用性以避免猜测旧节点是否仍在发送。
用户会话续权另见[live-session-renewal-v1](live-session-renewal-v1.md)，不改变房间归属。
受控模式另支持[live-token-revocation-v1](live-token-revocation-v1.md)；
未失效记录保留至到期或版本排空，普通断流或重复激活不重置。
到期回收须保持进程授权时间水位，见[revocation-reclamation-v1](revocation-reclamation-v1.md)。
房间所有权的长时租约、证明式强制撤权、可信发行者及切网恢复尚未实现。
端到端DTLS/SRTP不透明迁移，新目标使用新会话和新SDP协商。
生产TLS/mTLS、物理网络分区、Android/iOS原生、音频及联合三低收益仍需独立验收。
