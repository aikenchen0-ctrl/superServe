# 媒体节点在线登记契约

2026-11-07，v1。内部部署控制协议；客户端仍使用房间SDP接入契约。

2026-11-08扩展：显式`node_draining`支持保留登记但停止新房间分配，
原默认和记录false序列化保持；新模式、策略版本边界见
[节点维护契约](media-node-draining-v1.md)。

## 目标与模式

动态模式允许已运行的协调集群接纳新的媒体进程，不修改每个协调副本的地址名册。
由可信部署控制器登记，媒体进程不持有自动登记客户端，也不通过用户JWT登记。
登记是部署声明，不是健康证明、容量证明或硬件身份认证。

协调配置：

```json
{
  "media_control": {
    "endpoints": {},
    "dynamic_nodes": true,
    "control_token": "<内部控制凭据>"
  }
}
```

静态模式省略`dynamic_nodes`，继续使用原`endpoints`。
动态模式必须为空endpoints，静态模式必须包含1至64个地址，防止两种来源混用。
内部控制凭据继续共享于受信媒体和协调服务；生产隔离及轮换尚待实现。

动态标记和凭据参与既有持久策略指纹。
启用或关闭动态模式属于策略变更，已有数据库拒绝静默变更；
本轮不提供旧集群在线策略迁移或新旧二进制混合升级保证。
静态旧配置的规范JSON序列化保持不变，旧房间命令和响应形状保持。
新二进制能读取未包含media_nodes的旧状态；新增节点日志不能由旧二进制解释。
回退旧二进制前须使用经验证的迁移/恢复流程，不能直接回退动态状态。

## 写入与读取

所有入口沿用协调服务的Host、无Origin、单Authorization和service_token边界。
写操作只在领导者执行，不自动转发或重试。

`POST /v1/media-nodes/commands`：

```json
{
  "operation": "register_media",
  "operation_id": "register-media-b",
  "expected_revision": null,
  "registration": {
    "target": {
      "node_id": "media-b",
      "incarnation": "aaaaaaaaaaaaaaaaaaaaaa"
    },
    "endpoint": "127.0.0.1:32002",
    "rooms": [
      {"tenant_id": "tenant", "room_id": "room"}
    ]
  }
}
```

endpoint仅接受回环IP与非零端口，不接受域名、重定向或非回环地址。
这是当前本机服务实验的边界，不提供物理多机互联。
incarnation沿用22字节Base64URL形状；应从媒体节点当前启动描述取得。
标识沿用既有1至64字节ASCII规则，节点及房间路径段额外拒绝`.`和`..`。
每个节点声明1至8个不重复的完整租户/房间范围。

成功响应包含outcome及record，record包含revision、registration和last_command。
首次登记expected_revision为null；更新时必须匹配当前record.revision。
revision由已提交Raft日志位置产生，不使用本机时间排序。
其他有效节点已占用相同endpoint时拒绝登记；不同节点可以声明相同房间范围，
由后续条件房间分配决定唯一所有者。

删除正文：

```json
{
  "operation": "remove_media",
  "operation_id": "remove-media-b",
  "expected_revision": 7,
  "target": {
    "node_id": "media-b",
    "incarnation": "aaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

删除要求当前revision与完整目标匹配。提交后registration为null，保留版本墓碑。
重新登记同node_id必须提供墓碑revision；null或旧revision不能恢复旧状态。
相同最近operation_id及完全相同命令返回duplicate；
相同operation_id但正文不同返回conflict。
仅保留最近命令的幂等结果，不提供任意历史操作ID的永久去重账本。

`GET /v1/media-nodes/{node_id}`执行线性一致读取，返回cluster_id、node_id和record。
从未登记为record=null；删除为有revision的record且registration=null。
动态模式未启用时，两类节点入口返回404。

## 状态机约束

节点登记变化与房间分配共用Raft状态机、redb状态投影和快照。
不在HTTP层执行一次检查后就假设引用不会变化。

1. 房间Assign必须匹配已登记node_id、incarnation及声明的完整租户/房间。
2. 任一房间owner引用node_id时，该节点不能改址、换代次、改房间范围或删除。
3. 先对该节点持有的全部房间逐一完成排空和Release，才能改变登记。
4. 移除后保留墓碑；名册最多64个不同node_id，包括墓碑。
5. 先提交删除则随后Assign被拒绝；先提交Assign则随后删除被拒绝。

排空地址从持久名册读取，核对登记完整目标与房间当前目标一致。
活动房间阻止登记改址，因此读取名册与等待排空期间不能被并发改指向其他地址。
重复/冲突Release仍沿用原状态机裁决，不向新所有者发送旧排空。
媒体保持原节点代次和房间排空版本下界检查。

节点命令与房间命令共用4个未确认写入许可；HTTP取消/超时不会提前归还许可。
请求最多3秒等待；503/504仍可能代表未知提交结果，应先读取权威状态核对。
线性读取、复制与落盘是实际代偿；不增加逐帧或逐观看者的协调RPC。

状态返回：

| HTTP | outcome | 含义 |
| --- | --- | --- |
| 200 | applied / duplicate | 已确认提交，或最近相同命令的幂等结果 |
| 400 | 无 | 格式、范围、目标或端口无效 |
| 409 | conflict | 期望版本、目标或操作ID冲突 |
| 409 | in_use | 节点仍被一个或多个房间引用 |
| 409 | endpoint_in_use | 相同控制地址已登记给其他节点 |
| 409 | unregistered | 房间Assign的目标或范围没有匹配登记 |
| 507 | capacity | 固定节点槽位已满，墓碑不随意淘汰 |
| 503 / 504 | 无或未知 | 未获得确定确认；不得从超时推断未提交 |

## 边界

登记不自动拉起进程、不选择最轻节点、不重平衡现有房间。
没有TTL、心跳过期删除、自动故障转移或失联强制接管。
协调集群失联不立即中断媒体流；媒体仍受原会话期限、撤权和排空约束。
失联媒体保留所有权：重启产生新代次也不能绕过旧房间引用强制登记。

完成的是在线加入可安全承接新房间的节点登记。
跨主机安全传输、独立故障域、新节点健康确认、动态房间名册、
热点房间级联、自动扩缩和生产容量收益均需另行验收。
