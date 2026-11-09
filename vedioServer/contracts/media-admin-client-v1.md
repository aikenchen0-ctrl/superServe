# 媒体维护Rust客户端

## 用途

`media-admin`是部署人员运行的Rust命令行，复用现有协调HTTP/Raft/redb状态和版本命令。
它不托管服务、不启动媒体进程、不自动选择迁移目标，也不是新的长期控制面服务。
真实协调节点的客户端凭据只从配置JSON加载，永不输出到收据或日志。

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
Set-Location 'O:/CodexWorkspaces/superServe-video-b4be/vedioServer'
# 构建既有协调服务和部署客户端
cargo build --release --locked -p vs-coordination --bins

# 线性一致预览节点及同一状态快照中的所有所属房间
media-admin.exe <协调配置.json> preview <节点ID>

# 依据当前revision提交停止接新房间
media-admin.exe <协调配置.json> apply <set-draining.json>

# 显式恢复接单，expected_revision使用上一操作确认返回的新revision
media-admin.exe <协调配置.json> apply <resume.json>

# 仅在预览所属房间为空后删除名册墓碑
media-admin.exe <协调配置.json> apply <remove-empty-node.json>

# 查询当前是否仍保存完整相同命令
media-admin.exe <协调配置.json> confirm <此前使用的完整命令.json>
```

未启用TLS时，协调配置保持原三个字段：

```json
{
  "cluster_id": "media-cluster",
  "endpoints": ["127.0.0.1:3001", "127.0.0.1:3002", "127.0.0.1:3003"],
  "service_token": "<与受信协调服务配置一致的内部Bearer凭据>"
}
```

配置和命令文件最多16KiB，拒绝未知字段。客户端约束1至64个唯一端点、
1.5秒单请求期限及最多128KiB响应；顺序读一遍端点，单遍上限约96秒，
单次写入和一次读回均不无限等待。
原明文模式继续只允许回环；2026-11-08增加下述可选私网mTLS。
私网实验不代表物理多机、生产证书治理或生产部署已经验收。
配置与命令文件由部署系统写入权限受限目录；不得提交源码或公共证据。
本工具不管理配置文件的操作系统ACL。

## 可选双向TLS

配置增加`tls`，结构见[占位示例](media-admin-mtls-v1.example.json)；
实际证书及随机凭据必须由运维提供，示例不能直接部署。
`server_names`以完整SocketAddr为键，与`endpoints`严格一一对应，
值为唯一小写DNS名称；不接受URL、通配、公网、链路本地、组播或零端口。
TLS模式只允许明确回环、RFC1918 IPv4或ULA IPv6，不允许某些端点悄悄退回明文。

`ca_file`、`certificate_file`和`private_key_file`须为绝对路径，
单文件最多64KiB、证书链1至4张。`certificate_sha256`是本地运维leaf证书DER的
64位小写十六进制SHA256，不是PEM文本摘要，也不能自行授予运维权限。
服务端仍须将该leaf列入`operator_sha256`；节点证书不能代替运维证书访问管理接口。
构造客户端时验证链、有效期、ClientAuth用途、指纹及私钥匹配，
对无法确认匹配的密钥也拒绝，不等到发起写入后再发现材料错误。

服务端身份按配置CA及DNS名验证，通过固定地址映射连接，不查外部DNS，
不使用额外系统CA、代理、重定向或自动HTTP重试。
TLS 1.3、HTTP/1.1、每host最多2条空闲连接；连接250ms、请求1500ms，
继承原响应与读回预算。非领导者或传输错误可尝试其他固定TLS读取端点，
但不会降级HTTP，也不会把一个POST重发到新领导者。
TLS超时和证书拒绝不是“提案未提交”的证明。

命令、退出码及收据格式不变，配置不进入收据。换证后重新运行CLI即可读取新材料；
已运行进程不热重载。证书签发、撤销、操作系统ACL、完整审计和多节点轮换不由CLI管理。
三节点真实Rust CLI及本机私网接口实验见
[mTLS验收](../../vedioServerRefer/problem-space/media-admin-mtls-evaluation.json)。
该证书和内部Bearer不得交给Web、Android或iOS终端用户。

## 单写入与读回

维护预览接口为`GET /v1/media-nodes/{id}/maintenance`，沿用内部Bearer鉴权，
动态登记未启用时返回404。服务先`ensure_linearizable`，再在单一状态锁内读取；
响应包含集群、节点身份、登记记录与完整所属房间，不读取本地Raft metrics替代权威结果。

- `preview`对一个节点执行线性一致读取，再在同一个协调状态锁下收集节点记录和所属房间。
- `apply`先预览。过期revision或启动identity冲突时不写；移除仍有房间时不写并返回`in_use`和预览。
- 状态机拒绝与写前预览分别记录：`service_record`是服务端提案结果，`observed`是预览。
  不将旧预览覆盖成新的服务端事实。
- 预检拒绝时`service_outcome/service_record`为空；只有真实服务提案拒绝才填写。
  `confirmed_record`仅在结果确认为该完整命令时填写，拒绝状态的记录另存`service_record`。
- 预览后最多发一次POST；HTTP重试和重定向关闭，不自动换领导者重发。
- 明确提交后返回`confirmed_record`；明确状态机拒绝保留`service_outcome/service_record`。
- POST超时、正文损坏或503后只进行有界读回。只有当前记录仍完整等于此次命令
  （operation ID、revision和全部字段）才确认成功。
- 若读回命令已被后来操作覆盖或没有权威读取，返回`unknown`；不能推断旧操作未提交。
  必须人工依据更广泛审计/操作上下文判断，不由CLI以新revision偷偷重放。
- `confirm`只查询当前保留的最后命令。后续命令覆盖记录后，历史结局保持unknown。

旧revision在写前预览不匹配可安全拒绝；如果竞争发生在预览与写入之间，
仍由Raft状态机返回冲突。关闭状态、超时和多数派丢失下，CLI可能返回错误或unknown，
不会伪装为成功。

## 退出码与收据

| 退出码 | 含义 |
| ---: | --- |
| 0 | `preview`成功，或该完整命令已明确确认 |
| 1 | 参数、配置、响应格式/身份或传输错误；若写请求已发出仍需另行`confirm` |
| 2 | 明确的conflict、`in_use`或其他状态机拒绝 |
| 3 | `apply/confirm`无法确认该历史命令成功或失败，需检查`writes_sent`区分本次是否写入 |

机器解析`apply/confirm`的最后一段JSON，检查`schema=media-maintenance-receipt-v1`和
`outcome`，不要只看进程退出码。`preview`返回`cluster_id`、`node_id`、`record`和`owned_rooms`。
相对地址、跨租户同名房间及登记版本原样带回。
收据不是审计日志或长期操作历史；默认不将配置或收据写入额外文件。

写前对照只说明一个时点。预览到写提交之间其他协调客户端仍可竞争；
最终结果以Raft状态机提交结果或完整读回为准。
人工流程见[节点停止接单与排空契约](media-node-draining-v1.md)；
真实集群证据见[运维客户端评估](../../vedioServerRefer/problem-space/media-admin-evaluation.json)。

协调包直接引用工作区已经锁定的rustls/ring，安装现有加密提供者，
避免reqwest在工作区TLS特性合并后缺少提供者而panic；不覆盖调用方已有提供者选择。
原轮锁文件只增加协调包到既有rustls包的依赖边。
本轮复用已有TLS构造和验证接口，Cargo.lock未变化，无新增包、版本或复制的密码实现。
运维客户端mTLS不扩展媒体HTTP/UDP或媒体排空连接器，不能据此宣称整个视频系统跨机完成。
