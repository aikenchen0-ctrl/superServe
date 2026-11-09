# 房间分配控制面实验契约

版本v1，2026-11-07。入口为独立vs-coordination进程，
不随vs-service或vs-live自动启动；HTTP只允许固定回环节点和内部Bearer。
当前验证目标是已提交的房间分配记录，不是旧媒体已停流。

2026-11-08新增可选私网双向TLS，见
[coordination-mtls-v1](coordination-mtls-v1.md)。下文回环限定描述原明文模式；
TLS只扩展协调节点，不解除媒体连接器或旧运维CLI的回环限制。

后续已增加可选media_control先排空后释放模式及分配视图接口，
具体顺序、持久策略身份与迁移限制见[room-handoff-v1](room-handoff-v1.md)。
下文无排空模式的历史语义继续保留，不构成该模式已经启用。

## 状态与命令

每个tenant_id/room_id具有至多一个owner，owner包括媒体node_id和incarnation。
revision来自已提交Raft日志索引，只在同一cluster_id及持续保存的历史内比较。
释放后保留带修订的墓碑，不通过删除键重新获得“从未分配”状态。
实验最多64个房间键（含墓碑），最多5个固定协调节点；不是生产容量结论。

首次分配示例：

```json
{
  "operation": "assign",
  "tenant_id": "tenant",
  "room_id": "room",
  "operation_id": "request-1",
  "expected_revision": null,
  "target": {
    "node_id": "media-a",
    "incarnation": "aaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

已有记录时expected_revision必须匹配，且当前owner为null。
不允许直接覆盖活动所有者。释放使用operation=release，
必须同时匹配原revision和完整target。
Release只是可信控制面的提交动作；本轮没有验证媒体排空回执。
调用者必须另行确认旧媒体已停，不能用本接口成功代替排空证明。

同一房间的最后一个operation_id与完整命令相同，重试返回duplicate及原记录，
不会改变记录revision；相同operation_id配不同命令返回conflict。
只保留当前操作的幂等依据，之后的旧请求由版本和墓碑拒绝，
不提供无界历史幂等表或完整审计事件库。

## 接口

所有请求携带内部Authorization: Bearer，服务凭据不能下发用户客户端。

| 接口 | 语义 |
| --- | --- |
| POST /v1/rooms/commands | 提交命令；200为applied/duplicate，409为已提交的冲突结果，507为房间预算已满 |
| GET /v1/rooms/{tenant}/{room} | 经ensure_linearizable后读记录；不存在为200及null |
| GET /metrics | 本地Raft观测，不构成最新分配、健康或权威读证明 |
| POST /admin/initialize | 首次初始化固定voters；已有状态时拒绝重新初始化 |
| POST /admin/learners/{id} | 将固定名册节点加入学习副本并等待追赶 |
| POST /admin/membership | 使用OpenRaft成员变更，提交nodes集合 |
| POST /admin/snapshot | 请求构建持久快照，202只表示触发成功 |
| POST /raft/append、/vote、/snapshot | 固定节点之间的OpenRaft协议，不提供给业务客户端 |

非领导者、失去多数派或超时可能返回503/504；
写入结果必须视为未确认，不能据此认定未执行。
先向领导者作权威读取，核对operation_id、完整命令及revision。
若之后已有其他操作，仅当前记录可能不足以还原旧请求的结局。
客户端不自动跨节点重发写入，服务端不做HTTP重定向或隐式转发。

## 持久性与资源

日志、投票、committed、purged、状态机、快照均保存在同一节点redb文件。
状态机先提交redb事务，再公开内存投影；日志落盘后才调用OpenRaft确认回调。
redb沿用Immediate耐久性，缓存配置8MiB，不把缓存预算等同进程RSS。
状态或快照IO错误返回存储失败，不当作空库或不存在。
固定数据库身份包含格式代次、cluster_id、node_id，错目录身份拒绝覆盖。

单批最多16条Raft日志，快照最多2MiB、每块64KiB；
HTTP正文最多2MiB、8个并发入口、3秒HTTP期限。
房间写提案另限4个，HTTP取消或超时后仍持有许可，直到实际Raft完成；
超额请求在提案前503拒绝。其他503/504仍须按未知写入处理。
网络只连接固定名册，复用reqwest客户端，禁代理、重定向及HTTP自动重试。
心跳500ms、选举1500至3000ms是沿用参考的实验值，未按本地测试拟合生产SLO。

当前redb同步提交位于协调进程的异步存储实现内，
磁盘停顿可能影响控制面调度；生产前需测IO隔离、尾延迟及批量策略。
本进程不处理编码帧或推荐查询，不在RTP热路径上新增共识RPC。

## 未完成

媒体端接受分配、旧代次fencing、排空确认、失败接管、租约/续租、
真实发行者、跨物理机故障域、分区注入和自动扩缩容均未完成。
协调mTLS已单独验证，媒体传输和生产证书治理仍未完成。
没有按墙钟TTL自动抢占，也不承诺网络分区时同时获得可用性和立即接管。
协调成员扩容与媒体计算扩容是不同操作；增加协调副本不扩大单房间媒体容量。
集群数据整体永久丢失后不能重用旧修订；恢复须明确新身份与授权边界。
