# Apache Iggy隔离实验

## 2026-11-09运行准入修订

当前真实服务复跑仍未获准入：只读核查发现Ubuntu和Docker Desktop的WSL根路径均在C盘，
Docker引擎未运行；本轮没有启动、关闭或迁移任何WSL发行版，也未启动Docker或远程连接。
历史D盘服务二进制仍存在且SHA256与既有记录相同，但制品存在不等于运行环境符合约束。

单节点和三节点入口现在共用`lifecycle.sh`：
仅登记并操作本Shell创建的直接子进程，
使用Bash 5.1以上的`wait -n -f -p`与计时子进程竞争，有界等待真实退出，
子进程退出码与监督器超时状态分开保存，真实124/127不会误当等待器错误。
停止态或超时未回收时明确失败，不无限wait、不按名称杀进程、不以强杀替代优雅退出。
强杀超时仍不能回收操作系统不可中断任务，本修订没有修复WSL内核。

两入口均要求显式`VS_IGGY_STORAGE_ROOT`，在创建实验目录和启动broker前核对
最近存在祖先的文件系统类型，只允许本轮验证目标中的`ext2/ext3`、`xfs`或`btrfs`，
拒绝9p/DrvFS/共享挂载和未知类型；不提供绕过开关。
这不是认定其他文件系统普遍不可靠，而是避免在已有失败环境重复生产候选实验。
服务副本、活跃数据和服务日志在该节点目录，证据继续位于O/D盘；
节点目录位置另写`node-root.txt`，单节点日志不再位于收据根。

路径仍须在`/mnt/o/`或`/mnt/d/`之下，但该前缀不意味着必须使用DrvFS：
只有经用户另行准备、且实际后端位于非C盘的Linux原生文件系统挂载才可通过。
脚本只检查Linux可见类型，不能证明WSL根VHD实际存放位置或物理磁盘独立性，
启动前仍须像本轮一样核实宿主资源。不要自动重挂载O/D盘、修改全局WSL或安装系统服务。
在新环境可用前，不运行这两个真实broker入口。

有界生命周期检查可以在已安装的Git Bash执行：

```powershell
. 'D:\CodexVideoTools\enter.ps1'
& 'C:\Program Files\Git\bin\bash.exe' --noprofile --norc vedioServer/labs/iggy/test-lifecycle.sh
```

当前8项通过，包含实际子进程退出/停止/超时/强杀与退出码、
无效身份拒绝、C盘拒绝，以及显式声明的文件系统分类替身。
这不是Linux、Iggy真实服务、io_uring不可中断线程、物理集群或三低验收。
历史实验事实仍保留，最新范围见`problem-space/iggy-lifecycle-evaluation.json`。

## 历史实验与后续入口

本目录保留Iggy 0.9系真实反馈实验的历史收据；该收据不证明0.10行为。
画像分区候选固定为server-0.10.0提交`91e0206367aad2d30259f7d45203832b08ae84e7`，
不修改其服务端内核，也不接入当前画像生产路径。

本机的Iggy 0.10构建尚未启动：现有WSL工具链和旧构建缓存位于C盘，不能复用；
D盘无空间，O盘目前也不足以安全容纳独立Linux工具链、依赖、构建产物和集群数据。
脚本已改为只接受O盘或D盘路径并固定0.10提交，避免静默写回WSL `$HOME`。
不要为启动实验而搬动或删除已有WSL缓存。

## 本轮问题

<重表述提示词为问题>如何把已有反馈协议夹具推进到可重跑的真实日志合约，同时避免增加业务依赖、重复日志实现和无边界构建成本？</重表述提示词为问题>

S0：0.9历史实验已有收据，0.10消息键探针只有客户端协议证据，缺少真实服务运行。
IFR：复用现成日志，让同主体事件按分区处理并在重放、迁移时保留正确结果。
Sg：先验证客户端只写一次、确认后定向只读核对正文，再取得0.10服务端与分区恢复收据。

约束：只接回环HTTP实例，不连接生产服务，不修改业务Cargo锁文件；
只在隔离前缀解包原生依赖，不安装系统服务。
代偿：增加一套实验工具链、原生库和构建缓存；正常进程重启不能证明断电持久性。
构建和运行不改变系统分页、WSL配置或全局Docker状态。

## 构建边界

默认构建0.10固定提交，使用Rust 1.99.1。需要先在O盘或D盘准备独立工具链前缀；脚本不会回退到C盘。
仅当所选目标盘有足够空间容纳源码、工具链、Cargo依赖、目标产物和运行数据后再运行。
原生包通过Ubuntu现有包索引下载并解包到隔离目录，不调用系统安装。

```bash
export VS_IGGY_TOOLCHAIN_PREFIX=/mnt/o/CodexVideoBuild/iggy-0.10.0/toolchain
export VS_IGGY_BUILD_ROOT=/mnt/o/CodexVideoBuild/iggy-0.10.0/build
export VS_IGGY_TARGET_DIR="$VS_IGGY_BUILD_ROOT/target"
export VS_IGGY_NATIVE_PREFIX=/mnt/o/CodexVideoBuild/iggy-0.10.0/native
export VS_IGGY_RECEIPT_ROOT=/mnt/o/CodexWorkspaces/superServe-video-b4be/.artifacts/iggy-profile-sharding
export VS_IGGY_BUILD_JOBS=1
bash vedioServer/labs/iggy/bootstrap-native-linux.sh
bash vedioServer/labs/iggy/build-linux.sh
```

Windows消息键探针构建到O盘业务目标目录：

```powershell
. 'D:\CodexVideoTools\enter.ps1'
cargo build --manifest-path vedioServer/Cargo.toml --locked --offline --jobs 1 `
  --config 'source.crates-io.replace-with="video-rsproxy"' `
  --config 'source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"' `
  -p vs-service --example iggy_profile_shard_probe
```

以下重启与三节点反馈脚本仍只用于旧固定提交`71f29618ba04917fded0ef5cd085c206fef0ee49`，
不是0.10画像集群入口。复跑前需要单独设置历史版本并构建，不复用0.10默认目录：

```bash
export VS_IGGY_VERSION=server-0.9.0-rc.1
export VS_IGGY_TOOLCHAIN_PREFIX=/mnt/o/CodexVideoBuild/iggy-0.9.0-rc.1/toolchain
export VS_IGGY_BUILD_ROOT=/mnt/o/CodexVideoBuild/iggy-0.9.0-rc.1/build
export VS_IGGY_TARGET_DIR="$VS_IGGY_BUILD_ROOT/target"
export VS_IGGY_NATIVE_PREFIX=/mnt/o/CodexVideoBuild/iggy-0.9.0-rc.1/native
# 前缀中需预装Linux Rust 1.98.0，且必须位于O盘或D盘。
bash vedioServer/labs/iggy/build-linux.sh
export VS_IGGY_SOURCE_ROOT="$VS_IGGY_BUILD_ROOT/source"
export VS_IGGY_RUN_ROOT=/mnt/o/CodexVideoBuild/iggy-0.9.0-rc.1/runs
export VS_IGGY_STORAGE_ROOT=/mnt/o/iggy-native-mount/restart-data
# 此入口还需预先用同一业务工作区构建iggy_feedback_contract.exe。
# iggy-native-mount须事先由用户准备在非C盘原生Linux文件系统上，不是普通DrvFS目录。
bash vedioServer/labs/iggy/run-linux.sh \
  "$VS_IGGY_TARGET_DIR/debug/iggy-server" \
  /mnt/o/CodexVideoBuild/target/debug/examples/iggy_feedback_contract.exe
```

脚本只启动一分片的临时独立实例，不启动全局服务。
正常停止使用SIGINT并检查退出状态；退出陷阱清理本轮进程。
设置`VS_IGGY_RESTART_MODE=sigkill`可在确认及首次快照之后强杀进程，
校验137退出状态，再重启读回；它不是确认瞬间或物理断电测试。
旧实验目录和失败日志保留，不自动重发未知消息，不复用旧资源名。
二进制、默认配置指纹与前后服务日志写入输出目录。

## 证据边界

`seed`创建消息持久化为`persisted`的主题和一个仅消费位点为`persisted`的反例主题。
还创建主题范围写者、读者和无权限用户；写者需要主题读取和追加权限，
上游`read_topic`包含消息读取能力，因此不能宣称收集者只有写权限。
读者不能追加，无权限用户不能通过主题预检。

两条事件通过既有反馈路由写入，校验`201 + persisted + 分区偏移`后，
读取`[0,2)`为不可覆盖归档。重启后重新登录，再比较创建时间、偏移区间、
归档SHA256和完整字节；快照始终`auto_commit=false`。
测试不证明消息主题保留策略、跨机器仲裁、分区迁移、断电或真实终端显示。

## 三节点故障实验

复用固定版本上游的集群名册和受限HTTP转发，不复制或修改共识内核：

```bash
export VS_IGGY_SURVIVOR_ID=2
export VS_IGGY_STORAGE_ROOT=/mnt/o/iggy-native-mount/cluster-data
bash vedioServer/labs/iggy/run-cluster-linux.sh \
  "$VS_IGGY_TARGET_DIR/debug/iggy-server" \
  /mnt/o/CodexVideoBuild/target/debug/examples/iggy_feedback_contract.exe
```

实验步骤为：初始节点0确认两条消息；强杀节点0；从节点1或2验证已确认前缀，
追加一条并验证偏移2；再强杀另一个节点，单次写请求必须得到503及unknown；
恢复多数派及旧节点后，从三个节点分别核对三条已确认消息。
未知写入可能随后提交，实验只验证已确认前缀，不声称未知事件不存在。
入口由实验显式选择，尚未实现收集服务的自动地址切换。

同机挂载盘上两轮完成上述步骤：节点1直达、节点2转发路径均有收据。
第三轮在强杀节点0时出现WSL内核等待：`io_wq_put_and_exit`及`p9_client_rpc`，
脚本原有无限wait也因此暴露。记录保留，不能只引用前两轮成功。
修订脚本对强杀和清理分别设10秒期限，超时失败并输出等待点；
准备目录和复制制品也受期限约束，操作系统不可中断线程不保证能被信号回收。

当前脚本不再使用WSL `$HOME` 默认目录；`VS_IGGY_STORAGE_ROOT`必须显式指定O盘或D盘，
临时目录也跟随隔离根。WSL本地文件系统在C盘，而O盘/WSL挂载的`df`、目录读取曾出现等待，
所以不能同时声称已满足“不写C盘”与“Linux本地磁盘io_uring可靠退出”。
本轮仅校验脚本，不启动服务或宣称已解决内核等待；每轮旧数据保留，不自动删除。

结果、等待线程、来源指纹和当前未验证项见
`vedioServerRefer/problem-space/iggy-cluster-evaluation.json`。
官方元数据中的`healthy`不是本实验的存活证据：已强杀的节点仍可能带该标签。
实际证据来自信号与退出状态、受保护读回、确认偏移和前缀字节。

三个后续问题：日志保留、路由及物理故障域；终端身份与授权撤回；真实播放与推荐联合三低。
本轮完成跨进程副本的局部契约，并保留环境反例，不能据此宣布生产准入。

## Iggy 0.10 主体键分区探针

`crates/vs-service/examples/iggy_profile_shard_probe.rs`是独立实验入口，不替换现有0.9反馈适配。
复用官方消息JSON结构及已有固定offset快照机制，使用`messages_key`写入专用合成主体，
检查`201 + iggy-durability: persisted + partition_id + base_offset`、同一subject分区稳定、
不同subject至少命中两个分区；专用分区内offset不连续则失败，不兼容其他写者并发混入。
随后每页最多8条，`kind=offset&auto_commit=false`读回全部已确认消息，核对消息ID、正文长度、
SHA256、分区offset及读回分页之间的incarnation。单响应16KiB上限，总轮次300秒期限。

先用固定Iggy `server-0.10.0`创建隔离集群、stream和至少两个partition的专用topic，
为探针创建仅能在该topic追加和读取的实验用户；不创建资源、不加入consumer group、不提交消费位点。
每次使用全新、最长24字节的`VS_IGGY_PROFILE_RUN_ID`，避免把旧实验消息混入统计。
只允许字面HTTP回环地址，不使用代理、重定向或reqwest自动重试。写结果未知时停止，不能视为未提交。

```powershell
$env:VS_IGGY_PROFILE_HTTP = 'http://127.0.0.1:8080'
$env:VS_IGGY_PROFILE_TOKEN = $env:VS_IGGY_TEST_TOKEN
$env:VS_IGGY_PROFILE_STREAM = 'profile-probe'
$env:VS_IGGY_PROFILE_TOPIC = 'synthetic-events'
$env:VS_IGGY_PROFILE_RUN_ID = 'run-20261108-01'
. 'D:\CodexVideoTools\enter.ps1'
cargo run --manifest-path vedioServer/Cargo.toml --offline --locked `
  --config 'source.crates-io.replace-with="video-rsproxy"' `
  --config 'source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"' `
  -p vs-service --example iggy_profile_shard_probe
```

可选限制：`VS_IGGY_PROFILE_SUBJECTS`默认256、上限4096；
`VS_IGGY_PROFILE_EVENTS_PER_SUBJECT`默认4、上限32；全轮总数最多50,000条。
输出v2收据只包含合成运行标识、partition计数、写请求/响应应用层字节、读回响应字节和请求次数，
不包含Bearer token。不计HTTP/TCP/TLS或复制流量，不能直接当线路带宽指标。
探针仅内存保存期望摘要；进程退出不保存重放清单，不得复用同一run_id盲目重发。

本轮11项单元及回环HTTP夹具测试通过，但尚未连接Iggy 0.10，不能作为服务端持久性或集群收据。
读回之间的incarnation校验不证明从最初写入到第一次读回之间没有重建。
三节点分区主节点、TCP consumer group重平衡、投影事务、HTTP owner路由、物理多机与三低仍未验证。

## TCP消费者的复用边界

固定0.10源码中应直接复用`ConsumerGroupClient::sync_consumer_group`、
`CommitPolicy::Manual`和`ReceivedMessage::checkpoint()`，不用HTTP假装consumer group。
checkpoint绑定分区incarnation/owner上下文；SDK的`Progress::commit`对过期本地generation会
直接`Ok(())`且不发送写入，所以“commit返回成功”不能单独证明位点推进或仍持有分区。
分区级`owner_generation`也不是全组assignment generation，两者不能直接互换。
更不能把日志位点fencing扩张为外部画像数据库已隔离旧写者；画像投影和消费位点仍需独立闭环。
