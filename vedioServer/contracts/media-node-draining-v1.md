# 媒体节点停止接单与排空

<重表述提示词为问题>怎样让一个持有正在播放房间的媒体节点停止新分配，保持已有会话和控制地址，并在逐房排空后迁移和移除，且不因重试、重启或并发分配恢复接单？</重表述提示词为问题>

## 启用与版本

协调配置的`media_control`新增可选`node_draining: true`，必须同时启用
`dynamic_nodes: true`，`endpoints`仍为空。默认不启用；
未启用的节点排空写命令返回404，不产生提案。
现有登记、逐房版本控制、可信排空回执和删除接口继续使用。

```json
{
  "media_control": {
    "endpoints": {},
    "dynamic_nodes": true,
    "node_draining": true,
    "control_token": "<内部媒体控制凭据>"
  }
}
```

以上是现有协调进程配置的局部字段，不是完整可启动配置；
原服务凭据、固定集群身份、节点名册、持久化目录和监听设置仍必需。

该布尔值进入现有协调策略序列化、RPC策略指纹及redb策略绑定。
缺省/false字段省略，旧的未启用配置序列化不变。
开启时所有投票者/学习者必须理解相同的新配置与新命令；
旧程序拒绝未知字段，策略不同的RPC或已有数据库拒绝静默混用。
**这不是已有策略数据库的在线迁移方案。** 本轮使用独立新实验数据库，
不能删除生产数据绕过策略绑定，也不能向旧节点复制带新标记的快照。

## 写入与状态

使用原`POST /v1/media-nodes/commands`，原内部鉴权不变：

```json
{
  "operation": "set_media_draining",
  "operation_id": "maintenance-begin",
  "expected_revision": 23,
  "target": {
    "node_id": "media-a",
    "incarnation": "<当前22字符启动身份>"
  },
  "draining": true
}
```

`expected_revision`是节点登记记录版本，必须为1至9007199254740991的整数，
不能传房间版本代替。`target`必须与当前登记身份一致；不存在或已删除节点不能被该命令恢复。
`draining`必须为布尔值，不接受额外字段。请求共用原4个提案许可；
HTTP超时/取消不保证提案未提交，状态需通过原线性一致读取确认。

成功返回`applied`；同一最后命令重试返回`duplicate`且保留原版本。
陈旧版本、同operation_id不同参数或启动身份不符返回409 `conflict`。
多次不同命令可设置同一值，但会产生新版本，不能将其当永久去重历史。

登记记录新增`draining`：false省略，旧记录缺省false；true明确输出并进入持久状态和快照。
标记操作**只改变节点登记版本和接单状态**，不修改房间所有权、房间版本或媒体线程。
地址、允许房间范围和启动身份保留，逐房释放仍可找到原控制端点。
登记信息更新不能隐式清除排空状态；恢复必须使用匹配新登记版本的显式
`set_media_draining`、`draining:false`。删除后记录为墓碑，不再有接单对象。

## 分配与释放

所有转换在同一Raft已提交状态机内顺序执行，没有新增跨服务可变标记：

| 顺序或操作 | 结果 |
| --- | --- |
| 新分配先提交、随后节点标记排空 | 已有分配保留，后续需逐房排空 |
| 节点标记先提交、随后新分配 | 409 `node_draining`，不写房间记录 |
| 已提交相同房间分配在标记后重试 | `duplicate`，保持原房间版本 |
| 无权限/未登记范围或旧启动身份 | 继续`unregistered`，不因排空扩大权限 |
| 原房间释放 | 沿用线性读取、媒体线程排空及可信回执后提交 |
| 仍有房间时删除节点或改登记 | `in_use` |
| 显式恢复接单 | 只解除新分配阻止，不抢占其他节点已有房间 |
| 已排空房间分配给其他有效节点 | 原房间版本CAS后新分配，重新授权与协商 |

相同已提交房间命令的幂等确认先于后续接单状态；不因此改变历史结果。
其他新请求仍先检查登记/范围，再检查排空标记。
少数派、未知提交、不可达旧媒体等原有保守边界保持，不按心跳或TTL猜测旧节点已经停止。

标记停止新**房间分配**，不阻止当前房间继续加入有权参与者或续权；
否则“停止新分配但不中断当前房间”的语义会被混淆。
若业务需要冻结房间新参与者，应另定义并验证，不复用本标记作隐式访问控制。

## 维护流程

1. 提交节点`draining:true`并读取确认；正在播放的房间保持原资源标识。
2. 按已有房间版本逐个释放，等待原媒体线程真正排空及控制面确认。
3. 空节点可移除；需迁出的房间分配给已登记目标、激活新版本，客户端重新授权和协商。
4. 原节点恢复或重建需经过明确登记/版本校验；不让陈旧恢复命令覆盖新状态。

本轮不会自动选迁移目标、强行接管失联节点、复制WebRTC连接或保证无缝播放。
迁出的房间会重建媒体会话；未迁出的房间应保持原资源继续播放。
“标记已排空中”和“媒体已排空”不同，只有逐房回执可证明旧执行已停。

## 复用与验证

机制参考固定`danube-messaging/danube`提交
`10950acb975dcf5bfe8678311ccfd7c56db52460`：
`danube-broker/src/admin/brokers_admin.rs`先写draining，
`danube_service/broker_watcher.rs`在工作清空后更新状态。
这里只迁移“接单状态与逐项卸载分离”的机制，不复制其broker、元数据平台或自动卸载器。
实际复用已有OpenRaft 0.9.25、redb 2.6.4、str0m及原媒体控制接口，无新增包。

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$env:PWTEST_DAEMON_SESSION_DIR = 'O:/CodexVideoBuild/tmp/playwright-node-draining'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:/CodexVideoBuild/tmp/playwright-transform'
node vedioServer/labs/coordination/verify-multiroom.mjs `
  O:/CodexVideoBuild/target/debug <新的O盘输出目录> <playwright-cli.js> --registry --draining
```

`--registry`而不带`--draining`用于验证原动态登记路径和404禁用边界。
实验在单台Windows机器运行三个独立协调进程、两个媒体节点及真实Chrome音视频，
不等于物理多机、跨网容灾或生产扩容能力。固定回环地址约束依然存在。
它不测生产容量、三低总收益、原生播放器或真实用户推荐效用。
数据、失败与验证限制见[节点排空评估](../../vedioServerRefer/problem-space/media-node-draining-evaluation.json)。
