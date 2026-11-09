# RustFS 获取锁取消实验

固定上游：`rustfs/rustfs@46337942d55f3a8e6a97b147ca98d9ea8115555d`。
本工程直接依赖完整 `rustfs-lock` 包；独立工作区与 Rust 1.99 工具链不改变业务工作区的 Rust 1.96 基线。

## 问题与补丁

调用方取消仲裁 Future 时，原版会丢弃已收集的锁记录并中止 JoinSet 中的本地等待者。远端已发生或即将发生的授权不会因此自动回滚。

`acquisition-cancel.patch` 给一次获取尝试增加资源保护对象。正常成功、失败、超时路径显式转移已有资源；仅未完成的尝试被丢弃时，复用上游释放及迟到结果清理逻辑。保存原运行时 Handle，以支持 Future 在运行时上下文外被丢弃。

补丁不修改仲裁数量、请求分发、TTL 或重试策略。新增正常路径开销包括 Handle/Arc/锁号持有和析构检查；取消路径继续等待已发出的请求并释放成功授权，代价不为零，尚未做性能测试。

## 复跑

工作区根目录应已有 `.artifacts/upstream/rustfs`，且 HEAD 为上述提交。若尚未准备，可从官方仓库克隆到该参考路径并检出固定提交。`run.ps1` 只克隆到 `.artifacts/labs/rustfs-lock-cancel` 并修改实验副本；未知修改或校验值不符会停止。

```powershell
rustup toolchain install 1.99.0 --profile minimal
pwsh -File vedioServer/labs/rustfs-lock/run.ps1 -Variant Baseline
pwsh -File vedioServer/labs/rustfs-lock/run.ps1 -Variant Patched
pwsh -File vedioServer/labs/rustfs-lock/run.ps1 -Variant Patched -UpstreamTests
```

可传 `-RegistryIndex 'sparse+https://rsproxy.cn/index/'` 使用本轮镜像；依赖缓存完整后可加 `-Offline`。不修改全局 Cargo 源。清单和锁文件固定依赖版本；首次解析本实验锁文件沿用上游 Cargo.lock，不升级业务依赖。

每次运行输出带时间戳的日志及 JSON 收据，包含提交、源码与补丁 SHA-256、编译器、命令参数和实际退出码。原版失败保留退出码 101；最终源码处于最后指定的变体。

## 断言与已知结果

| 测试对象 | 原版 | 补丁版 |
| --- | --- | --- |
| 读锁/写锁取消，已收集及迟到授权 | 失败 | 通过 |
| 尚未授予、已授予未应答、已应答未消费 | 失败 | 通过 |
| 取消清理的瞬时释放故障重试 | 失败 | 通过 |
| 在运行时上下文外取消，原运行时仍存活 | 失败 | 通过 |
| 真实 LocalClient 租约取消 | 失败 | 通过 |
| 正常交付、冗余请求清理、仲裁失败、超时 | 通过 | 通过 |
| 合计 | 4 通过 / 8 失败 | 12 通过 / 0 失败 |

远端替身使用独立任务模拟服务器，因此调用方取消不会阻止服务器继续授权；屏障控制授权与应答阶段，返回的锁号不同于请求锁号。持续放行门闩支持重试。多数测试使用虚拟时间，显式超时对照因上游同时使用 std 与 Tokio 时钟而使用真实时间。

上游整个锁模块：原版与补丁版均为 134 通过 / 1 失败。失败项是 `client::local::tests::acquire_retry_preserves_total_deadline`，在当前 Windows 环境断言第一次请求应耗尽预算，但实际返回成功。保留为上游/环境待查问题，不跳过、不改断言、不宣称上游回归全绿。

Linux 补充验证：原版 135 通过；补丁版 134 通过 / 1 失败，失败为未修改通知模块的 `test_writer_notification`。两轮使用相同工具链与独立测试目标目录，测试时同机存在完整服务端编译，不能据此比较延迟。原始日志与收据分别见 `storage-linux-lock-baseline.json` 和 `storage-linux-lock-patched.json`，不以重复运行覆盖失败。

`tests/notify_pool_collision.rs` 另外固定两个通知对象的合法池索引，并显式轮询注册等待者。不同索引的对照通过，相同索引时本对象的通知唤醒了另一对象，自身仍在等待。该测试不依赖睡眠或随机调度，也不禁止额外唤醒。运行 `cargo test --manifest-path vedioServer/labs/rustfs-lock/Cargo.toml --locked --test notify_pool_collision` 当前会保留一个失败，不能把它改成忽略或预期崩溃来取得绿色。

上游 `fast_lock/shard.rs` 已用有上限的等待和重试补偿丢失或被其他对象消费的通知，因此此反例只证明通知隔离不足，不能证明永久死锁，也未证明本次 Linux 单测失败或此前 S3 DELETE 503 的实际根因。内存节省、无关唤醒、重试开销和尾延迟需要单独评估；不混入当前获取锁取消补丁。

该文件第 978 行附近的测试说明也明确承认池碰撞，后续等待上限 `NOTIFY_WAIT_CAP` 为 50 毫秒。因此新增反例检验的是更强的通知隔离要求，不把上游已知并补偿的取舍重新定性为未处理的死锁。

## 结论边界

已证明并修补获取锁算法中的取消所有权缺口。完整 Linux 原版与补丁版均已构建，并完成预先固定的三组 S3 配对实验：原版 56 通过 / 4 失败，补丁版 60 通过 / 0 失败。原版三轮都需要重启实验集群才能完成对象清理。尚未证明该缺口是所有历史 DELETE 超时的唯一原因；没有部署生产服务。

真实 RemoteClient 有额外的 RPC 超时和迟到清理逻辑；本实验不能替代该协议栈的整体验证。复用的 pending 清理器没有新增全局截止时间或并发总预算，任意不返回的 LockClient、运行时关闭、进程崩溃及永久释放失败仍需租约和上层恢复兜底。RustFS 生产准入保持阻断。

下一步检查长期取消压力下的任务、租约和内存是否收敛；有限样本的 S3 通过不等于后台清理资源有界。整机证据见 `../../../vedioServerRefer/RustFS完整服务端回归.md`。

## 完整 Linux 服务端构建

`bootstrap-linux.sh` 将 Rust 1.99.0 放进用户缓存下的独立实验目录，校验官方安装器，不修改默认工具链或终端启动配置。

```bash
bash vedioServer/labs/rustfs-lock/bootstrap-linux.sh
# Ubuntu 24.04 缺少 protoc 时，解包固定工具版本到实验前缀。
bash vedioServer/labs/rustfs-lock/bootstrap-protoc-linux.sh
bash vedioServer/labs/rustfs-lock/build-linux.sh baseline
bash vedioServer/labs/rustfs-lock/build-linux.sh patched
```

WSL 下可通过 `/mnt/c/Users/Paifa/.codex/worktrees/b4be/superServe/` 定位这些脚本。构建前缀为 `$HOME/.cache/superServe/rustfs-build/<固定提交>`；源码和编译缓存在 Linux 文件系统，日志和收据写入仓库 `.artifacts/storage-builds/`。未知源码改动会中止切换；文件锁防止两个变体同时修改构建目录。

可用 `VS_LAB_REGISTRY_INDEX=sparse+https://rsproxy.cn/index/` 显式选择依赖镜像，`VS_LAB_BUILD_JOBS` 控制编译并发，默认 6。保持上游 Cargo.lock，构建使用 `--locked`。没有依赖更新或全局源配置修改。

两种变体均采用 `dev` 构建、关闭调试信息和增量编译，并使用 `--no-default-features` 关闭 FTPS/WebDAV/GCS。它们用于 S3 正确性对照，不能与官方发布构建混比性能。每轮构建保存实际退出码、源码和锁文件指纹、编译命令、编译器版本，以及成功产物的 SHA-256。清单分别固定 Windows CRLF 与 Linux LF 的源码指纹，不通过忽略内容差异放宽校验。

将成功收据中的二进制路径传给已有 `../rustfs/run-contract.sh`，其 `inputs.json` 会再次记录实际服务端、探针、运行脚本的指纹。构建成功不代表 S3 回归成功；锁模块绿色也不能代替真实取消、断连及持续压力验证。

直接 S3 探针可通过 `VS_LAB_SEED` 指定 48 位小写十六进制合成数据种子；不指定时继续生成独立输入。相同种子、相同探针产生相同测试对象，两个变体仍使用各自新建的临时桶。种子只能重放数据，不能重放线程调度或证明远端已收到被取消的请求。

来源和许可见 `NOTICE` 与 `LICENSE`。完整证据及 HMM 回流见 `../../../vedioServerRefer/RustFS锁取消修复实验.md`。
