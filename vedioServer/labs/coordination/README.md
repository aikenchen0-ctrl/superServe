# 房间分配集群实验

新增Rust部署运维客户端`media-admin.exe`：`preview`显示同一线性一致节点/房间状态，
`apply`单次写入排空/恢复/移除，`confirm`只读回完整命令。
它不会盲重试已发写入，结果不能确认时明确返回unknown。
配置、响应和退出边界见[Rust媒体维护客户端](../../contracts/media-admin-client-v1.md)。

节点停止新房间分配可通过`verify-multiroom.mjs --registry --draining`验证：
真实音视频保持、显式恢复、全协调重启、逐房排空后删除与另一节点重新协商。
`--registry`不带新选项继续验证原路径及排空命令404。
这两个模式应顺序执行，Windows运行中的EXE不能同时被工作区构建替换。
配置指纹、数据迁移边界和证据见
[节点维护契约](../../contracts/media-node-draining-v1.md)。

先加载D盘工具环境，在vedioServer目录构建：

```powershell
. 'D:\CodexVideoTools\enter.ps1' -KeepLocation
cargo +stable build --locked -j 1 -p vs-coordination
```

在项目根目录运行，输出目录必须尚不存在：

```powershell
. 'D:\CodexVideoTools\enter.ps1' -KeepLocation
node vedioServer/labs/coordination/verify-cluster.mjs `
  O:/CodexVideoBuild/target/debug/vs-coordination.exe `
  O:/CodexWorkspaces/superServe-video-b4be/.artifacts/room-authority/run-new
```

工具使用Node内置库，不新增npm依赖。
自行创建3个协调进程及第4个学习节点，使用独立redb目录，
校验并发唯一分配、幂等/ABA、快照压缩、领导者故障、少数派拒绝、
未知写入、全体重启和成员迁移，最后只清理自己的子进程。
输出receipt.json、每代进程日志和独立数据文件，失败不抹除日志。
配置文件含内部服务凭据，留在忽略目录，不作为产品源码或公开证据内容。

实验中的全部节点在同一Windows主机，不等于物理多机验收。
恢复多数派后，超时操作可能提交；工具记录实际结局，不断言其未执行。
成员变更从1/2/3，经1/2/3/4，再移出一个非领导旧成员维持3个投票者，
不把临时4投票者解释成最佳拓扑；本实验不覆盖主动移除当前领导者。
每次运行使用新目录；不要删除或覆盖其他实验正在使用的数据库。

接口及限制见../../contracts/room-authority-v1.md。

真实媒体的分配接受、排空与交接另见HANDOFF.md。
协调数据库现在固定排空策略身份；旧实验数据库缺少该身份时会拒绝静默打开，
应保留原证据并用新实验目录验证，不能直接删除历史文件绕过迁移。
