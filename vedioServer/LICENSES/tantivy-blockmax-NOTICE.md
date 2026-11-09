# 块上界机制来源

参考项目：`quickwit-oss/tantivy`。

固定版本：`0.25.0`，提交`b4139bc3536ac7217995633cbd469a4bf2a23fc3`。

参考文件：`src/query/boolean_query/block_wand.rs`。

参考机制：利用局部块分数上界与竞争门槛，跳过不可能改善结果的评分。
原始MIT许可证保存在同目录`tantivy-MIT.txt`，原文件与指纹另存本轮参考档案。

本项目没有复制词项倒排、WAND枢轴选择或Tantivy运行时。
本地实现继续使用现有Qdrant派生Top-K选择器和分组索引，
块端点上界、负系数处理、零值处理、权限过滤及完整排序语义为六维线性模型适配。
只在块上界严格低于门槛时跳过，等分块仍评分。

这属于机制迁移，不代表完整Tantivy Block-WAND算法或其性能保证。
