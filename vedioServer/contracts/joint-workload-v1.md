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
| `trace_id`、`source_id` | 有界稳定标识 |
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
