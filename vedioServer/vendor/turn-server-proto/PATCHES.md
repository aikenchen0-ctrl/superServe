# 本地补丁

固定发布：`turn-server-proto 0.7.3`，发布包VCS：
`52209bfadde1bf7be7423cdf53654c5d68e59102`。

唯一源码改动位于`src/server.rs::handle_stun_binding`：
`self.stun.send(response, transmit.to, now)`改为`transmit.from`。
回复必须发给请求者，不应发回本地监听地址。上游测试核对了内容但未核对目的端点，
本项目独立UDP测试发现此问题。回归位于`crates/vs-turn/tests/contract.rs`。

其他源码、规范化清单和VCS元数据按发布包复制，未改动D盘缓存。
Cargo根级patch仅覆盖该精确版本，目录从本工作区成员中排除，避免引入上游开发基准依赖。
实际升级时必须重新验证该补丁、真实中继和目的地限制，不能静默丢弃。
