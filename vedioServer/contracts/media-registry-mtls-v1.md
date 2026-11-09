# 预授权目录内的动态TLS媒体登记

日期：2026-11-08。仅内部控制面；不开放公共SDP或媒体UDP，不代表生产准入。

## 目录与登记

`media_control`示例见`media-registry-mtls-v1.example.json`。预授权目录采用原
`endpoints`的逻辑节点到地址映射，1至64个唯一端点。TLS名称表严格一一对应，
仅回环、RFC1918、ULA及非零端口；名称也唯一。所有协调节点必须使用相同目录和名称。
私钥、客户端证书与指纹则各节点独立，仍由`vs-tls`在启动前验证。

`dynamic_nodes=true`和`tls`同时存在时，`endpoints`不是活动节点列表，
而是管理员预先批准的网络目的地目录。节点上线后再通过原运维接口登记：

```json
{
  "operation": "register_media",
  "operation_id": "join-media-a-1",
  "expected_revision": null,
  "registration": {
    "target": {
      "node_id": "media-a",
      "incarnation": "abcdefghijklmnopqrstuv"
    },
    "endpoint": "10.20.0.21:7443",
    "rooms": [{"tenant_id": "tenant", "room_id": "room"}],
    "transport": "mtls_v1"
  }
}
```

实例代次和房间是动态业务状态。地址必须与该逻辑节点的目录项完全相同，
不是只要出现在其他节点名下就可复用。未知节点、错地址或端口、缺少传输标记、
公共地址均拒绝；不会因此发起连接。缺少`transport`的旧格式仍只表示回环HTTP，
其序列化字节保持不变，不能在TLS目录中被默认为TLS。

HTTP提交校验、Raft状态机重放、快照安装、完整数据库重开和释放前检查共用相同规则。
运维客户端可读取新记录，但读取记录不会连接其中的媒体地址。
原CAS、墓碑防ABA、活动房间引用冻结、停止接单和完整fence机制保持。

## 信任与迁移

稳定策略新增`transport=media-registry-mtls-v1`及`registry_server_names`。
目录节点、地址、名称、模式和控制令牌参与原策略摘要；RPC之间必须一致，
同数据库重开不能静默变更。各协调节点的本地证书路径、指纹及私钥不参与业务策略，
证书轮换仍需单独维护服务端的协调证书允许名单和既有CA/名称约束。

目录内节点可在线登记、删去活动登记、按新代次重建，无须重启协调进程。
添加目录外信任槽位、修改地址或服务名称需要后续显式策略迁移；
本轮没有实现热修改目录、自动签发、自动发现或任意节点自助加入。
不得删库、跳过策略锁或将登记签名当作授予任意网络访问权来绕过此限制。
旧静态TLS、旧动态HTTP数据库也不能直接改配置就转为此模式。

释放仍只发一次排空请求，需相同fence、`drained`、零会话才继续提交。
失联不自动接管，超时不等于未执行；不修改媒体执行器或原有共识内核。

## 验证入口

`labs/media-drain/run-dynamic-mtls.ps1 -CoordinationIp 172.18.16.1 -SkipBuild`
仅适用于实际存在的本机接口。脚本显式执行默认忽略的跨包用例，要求唯一结构化回执，
不能把零测试匹配当成功。构建和临时产物继续位于O盘，依赖缓存位于D盘。
脚本沿用静态TLS用例的真实进程辅助函数，分别报告静态和动态结果。

真实进程实验范围为同机3协调、1媒体、0 RTC会话；即使通过，也不等于物理多机、
原生Android/iOS、真实播放、生产PKI、画像扩容或三低收益。
最新运行结果见`../../vedioServerRefer/problem-space/media-registry-mtls-evaluation.json`。
