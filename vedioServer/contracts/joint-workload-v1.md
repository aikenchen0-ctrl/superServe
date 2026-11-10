# 联合工作负载包 v1

## 目的

`joint-workload-v1`是推荐、画像授权、媒体播放和客户端消费的共同输入边界。
它只校验请求级关联和数据分域，不实现回放、不选择模型、不改变缓存或媒体服务默认。

现有三类证据仍各自保留：

- 推荐质量使用`recommendation-replay-v1`及时间切分；
- 媒体交付使用`delivery-window-trace-v1`或自然播放轨迹；
- 客户端消费使用`client-consumption-v1`及消费重建。

联合包只保存这些证据的最小关联摘要和摘要指纹，不复制原始会话、主体或媒体正文。

## 结构

Rust类型位于`vs-core::joint_workload`，顶层字段：

| 字段 | 约束 |
| --- | --- |
| `schema` | 必须是`joint-workload-v1` |
| `data_kind` | `synthetic`或`observed`，沿用现有推荐回放枚举 |
| `split` | `training`、`validation`、`holdout`或`production_observation` |
| `trace_id` | 联合包的W3C根`trace_id`，32位小写非零十六进制 |
| `source_id` | 有界稳定来源标识 |
| `catalog_sha256` | 当前目录指纹 |
| `started_at` | 轨迹起始UTC秒 |
| `requests` | 1至100000条，按`observed_at`非递减 |
| `artifacts` | 最多256个输入摘要 |

每条请求至少有唯一`request_id`和平台；推荐、播放、消费关联字段可缺失，
缺失保持unknown，不补零：

- `decision_id`与`candidate_id`同时出现才算推荐关联；
- `playback_id_sha256`要求候选存在才算播放关联；
- `interaction_id_sha256`必须等于播放实例摘要才算消费关联；
- `client_bytes`、`source_bytes`、`server_bytes`、首帧、卡顿、CPU和RSS均可为空。

普通输入校验允许上述部分轨迹，用于保存真实采集中的缺失事实。需要把一份收据作为
联合归因输入时，调用`JointWorkload::validate_closed_path()`作为更高层门：它要求
`data_kind=observed`、`split=production_observation`，并要求至少一条请求同时具有合法
`trace_context`、`decision_id`、`candidate_id`、`playback_id_sha256`和相同的
`interaction_id_sha256`。该门不要求首帧、卡顿、客户端字节或CPU/RSS已经存在；这些指标
缺失仍保持unknown，避免把“链路闭合”误写成“体验完整”。普通`validate()`不受影响，
服务默认也不自动调用闭合门。

`trace_context`可选复用W3C `traceparent`的canonical字段：
`trace_id`为32位小写十六进制、`span_id`为16位小写十六进制、
`trace_flags`为两位十六进制解析值。全零ID、非`00`版本、大写或错误长度拒绝。
该字段只用于跨服务关联，不得放入主体、候选明文、凭据或其他个人信息。
它不能替代业务`request_id`、播放能力签名或消费网关授权。
若请求带`trace_context`，其`trace_id`必须等于顶层联合包`trace_id`；
无上下文的请求可保留，但不计入已传播trace覆盖。

运行时当前只在服务收到单个合法`traceparent`时，将其透传到受控的内部画像投影或事件请求。
可解析的`tracestate`按原顺序合并多值头，并在512字节、32个成员和单成员长度预算内转发；
超预算时只移除完整成员，非法键值、重复键或超大输入则丢弃整个`tracestate`，保留合法
`traceparent`。非法或多值`traceparent`仍按无传播上下文处理；不因这些头改变Bearer、
分片、共识水位、播放能力或消费授权。当前适配不创建服务端子span、不采样、不持久化链路，
因此只能证明一跳请求头传播，不能证明完整分布式trace。

媒体交付观测会在已有交付日志中记录请求的`trace_id`（若存在），用于和推荐、画像及播放
能力收据做关联；不记录`tracestate`，不把`trace_id`加入播放令牌、缓存键或授权判断。
没有Bearer或播放能力的请求仍按原规则拒绝，即使携带合法trace头也不能获得媒体访问权。

推荐和Feed响应在收到合法上下文时可返回`x-vs-trace-id`。Web、Android和iOS客户端可以
将它原样带到后续媒体请求；它是观测关联字段，不是W3C`traceparent`，不要求客户端伪造span。
媒体入口接受它只用于观测关联，非法或缺失时保持未知，不影响媒体授权。
当前Web已完成真实请求桥接，Android已完成Media3消费者源码、宿主和APK结构验证，iOS仅有
`URLRequest`请求辅助，尚未接入AVPlayer/AVURLAsset；三端网络传播和真机状态不能互相外推。

播放实例和交互实例只保存SHA256，不保存明文播放ID或用户主体。

## 防泄漏规则

1. 同一`request_id`不能重复。
2. 请求时间不能倒序，且不能早于轨迹起点。
3. 生产观察必须使用`observed`数据；合成数据不能伪装成生产观察。
4. 推荐、播放和消费实例若交叉填写，必须指向同一候选和同一播放实例摘要。
5. 指标超过预算或输入摘要重复时拒绝整包，不发布部分结果。
6. 联合包不能替代原始证据的权限、授权、删除和保留策略。

## 评价边界

通过校验只说明“这份输入可被同一请求级关联器读取”。
它不说明推荐质量、首帧、卡顿、带宽、CPU、RSS、功耗、物理多机、真实用户观看
或任何组件的全局最优。缺少指标必须在后续报告中保持缺失，并按平台和数据类型分开汇总。
