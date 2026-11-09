# 画像共识权威实验契约

日期：2026-11-09。状态：隔离实验，不是生产默认，不是完整分片集群。

后续进展：已增加显式只读Feed适配，见[共识Feed契约](profile-consensus-feed-v1.md)。
下文“未接推荐入口”描述最初权威实验阶段；默认服务与写网关未切换。
专用读取身份和轮换证据见[读取mTLS契约](profile-read-mtls-v1.md)，
仍未证明主体级生产授权、物理扩容或历史前缀完整性。

## 目标

把以下操作放入同一份已提交的 OpenRaft 状态机：

1. 画像分片写者的取得、替换、停用及代次。
2. 画像事件事实的幂等提交。
3. 由事件重放产生的画像投影。

这样可以避免“事件日志已经确认，但旧写者仍能继续修改另一份投影”的双提交窗口。
现有 `vs-service` 单入口和固定分片模式不切换到该实验。

## 复用根

- `openraft` `v0.9.25`，固定来源提交 `8815cdba2826f74e848acef361ad03f93bb1c3f8`。
  复用现有协调节点的 `client_write`、`ensure_linearizable`、成员故障恢复和快照接口。
- `redb` `2.6.4`，复用现有 `LogStore`/`StateStore` 的事务提交、身份固定和快照落盘。
- Danube `v0.16.0` 固定来源提交 `10950acb975dcf5bfe8678311ccfd7c56db52460`，
  仅延续现有日志存储适配；来源与许可证见 `LICENSES/room-authority-NOTICE.txt`。
- `vs-core::ProfileState` 和已冻结的 `ProfileEventFacts`，保持原推荐语义和隐藏事实。

没有新增外部依赖，没有复制 Iggy 协议或完整 Qdrant 分片内核。
Iggy 继续负责行为日志候选，不能替代这里的状态事务；Qdrant 的稳定哈希和迁移阶段只作机制对照。

## 模式边界

画像实验配置必须同时提供：

- `profile_catalog`：绝对路径，最大1MiB。
- `profile_shard_count`：2、4、8或16。
- 不得同时提供媒体控制配置。

画像协调数据库使用固定 `cluster_id`、节点身份、Raft voter 名册和服务令牌。
已存在房间/媒体历史的 redb 不能自动切换为画像模式；画像目录或分片数量变化必须拒绝重启。
画像模式不暴露房间和媒体写入接口，TLS 节点证书不能调用画像实验入口；
当前实验使用既有 operator 入口，生产应另行绑定画像服务身份。

## 写者与事件

每个逻辑分片有一个当前 `WriterRecord`：

```text
revision = Raft 已提交日志索引
owner = node_id + incarnation
last_change = operation_id + CAS 前置版本
```

事件必须携带 `shard`、`writer_epoch`、`target`、`subject` 和原始事件正文。
状态机在同一提交顺序中检查：

- 事件主体哈希是否属于给定分片；
- `writer_epoch` 是否仍是该分片当前 revision；
- `target` 是否与当前 owner 完全相等；
- `event_id` 是否首次出现或与原正文指纹相同；
- 候选事实是否来自固定目录；
- 事件总数和主体总数是否在有界预算内。

旧 epoch 即使提交的是重复事件也先返回 `fenced`，不能借幂等结果伪造旧写者仍有权。
新 owner 可以对已提交事件做重复确认，但不能改变原事件事实。

## 读、恢复和不确定结果

投影读取先执行 `ensure_linearizable`，再读取已应用的 `ProfileLedger`。
写请求只发送一次；请求超时、失去多数派或返回异常时，结果保持未知，
调用方不得自动重发新的逻辑事件。
故障恢复后以 `event_id` 和正文指纹核对，不把“没有看到”解释为“没有提交”。

redb 提交成功后才更新公开内存状态。快照安装同时核对：

- `last_log_id` 和 membership；
- 固定目录、分片数量和候选事实；
- writer transition 历史、事件 revision、epoch 和投影重放；
- 画像模式不能被房间模式读取或回退。

快照和日志清理只在已验证水位后进行；分片事件与写者历史不可被独立删掉。

## 明确没有解决

本实验仍使用**一个 Raft 组承载所有画像分片**。因此：

- 写者代次和事件正确性有多数派及线性读保证；
- 分片只提供逻辑归属，不提供每分片独立共识吞吐；
- 单一 Raft 组仍是控制面吞吐、提交尾延迟和快照重放边界；
- 没有在线增加 Raft 组、跨组迁移、分片独立备份或物理故障域证明；
- 后续仅增加显式共识Feed只读适配，不改默认画像后端，也不接入通用推荐接口；
- 专用读取TLS角色并非主体级隐私授权，历史前缀/集群实例与生产发行者仍待证明；
- 没有生产密钥轮换、隐私撤回、加密归档、Android/iOS 真机或真实负载数据。

因此它关闭的是“旧写者与事实投影不在同一提交边界”的问题，
没有关闭“画像系统已经可以生产横向扩容”的问题。

## 验收

见：

- `vs-coordination/tests/profile_authority.rs`
- `vs-coordination/tests/profile_consensus_process.rs`
- `vs-coordination/tests/mtls.rs`

验收包含：代次替换、停用与ABA、跨分片同 event_id 隔离、事实篡改、
快照篡改、旧房间历史拒绝、三节点主故障、多数派继续提交、少数派拒绝线性读写、
全体重启、真实快照水位与日志清理水位、TLS 角色隔离。
