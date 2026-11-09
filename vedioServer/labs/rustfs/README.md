# RustFS 四节点协议实验

这是媒体对象存储的实验入口，未通过生产准入。它复用 RustFS 1.0.4 的四节点配置，改为四节点各一盘、STANDARD `EC:2`。固定源码为 `46337942d55f3a8e6a97b147ca98d9ea8115555d`，来源和改动见 `../../THIRD_PARTY.md`。

## 实验边界

- 同一机器上的四个容器共享宿主故障域和可能相同的物理盘，不能证明多机容灾、可用容量或再平衡吞吐。
- 以 S3 连接现有 OpenDAL 适配；不把 RustFS workspace 并入本项目。该参考版本要求 Rust 1.99.0，本服务继续使用已固定的 1.96.0。
- 仅映射回环地址 `19300–19303`。没有负载均衡、自动扩缩、TLS 或公开访问入口。
- 数据卷按 Compose 项目名隔离，默认停止保留数据；没有清空目录或自动删除卷的脚本。
- `VS_LAB_ALLOW_SHARED_DISKS=true` 仅绕过本机协议实验的物理盘检查。真实多机验收必须关闭绕过，记录主机、磁盘和故障域。
- 镜像当前固定版本标签 `rustfs/rustfs:1.0.4`，尚未核验镜像摘要和其源码构建关联。正式计量前需记录镜像摘要、二进制版本和平台，不能把标签当不可变制品。

## 本地运行

在此目录的 PowerShell 执行。需要可用的 Linux Docker 引擎。首次启动使用独立临时凭证；保留卷重启时继续使用同一组实验凭证。

```powershell
$env:VS_LAB_ACCESS_KEY = 'lab' + [Guid]::NewGuid().ToString('N')
$env:VS_LAB_SECRET_KEY = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$env:VS_LAB_ALLOW_SHARED_DISKS = 'true'
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180
docker compose ps
```

不要将 `docker compose config` 的完整展开输出写入共享日志，它含插值后的实验凭证。状态及日志检查不应输出凭证。
镜像使用 UID/GID `10001:10001`；初次创建命名卷时从镜像 `/data` 初始化。若已有卷属主不同，应单独核查该实验卷，不递归修改宿主目录。

就绪探针只作启动检查。`/health/ready` 成功不能代替实际 PUT/GET 或写入法定人数测试。控制台、FTPS、WebDAV 均关闭。

停止和保留数据：

```powershell
docker compose stop
```

重启使用 `docker compose start`，随后用 `docker compose ps` 检查健康状态；只有使用相同实验凭证时才重新执行 `up`。本文件不提供删卷快捷命令。

## 接入媒体服务

先用 S3 客户端创建仅用于该实验的桶和合成对象，再创建该桶的只读凭证。当前服务没有桶创建和上传 API，不能凭空运行媒体样例。

在 `vedioServer` 目录启动服务时使用：

```powershell
$env:VS_STORAGE = 's3'
$env:VS_S3_ENDPOINT = 'http://127.0.0.1:19300'
$env:VS_S3_REGION = 'us-east-1'
$env:VS_S3_BUCKET = 'video-lab'
```

其余配置沿用 `../../README.md`：`VS_ROLE=media`、`VS_BIND`、`VS_SERVICE_TOKEN`、包含真实资产元数据的 `VS_CATALOG`，以及对应的 `VS_S3_ACCESS_KEY_ID`、`VS_S3_SECRET_ACCESS_KEY`。不要将存储管理员凭证赋给常规媒体进程。

写入方先计算合成对象的 SHA256 和字节数，用 `media/<sha256>` 存储，逐端点 GET 校验后才把资产放入测试目录。散列命名本身不阻止覆写；生产发布锁、条件写与清单原子性另行验收。

## 验证顺序

1. 先做全对象、HEAD、首部/中部/尾部 Range 校验，逐一切换四个端点，比较原始字节，记录实际请求次数和错误。
2. 再测 64 KiB、256 KiB、1 MiB 的对齐、非对齐和跨块区间，区分交付字节、S3 出口字节与节点间字节。现有 OpenDAL 分块大小不是物理存储读放大的上限。
3. 上述完整性通过后才停止 `node4`，对存活端点分别执行读和写，恢复 `node4` 后再核对新旧对象。单一端点配置本身不会自动切换到另一个端点。
4. 再平衡实验另建具备独立文件系统的多池拓扑；保持原池端点和四盘宽度不变，追加新池。禁止把 `node{1...4}` 原地改成 `node{1...8}`。
5. 再平衡只有实际移动字节非零、期间持续读取正确、结束状态明确、完成后全量校验一致才算通过。空桶或共享文件系统导致的零移动不算有效验证。

完整实验矩阵、代价和回退条件见 `../../../vedioServerRefer/存储根项目评估.md`。

## 无 Docker 的 WSL 合约实验

`run-contract.sh` 可以用 Ubuntu WSL 和官方 Linux 发布二进制运行同机四进程。它创建独立目录、凭证和临时桶，调用 Rust 探针；正常或失败退出都尝试清理该桶并回收本轮进程。不会清空非空桶，也不会删除其他实验目录。日志和磁盘目录保留在 `.artifacts/storage-runs/`。

实验依赖 Bash、curl（支持 `--aws-sigv4`）、ss、od 和 coreutils；这些只用于实验编排，不进入生产 Rust 服务依赖。Windows 探针通过 WSL 环境桥接取得本次临时凭证。探针只接受回环端点、不同端口及 `video-lab-` 开头的桶，禁止静默回退到系统云凭证。

先取得官方发布包，校验同一发布的 `SHA256SUMS`，再解压到仓库的 `.artifacts/downloads/rustfs-1.0.4/extracted/`。本轮实际核验的发布包：

```text
rustfs-linux-x86_64-musl-v1.0.4.zip
SHA256: 4924ad4b699b9f59943051efedae2d1eb6d4cac503a1b0384c4b25f7c2c31b5c
运行时报告版本: 1.0.4
运行时报告提交: 46337942d55f3a8e6a97b147ca98d9ea8115555d
```

校验和与运行时自报提交提供制品追踪，不等于可复现构建证明或已验证容器镜像。

在仓库根目录的 PowerShell 执行：

```powershell
Push-Location vedioServer
cargo build --locked -p vs-service --example storage_contract
Pop-Location
$linuxRoot = (wsl --distribution Ubuntu --exec wslpath -a (Get-Location).Path).Trim()
wsl --distribution Ubuntu --exec chmod u+x "$linuxRoot/.artifacts/downloads/rustfs-1.0.4/extracted/rustfs"
wsl --distribution Ubuntu --exec bash "$linuxRoot/vedioServer/labs/rustfs/run-contract.sh" `
  "$linuxRoot/.artifacts/downloads/rustfs-1.0.4/extracted/rustfs" `
  "$linuxRoot/vedioServer/target/debug/examples/storage_contract.exe"
```

全局 Cargo 镜像不可用时，使用主 README 的进程级镜像参数，不修改全局设置。脚本会拒绝占用中的实验端口，以及版本/提交不符合固定参考的二进制。探针失败则返回非零状态，不以重试掩盖失败。

探针生成约 3 MiB 的非零、每轮变化的对象，逐端点校验大小、完整内容和 7 类范围，并用真实 Axum HTTP 服务验证 HEAD、206/416、ETag、If-Range、后缀范围。另从四端点竞争首次写入一个 8 字节对象，要求恰有一个成功，其余必须为条件不满足，随后核对最终内容。它只删除自己生成的两个键，并验证删除可见性。

## 重启与单进程故障实验

同一命令追加 `recovery`，运行分阶段验证：

```powershell
wsl --distribution Ubuntu --exec bash "$linuxRoot/vedioServer/labs/rustfs/run-contract.sh" `
  "$linuxRoot/.artifacts/downloads/rustfs-1.0.4/extracted/rustfs" `
  "$linuxRoot/vedioServer/target/debug/examples/storage_contract.exe" recovery
```

1. 新桶中执行只读验证，必须因对象不存在而失败，排除验证阶段自动补写。
2. 写入原始对象并确认完整内容、范围及 HTTP 字节；所有进程收到 SIGTERM 且正常退出后，复用原目录重启，执行只读验证。
3. 对本轮第四个进程执行 SIGKILL；从三个存活端点验证旧对象，再确认新对象写入及读取。
4. 第四个进程重新加入后，从四端点验证降级期间写入的对象。
5. 再次全停重启，分别只读验证新旧对象，最后清理本轮对象、临时桶与进程。

`VS_LAB_PHASE` 支持 `contract`、`measure`、`read-matrix`、`prepare`、`verify`、`cleanup`。后三者必须提供独立的 48 位十六进制 `VS_LAB_SEED`，据此重建期望字节；数据种子与凭证独立。只读验证函数仅接收媒体读接口，执行路径不调用写入操作。每阶段都有独立 JSON 收据，整个恢复运行结果写入 `recovery.json`。

故障阶段主动移除不可用端点，用于验证存储存活端点的语义，不证明客户端自动故障切换。正常重启不等于主机断电；单进程退出不等于磁盘损坏或网络分区。重加入节点能返回对象，也不证明缺失的物理分片已经修复。修复、节点间流量和有效扩容需要另设观测及验收条件。

## 范围与取消测量

同一命令追加 `measure`，通过实际媒体 HTTP 服务逐块消费响应：

```powershell
wsl --distribution Ubuntu --exec bash "$linuxRoot/vedioServer/labs/rustfs/run-contract.sh" `
  "$linuxRoot/.artifacts/downloads/rustfs-1.0.4/extracted/rustfs" `
  "$linuxRoot/vedioServer/target/debug/examples/storage_contract.exe" measure
```

该模式生成独立合成对象，串行执行七组 Range、一次完整范围读取、一次收到首块后取消。四个存储进程参与集群，媒体服务只连接第一个端点；读取仍为 64 KiB、并发 1。输出 `storage-measure-v1` 收据至运行目录的 `measurement.json`，最后清理本轮对象、桶与进程。

每个样本同时记录客户端应用消费量、媒体响应体产出量、S3 HTTP 响应体轮询量，以及 GET/HEAD 和未完成交换数。等待响应体释放所有实验许可且没有活跃上游交换后才取差值，避免上一请求残余工作污染下一请求。客户端正文逐字节校验，完整读取必须消费整个范围；取消必须发生在非空且未消费完的范围上。错误或超时直接失败，不静默重复直到通过。

响应头、首块和消费结束时间是本机单次诊断值。刚上传后的缓存未控制，使用 debug 构建，只有一个顺序消费者；没有统计分位数、CPU/RSS、网络线速字节、节点间或物理磁盘字节，也没有播放器首帧。客户端停止消费时，网络栈可能已经接收额外数据；上游交换被释放也不保证对端立即停止工作。

## 读取模式对照

同一脚本追加 `read-matrix`，比较 `chunk-64k`、`chunk-256k`、`chunk-1m` 和 `stream`。示例：

```powershell
wsl --distribution Ubuntu --exec bash "$linuxRoot/vedioServer/labs/rustfs/run-contract.sh" `
  "$linuxRoot/.artifacts/downloads/rustfs-1.0.4/extracted/rustfs" `
  "$linuxRoot/vedioServer/target/debug/examples/storage_contract.exe" read-matrix
```

对象大小预先固定为 393241、3145801、5243871 字节，第三个作为留出检查；内容由独立种子生成并记录 SHA256。每个对象覆盖前缀、非对齐、尾部、完整范围，以及消费 4096、98304、半个对象后取消。每种模式执行两轮，旋转并反转顺序，共 24 组、168 个样本；这只能减轻顺序偏差，不能替代受控冷暖缓存或统计功效。

取消预算是应用消费字节，所有模式在同一预算停止。新增 `client_polled_body_bytes` 表示请求库交给测试客户端的整块字节，可能大于预算；未消费尾部照常计量。原 `measure` 模式仍按首个响应块取消，以保留历史行为，不能用该模式直接比较不同块大小的取消收益。

收据 `storage-read-matrix-v1` 写入 `read-matrix.json`。完整组、失败原因和清理状态一并保留；总执行上限 300 秒，清理上限 20 秒，只删除预先计算出的三个对象。各样本使用同一个媒体路由、鉴权与字节校验，不另写模拟交付路径。

矩阵不读取真实用户资料、不做推荐训练。每模式仍只有单消费者，CPU/RSS、物理网络和磁盘开销未测；调参或生产默认值不能只根据两轮同机时间决定。原生流式是固定上游能力复用，条件式增大块和播放器动态预算尚未实现。

## 直接 S3 取消复现

追加模式 `direct-cancel`，使用预签名 Range 和 reqwest 直接读取，绕过媒体服务与 OpenDAL Reader。沿用上面的运行命令，将末尾模式替换为 `direct-cancel`。先用 `cargo build -p vs-service --example storage_contract --locked` 构建探针；探针测试需执行 `cargo test --workspace --all-targets --locked`，才能包含示例中的测试。

每轮 20 个独立对象，覆盖首个 GET、完整前缀后的 GET、64 KiB/1 MiB 范围和五种完成/取消条件。客户端禁止代理、重定向和自动重试。定时器先于响应头时才记录响应头前取消；响应头先到单独分类。正文完整对照校验状态、长度、范围和逐字节内容。响应头前取消不证明请求在服务器的实际执行阶段。

主体上限 300 秒，后续逐对象清理每项上限 12 秒，只操作已登记摘要；错误及超时仍产生收据。失败后的重启清理不覆盖原始失败。`direct-cancel.json` 保存 `storage-direct-cancel-v1` 收据，不输出签名 URL 或实验凭证。

2026-11-05 两轮各 20 案例，首次首个 GET 响应头前取消后出现一次删除锁超时；第二轮全部通过。保留时序反例，生产准入仍暂停，详情见 `../../../vedioServerRefer/RustFS取消最小复现.md`。

## 持续取消与资源观测

模式 `cancel-soak` 复用直接 S3 请求和定向删除，不调用业务媒体服务。运行前以
`cargo build -p vs-service --example storage_contract --locked` 构建探针；
原版和候选的命令均使用同一二进制与显式 `VS_LAB_SEED`，只替换 RustFS 路径。
固定配对和验收条件见 `../../../vedioServerRefer/problem-space/storage-cancel-soak-plan.json`。

8 个内容寻址对象在四个端点预热后，先静默 10 秒，再执行三轮各 15 秒的负载。
每 25 毫秒一个时隙、最多 8 个未完成请求；容量不足或时钟落后时跳过并计数，
不形成待处理队列，也不补发突发流量。五类动作等权：完整读取、响应头后丢弃、
0/1/4 毫秒截止。请求无自动重试，三轮静默恢复期为 30/30/60 秒。

每轮派发比例须达到 90%，且实际覆盖完整读取、头后丢弃和头前取消；请求错误、
本地排空超时、停止后的字节校验失败、对象删除失败均保留为失败。主体最多
420 秒，清理最多每对象 12 秒。只允许按收据登记的对象清理；重启补救不改写失败。

运行器同时启动 `sample-processes.sh`，每秒采样自有四进程的启动标识、CPU 时钟、
RSS、高水位、操作系统线程、打开的文件描述符及 `/proc/PID/io`。采样错误会使运行
失败；不是进程级任务跟踪器，也不访问凭证或进程环境。采样器最多运行 540 秒。

产物为 `cancel-soak.json`、阶段时间线 `cancel-soak.log`、`resources.tsv`、
`sampler.json` 和已有输入指纹。用以下命令汇总每个静默阶段最后五个完整样本：

```powershell
cargo run --manifest-path vedioServer/Cargo.toml -p vs-service --example storage_resources --locked -- "<实验目录>"
```

该工具校验 PID 身份、时钟及单调计数器，报告四进程资源总和，不事后选择通过阈值。
RSS 不回落不能单独证明泄漏，删除成功不证明所有远端租约归零，`rchar/wchar`
不是物理网络字节。功能验收、观测完整性和资源收敛结论必须分开。

## 历史运行结果

2026-11-05：四进程 WSL 基础合约已通过，覆盖 4 次直接完整读取、28 组直接 Range、48 项媒体 HTTP 检查、一次四端点小对象条件写竞争及清理。发布包 SHA256 和运行时报告提交已核验，现有 16 项应用回归及 Clippy 通过。最新收据见 `../../../vedioServerRefer/problem-space/storage-contract-evaluation.xml`。

同日完成恢复实验：两次正常全停重启、一次单进程强制退出、降级期间新写入和节点重新加入后的读取通过。七个正向阶段累计 26 次完整读取、182 次 Range 和 312 项 HTTP 检查。缺失对象反例按预期失败，两个对象、桶及进程已清理。最新收据见 `../../../vedioServerRefer/problem-space/storage-recovery-evaluation.xml`；默认健康合约也已再次回归。

同日新增传输观测并通过 21 项应用测试及 Clippy。测量运行 `contract-1lLrYPDs` 的九个样本通过：1 MiB 范围触发 16 次 GET，3145801 字节完整范围触发 49 次 GET，各另有一次 HEAD；取消样本应用消费 65536 字节，第二次 GET 已启动并被放弃。默认健康合约随后在 `contract-D2kieQ4O` 再次通过。测量原始收据和边界见 `../../../vedioServerRefer/problem-space/storage-measurement-evaluation.xml`，不能把该单次取消结果当成固定的浪费上限。

Docker 引擎和容器镜像仍未验证。WSL 与 Windows 挂载盘不是独立故障域；日志提示文件描述符软限制使部分缓存关闭，因此不能据该实验作吞吐或延迟选型。尚未验证主机断电、磁盘损坏、网络分区、物理修复、multipart 条件竞争、真实再平衡和性能收益。

## 分段条件发布

2026-11-06新增`multipart`模式，使用独立的`s3_publication_contract.exe`，其他模式继续使用
原`storage_contract.exe`：

```powershell
cargo build --locked -p vs-service --example s3_publication_contract
wsl --distribution Ubuntu --exec bash "$linuxRoot/vedioServer/labs/rustfs/run-contract.sh" `
  "$linuxRoot/.artifacts/downloads/rustfs-1.0.4/extracted/rustfs" `
  "$linuxRoot/vedioServer/target/debug/examples/s3_publication_contract.exe" multipart
```

探针生成三个合成字节对象，验证分段新建、另一端点重试复用、两端点竞争及已供给11MiB后取消；
两个成功对象均从四端点读回校验。清理仅删除登记内容键。运行器另外列举本轮独立桶的
未完成上传，非零或列表截断都会失败；最终对象删除成功不能替代这个门。

最终运行`contract-j3TMOSTe`的三阶段通过、未完成上传为零、桶与自有进程已清理。
这补充了multipart条件竞争的同机证据，不能覆盖上文的物理故障、旧读取消反例或性能缺口。
响应丢失造成未知上传ID和提交不确定性的反例保留在协议测试，不能由健康后端通过推翻。
详见`../../../vedioServerRefer/S3分段发布集成.md`。

## 取消生命周期与失败恢复

同一运行命令追加 `cancel-lifecycle`，用四种读取模式分别完整消费、消费 4096 字节及消费 98304 字节后取消。每个条件使用独立的 3145801 字节对象，避免前一案例污染后续案例。探针记录读取、即时删除和延后清理；各删除最多等待 12 秒，并校验四端点不可见。

`read-matrix` 和 `cancel-lifecycle` 失败时，运行器只重启本轮四进程，再执行 `cleanup-owned`。该内部阶段从不超过 1 MiB 的收据校验模式、同一桶和最多 24 个唯一内容摘要，全部校验通过才开始删除，不列举其他对象。空桶仍由 S3 删除操作确认；补救清理不改变原始收据或失败退出码。若收据不完整、重启失败或再次清理失败，保留目录并报错。

本轮矩阵的 168 个读取检查通过但清理失败；两轮生命周期对照分别有 4/12 和 5/12 即时删除失败，均为取消案例。第二轮五个失败全部伴随响应头前取消，存储日志记录对象写锁获取 5 秒超时。重启后的定向清理已通过，生产生命周期门仍未通过。不要只读 `restart-cleanup.json` 的成功来判断实验成功。

25 项应用测试、构建和全目标 Clippy 已通过；它们不能覆盖这一真实后端失败。记录和证据边界见 `../../../vedioServerRefer/读取策略与取消生命周期.md`。
