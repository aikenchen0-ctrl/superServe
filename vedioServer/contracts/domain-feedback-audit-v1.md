# 跨领域显式反馈审计

## 启用

仅在冻结模型证据回放配置中增加`domain_audit`；省略时既有回放报告、模型权重、
在线排序和策略不变。审计不产生或写入消费、画像或训练事件。

```json
{
  "schema": "model-evidence-replay-config-v1",
  "decisions_from": 1794080000,
  "model": {"path": "ranker.json", "sha256": "<固定模型指纹>"},
  "samples_per_query": 24,
  "warmup_per_query": 6,
  "domain_audit": {
    "required_domains": ["video", "article", "service"],
    "minimum_positive_labels": 30,
    "maximum_positive_coverage_drop_basis_points": 200
  }
}
```

领域必须存在于已固定发布目录，最多64个且不能重复；
明确正反馈最少样本1至100000；允许的相对覆盖下降为0至10000个基点。
未知字段和非法预算均失败关闭。一个必需领域未达到正反馈样本数时门槛不通过，
不能把“未观察”当作通过。

## 指标语义

冻结窗口内每个决策和返回项按其发布目录`domain`累加：

- `requests_in_scope`与`multi_domain_requests`保留全部匹配请求；未反馈不会被过滤。
- `requests_with_explicit_feedback`只表示该领域至少有一条明确反馈的请求。
- 明确Like/Dislike分别计数；返回项在明确反馈集中属于正、负或未判定之一。
- `observed_positive_coverage`按`被返回的明确正反馈候选数 / 该领域明确正反馈候选总数`计算。
  这是观察到的正反馈覆盖，不是precision、用户满意率、校准CTR或因果收益。
- 微平均以全部领域明确正反馈数加权；宏平均仅平均具有正反馈分母的领域，
  同时列出无分母领域，不能把没有评估的领域记成1分。
- 明确返回负反馈只作诊断，不与未返回或未知候选混为负标签。
- 显式启用时，每个冻结请求额外按一遍目录候选数计入既有逻辑遍历预算；
  不把可选诊断成本隐藏在原三路径回放预算中。

可配置门槛只检查必需领域的正反馈覆盖相对基线退化不超过指定比例，
且达到最小样本数。基线与模型都未覆盖某个正标签时，二者同为0也会按规则通过；
因此此项只作严重退化哨兵，不意味着目标质量已达成。
门槛失败时模型回放CLI退出码2；诊断JSON仍保留，供检查原因。
失败不会删除或改变已发布模型，也不会回滚在线推荐。

## 适用边界

本指标仅使用可信冻结证据中“候选已显示且反馈明确”的标签。
不同领域曝光量、候选池、位置、选择偏差和反馈延迟可能完全不同；
分组本身不能修正这些偏差。未知保持未知，回放报告持续声明
`unbiased_policy_evaluation=false`及`production_gate_passed=false`。

模型仍由原固定FTRL及学习特征训练；审计不训练模型、不调整Top-K、
召回配额、权重、阈值或线上领域流量。不新增依赖、画像读取、网络RPC或长期指标存储。
持久输出仍使用已有不可覆盖的回放报告路径。

## 复用来源

命中计数和分组汇总参考固定
`recommenders-team/recommenders@cc47866b0599721f8544d1cc850a5a1db091acb3`
的`recommenders/evaluation/python_evaluation.py`：
`merge_ranking_true_pred`及`recall_at_k`。
本项目适配为有界领域计数，保留零命中与无标签组，并使用曝光档案原始返回结果；
不复制Python模块、pandas依赖或其仅取共同用户的回放筛选逻辑。
原MIT许可见`LICENSES/recommenders-MIT.txt`，固定源码及反例见
[领域审计评估](../../vedioServerRefer/problem-space/domain-feedback-audit-evaluation.json)。
