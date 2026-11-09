# vedioServer

短视频交付与跨领域用户画像推荐的 Rust 骨架。当前可运行 Feed、画像事件回流、推荐 API、媒体范围读取及独立进程副本。

画像事件新增离线备份/校验/封存恢复CLI，复用既有Qdrant来源不可覆盖发布和原事件重放；
活动写者、断尾、摘要/序号篡改及封存保留路径拒绝。恢复副本不自动启写，
跨视频/文档/服务的隐藏事实与原源重启已演练；无新增依赖，不改在线默认。
这不是在线分片或物理灾备，敏感备份加密/撤回治理尚未验，
见[画像备份与恢复演练](contracts/profile-backup-v1.md)。

原生端新增独立UniFFI绑定包，直接复用原Rust PlayerAdapter，
不改服务端workspace、锁文件或unsafe禁令。
Kotlin/JVM与Python已实际调用动态库，Android arm64/API24库已交叉构建，
Swift仅生成；不是Android/iOS播放器、真机或三低已验。
接口、票据生命周期、许可和复验见[native](native/README.md)。

Media3消费者现通过官方1.11.1发布接口编译和宿主真实类调用，
只把原Rust时间门接到起播获准后的普通点播，保留分配器、起播与实际I/O。
直播/重缓冲等仍走原策略，不把“不继续加载”当下载取消；
运行和未验边界见[Android消费者](native/android/README.md)。

Android消费者新增带源码/依赖清单的本地AAR草稿，
实际从封装class编译消费并转DEX，Rust及JNA5.19.1 arm64库段对齐已核验。
不是正式发布、APK或设备运行，使用边界见[AAR草稿](native/android/aar/README.md)。

独立本地素材[实验应用](native/android/app-lab/README.md)现已构建完整签名APK，
含实际Media3依赖和Rust/JNA库，APK对齐通过；首次真机安装被系统拒绝，
未绕过安全保护、未运行，不以APK构建成功代替设备播放通过。

冻结排序回放新增可选的逐领域显式反馈审计，分别统计正例覆盖、负例返回和未知结果；
总体微平均变好仍不能掩盖小领域退化。样本稀疏的领域保持unknown并使必需门槛不通过，
不会据此训练或改动线上排序。见[跨领域反馈审计](contracts/domain-feedback-audit-v1.md)。

冻结排序回放新增可选逐领域显式反馈审计，检查正反馈覆盖、样本不足和未知候选；
避免总体微平均掩盖跨领域退化。只作离线诊断门槛，不改训练、召回或线上排序。
见[跨领域反馈审计](contracts/domain-feedback-audit-v1.md)。

媒体节点维护新增显式`node_draining`：复用Danube的接单与卸载分离机制，
由原OpenRaft状态阻止新房间分配，既有房间继续播放，再逐房排空和移除节点。
同机三协调/两媒体进程、集群重启及重新分配后的真实音视频已验证；
固定回环约束和失联不强接管边界保留，不宣称物理多机或无缝迁移。
见[媒体节点维护契约](contracts/media-node-draining-v1.md)。
配套`media-admin`Rust运维客户端支持同刻预览、单次提案及未知结果读回，
不自动重放部署写入，见[维护CLI契约](contracts/media-admin-client-v1.md)。

浏览器实验新增显式`VS_LAB_WORKER_MODE=embedded`，复用已下载hls.js主库内置工作器。
两种素材32次播放验证后台执行与停止销毁，省去重复外部工作器响应；
本机无缓存对照首帧改善约1.0/2.5秒。原默认保留，实际缓存/CDN和原生仍需另验。
见[工作器代码复用](contracts/embedded-worker-v1.md)。

无屏障播放对照已接入原Rust实验链，按同观看位置核对卡顿、实收正文和有限资源。
两素材结果存在取舍：大素材慢网连续观看减少卡顿，较快网络多收正文；
低码率素材无卡顿收益。500毫秒继续显式候选，原默认保持。
见[无屏障播放对照](contracts/natural-playback-trace-v1.md)。

复用sheathe新增可选250/500毫秒片内多片段封装，保持原HLS对象和关键帧边界。
36组对照中，配合播放器progressive与直通/流式读取的8组在末字节阻塞时已提前出帧；
6组小素材仍无收益。正文有所增加，原封装和缓存默认不变。
接口、完整解码与限制见[HLS片内多片段封装](contracts/hls-chunks-v1.md)。

新增缓存到首帧的Rust受控源站与独立浏览器探针。
24组对照中，即使已收到首片除末字节外的正文，当前封装仍没有提前追加或解码；
保持默认配置，后续优先解决封装与播放器的消费边界。
见[缓存起播因果对照](contracts/cache-playback-probe-v1.md)。

媒体范围缓存支持显式`block-64k`及`block-64k-stream`：复用quick_cache守卫，
让同一64KiB块内的相邻短读共享填充。流式候选通过async-stream提前交付请求前缀，
最后字节待整块校验；取消停止填充。跨块保持精确范围，超限和原生流式模式保持直读。
冷读有多读代价，因此默认关闭，原缓存默认`exact`不变。
配置、指标和反例见[媒体单块范围缓存](contracts/media-block-cache-v1.md)。

新增显式`model-blockmax`：参考固定Tantivy块上界机制，在原分组内以64项块检查竞争门槛，
复用原Rust评分与Top-K，不增加常驻块索引或网络请求。同分块仍完整处理。
原`model-pruned`保留，默认后端不变；局部评分减少不等于总体三低达成。
约束、配置与迁移见[本地模型块剪枝](contracts/model-blockmax-v1.md)。

新增Iggy三节点故障实验：复用既有Rust反馈入口，两轮验证主节点退出、幸存多数派追加、
少数派返回unknown和恢复前缀一致。另一次WSL挂载盘退出阻塞作为未通过反例保留；
有界清理及Linux本地存储修订尚待真实复跑，见
[Iggy三节点故障与恢复](../vedioServerRefer/Iggy三节点故障与恢复.md)。

新增独立`feedback`角色，接收可信网关的最小反馈批次，启动前检查Iggy目标主题的线性一致元数据，
确认显式`persisted`策略和偏移后返回；
固定偏移快照可直接进入既有证据导出和统一回放。超时保留不确定状态，不自动重发。
协议夹具、双收集进程和CLI已验证；新增真实Iggy单节点追加、权限、正常重启及强杀恢复合约。
真实保留、跨副本故障、物理集群和手机渲染仍待验；
运行与批量成本见[共享反馈入口与Iggy适配](../vedioServerRefer/共享反馈入口与Iggy适配.md)。
复跑真实实例见[labs/iggy](labs/iggy/README.md)，固定坐标允许合法的`0`。

新增离线`replay_model_evidence`：共用既有证据解析，用同一冻结目录、历史请求和更早模型
对比全量/Top-K/分组剪枝，未显示或未反馈请求仍参与成本回放。
时间泄漏、来源改写及重复报告发布被拒绝；部分标签指标不代表无偏真实效用。
运行格式与收据见[固定来源统一模型回放](../vedioServerRefer/固定来源统一模型回放.md)。

新增显式`model-pruned`：复用紧凑分组和缓冲Top-K，仅跳过分数上界严格落后于门槛的整组。
两个入口和固定部署均已接通，无新依赖或RPC；两轮各432配置三路结果一致。
索引有常驻与构建峰值代价，部分负载变慢，默认继续关闭；见
[模型分组上界与评分消减](../vedioServerRefer/模型分组上界与评分消减.md)。

排序模型已支持内容指纹对象发布和固定部署绑定，模型缺失/错配时拒绝启动；
升级或回退创建新代次，旧API保留已加载模型，正常Feed不增加对象存储RPC。
模型支持保留的全量排序或显式`model-topk`精确选择；协议夹具与四进程验证边界见
[排序模型发布与部署绑定](../vedioServerRefer/排序模型发布与部署绑定.md)。

`model-topk`复用已有Qdrant派生选择器，完整过滤和评分后最多暂存2K项；
两个入口及固定部署已接通，默认配置保持原样。两轮216配置全部逐字段一致，
小目录及同分逆序有变慢反例，成本边界见
[模型精确TopK与召回边界](../vedioServerRefer/模型精确TopK与召回边界.md)。

学习日志新增可选grouped提交：只合并已排队记录，最多四条，无定时凑批，
仍同步成功后确认。四并发release对照降低同步次数和P50，串行无合并收益；
采集保持默认关闭、提交默认single，见[学习日志组提交](../vedioServerRefer/学习日志组提交.md)。

新增默认关闭的推荐决策采集与离线证据导出：各副本冻结一次最小画像投影，
以服务端决策ID关联可信网关的可见性及明确偏好；未显示和未反馈不自动标负。
已有双进程HTTP→导出→训练→新实例加载闭环，真实终端回调和无偏质量仍待验证；
同步落盘增加请求延迟，见[推荐决策与训练证据集成](../vedioServerRefer/推荐决策与训练证据集成.md)。

新增默认关闭的FTRL学习排序：离线冻结样本、不可覆盖模型发布、目录/模型双指纹加载，
在线本地六维评分。两个推荐入口沿用授权与负反馈过滤，无新增Cargo依赖或模型RPC。
它与旧Top-K召回互斥，支持显式部署模型指纹，尚未通过真实推荐质量门禁；运行和限制见
[FTRL学习排序集成](../vedioServerRefer/FTRL学习排序集成.md)。

新增受限H.264/AAC的离线fMP4/HLS发布，可将推荐与Feed直接指向带`.m3u8`后缀的主清单，
沿用内容寻址与固定版本。独立HTTP解码已验证，运行与限制见
[HLS分片与窗口交付集成](../vedioServerRefer/HLS分片与窗口交付集成.md)。

新增默认关闭的CMCD v1请求观测和媒体正文生命周期计数，支持请求头与查询参数、
推荐ID关联以及完整/提前释放/失败分类，不把客户端声明写入画像。
配置与真实窗口实验见[CMCD请求归因与取消观测](../vedioServerRefer/CMCD请求归因与取消观测.md)。

新增Media3缓冲规则的Rust移植和`/v1/playback/policy`策略发布；策略固定后本地决策不增加
逐片RPC。该模块尚未连接手机渲染器，默认值为实验参数，见
[Media3缓冲控制与策略发布](../vedioServerRefer/Media3缓冲控制与策略发布.md)。

新增本地播放器快照适配：按音视频连续区间交集决策，下载与追加两阶段确认，
切换代次隔离旧回调。真实网络取消和窗口探针已接入，手机渲染回调仍待绑定，见
[播放器快照与异步追加适配](../vedioServerRefer/播放器快照与异步追加适配.md)。

## 当前边界

- `vs-core`：公开候选目录、临时画像投影、跨领域排序基线。领域使用标识符，示例包含 video/article/service。
- `vs-storage`：OpenDAL 的 FS/S3 读取适配。64 KiB 分块、单路读取，响应体背压和取消会传递至上游流。
- `vs-service`：Axum 服务入口。`api`、`media`、`all`、`profile` 四种角色。API 可查询独立画像服务，画像角色持有本地事件日志。

```text
授权网关 -> API 副本 -> 临时画像投影 + 固定版本公开目录 -> 有界推荐列表
播放器/交付网关 -> Media 副本 -> FS（开发）或共享 S3（集群）-> 范围字节流
```

`/v1/feed` 使用当前进程维护的画像，可选事件日志提供单机重启恢复。`/v1/recommendations` 仍支持无状态的外部画像投影。多个 API 副本必须使用相同目录快照；多个 Media 副本必须访问同一不可变对象集合。`x-catalog-sha256` 可检测目录漂移。
这验证的是计算面的多实例能力，尚未验证对象存储集群的副本、迁移和故障恢复。

存储实验入口见 [RustFS 四节点说明](labs/rustfs/README.md)：已复用固定上游配置，WSL 四进程的基础合约、正常全停重启、单进程强制退出期间的读写和重新加入后的读取已验证。Docker 容器、物理故障修复、真实多机扩容及性能仍待验。RustFS 是优先实验根，Garage 是副本型对照；源级依据及后续验证门见 [存储根项目评估](../vedioServerRefer/存储根项目评估.md)。

## 运行

在本目录执行，先配置进程环境。推荐 API 仅供可信授权网关调用，服务密钥不能放进客户端。

```powershell
$env:VS_ROLE = 'api'
$env:VS_BIND = '127.0.0.1:8080'
$env:VS_CATALOG = (Resolve-Path 'examples/catalog.json').Path
$env:VS_SERVICE_TOKEN = [Guid]::NewGuid().ToString('N')
# 可选：为单进程实例启用可重放的本地画像事件日志。
# $env:VS_PROFILE_EVENT_LOG = Join-Path $PWD.Path '.artifacts/profile-events.jsonl'
cargo run --locked -p vs-service
```

启动前可在同一环境打开调用终端；服务密钥通过进程环境传入，不写入示例文件或日志。
调用格式：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8080/v1/recommendations' `
  -Method Post -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $env:VS_SERVICE_TOKEN" } `
  -Body (Get-Content 'examples/recommendation.json' -Raw)
```

样例目录只有候选元数据，没有伪造可播放视频。真实媒体发布前需要生成散列并写入目录中的 `assets`；对象键固定为 `media/<sha256>`，上传方必须校验字节数和散列，发布后不得覆盖同名对象。

| 配置 | 含义 |
| --- | --- |
| `VS_ROLE` | `api` / `media` / `all` / `profile` / `feedback`，默认all；profile需本地事件日志；feedback只收集回调，不加载推荐目录/媒体 |
| `VS_BIND` | 默认 `127.0.0.1:8080`，每个本地实例使用不同端口 |
| `VS_SERVICE_TOKEN` | 必填，32–256 个可打印 ASCII 字符，可信网关持有 |
| `VS_CATALOG` | 目录 JSON，最大 8 MiB、10,000 个候选/资产；默认 examples/catalog.json |
| `VS_PUBLICATION_ROOT` | 可选固定发布根目录，与`VS_CATALOG_RELEASE`配对；启用时不得同时配置`VS_CATALOG` |
| `VS_CATALOG_RELEASE` | 固定发布版本；fs媒体根须匹配，s3模式须显式设置VS_PUBLICATION_BACKEND=s3并共用S3配置 |
| `VS_PROFILE_EVENT_LOG` | 可选，本地单写者事件日志路径；启动时重放，日志上限 32 MiB，不能由多个副本共同写入 |
| `VS_PROFILE_AUTHORITY_URL` | API/all 可选，画像服务的 HTTP/HTTPS 根地址；与本地事件日志互斥 |
| `VS_PROFILE_AUTHORITY_TOKEN` | 远端画像模式必填，独立的内部服务密钥，不发送给终端用户 |
| `VS_PROFILE_CONSENSUS_CONFIG` | API/all显式只读实验，绝对路径JSON最多8KiB；明文仅回环，可选固定私网mTLS读取身份；与其他画像后端及部署通道互斥 |
| `VS_QDRANT_URL` | API/all 可选，Qdrant 根地址；启用 Feed 标签召回，索引需先离线发布 |
| `VS_QDRANT_API_KEY` | 可选，环境注入；在线只读与离线发布使用各自所需权限 |
| `VS_QDRANT_SCORING` | `positive` 默认；`signed` 实验性地将负兴趣纳入稀疏召回，不代表质量门禁通过 |
| `VS_RECALL_BACKEND` | `catalog` / `model-topk` / `model-pruned` / `model-blockmax` / `grouped` / `qdrant`；三个model后端需先加载模型，仅用于api/all；未设置时有Qdrant地址选qdrant，否则catalog；非qdrant模式不得设置Qdrant地址 |
| `VS_STORAGE=fs` | Media/all 还需设置已存在目录 `VS_MEDIA_ROOT`；目录由可信发布器维护 |
| `VS_STORAGE=s3` | 还需设置 `VS_S3_ENDPOINT`、`VS_S3_REGION`、`VS_S3_BUCKET`、`VS_S3_ACCESS_KEY_ID`、`VS_S3_SECRET_ACCESS_KEY` |
| `VS_RANK_CONCURRENCY` | 默认 4，范围 1–128，满载返回 503 |
| `VS_RANK_MODEL` | 独立api/all可选，与模型指纹配对；最多128KiB，绑定同一目录原始字节；部署模式从目标记录取模型，不允许重复配置 |
| `VS_RANK_MODEL_SHA256` | 模型文件的固定SHA256，由可信部署者指定；缺失、内容或目录不符拒绝启动 |
| `VS_LEARNING_JOURNAL` | api/all可选，与副本标识配对；独占本地文件，最多8MiB/64KiB每条，4个提交；等待同步落盘，故障或容量满拒绝继续采集 |
| `VS_LEARNING_SOURCE_ID` | 学习日志的副本标识，每份日志唯一；重启沿用，不能把两个副本配置为同一来源；不是分布式租约 |
| `VS_LEARNING_COMMIT_MODE` | 默认single逐条同步；grouped只合并已经排队的最多4条，不定时凑批；两者均同步成功后返回决策ID |
| `VS_FEEDBACK_CONFIG` | 仅feedback必填，最多64KiB；Iggy首选地址、可选fallback_endpoints（合计最多4个）、流/主题/分区及来源，示例见examples/feedback-config.json |
| `VS_FEEDBACK_IGGY_TOKEN` | 仅feedback或离线快照命令必填，Iggy专用Bearer凭证；收集写入和快照读取应各用最小权限 |
| `VS_CONSUMPTION_ACCESS_CONFIG` | feedback可选，最多16KiB的消费专用JWT验证配置；固定issuer、audience和最多4个Ed25519公钥；启用公开消费入口，省略时关闭 |
| `VS_FEED_ACCESS_CONFIG` | api/all可选，最多16KiB的推荐JWT验证配置；固定issuer、audience和最多4个Ed25519公钥；启用`POST /internal/v2/feed`，省略时关闭 |
| `VS_MEDIA_CONCURRENCY` | 默认 64，范围 1–1024，许可随响应体释放 |
| `VS_MEDIA_READ_MODE` | `chunk-64k`（默认）/ `chunk-256k` / `chunk-1m` / `stream`；启动时选择，非法值拒绝启动 |
| `VS_DELIVERY_OBSERVATION` | 默认0关闭，1启用；仅media/all，输出有界CMCD子集与每次媒体结束日志，启用有解析和日志开销 |
| `VS_PLAYBACK_LINKAGE_V2` | 默认0保持216字符旧令牌；仅api/all显式设为1才签发238字符令牌，升级后的媒体端兼容两版并在开启交付观测时验证CMCD或服务端能力关联；会增加媒体路径字节，需先升级读取端再灰度签发 |
| `VS_PLAYBACK_POLICY` | api/all可选，最多1024字节的完整策略JSON；默认低/高水位2/4秒、起播1秒、重缓冲2秒、8MiB媒体预算；不自动配置客户端 |
| `VS_MEDIA_CACHE_BYTES` | Media/all可选，默认0关闭；启用时16KiB至512MiB，须为4KiB倍数 |
| `VS_MEDIA_CACHE_ENTRY_BYTES` | 默认65536；精确Range或扩展后的块不得超过此长度，最多1MiB且不得大于总容量四分之一 |
| `VS_MEDIA_CACHE_FILLS` | 默认4，范围1至64；并行填充预算，满时走原直通路径 |
| `VS_MEDIA_CACHE_POLICY` | 默认`exact`；`block-64k`完整块后返回，`block-64k-stream`提前交付前缀；跨块精确键，均需开启缓存且条目至少64KiB |

网关负责 TLS、终端用户登录、授权版本校验和撤销；S3凭证仅给媒体读权限。
内部接口使用服务级Bearer，可选公开消费入口仅验证绑定具体交互的短期JWT，不提供登录或凭据签发。
可选`/internal/v2/feed`同时要求服务级Bearer及`X-Feed-Identity`短期JWT；主体及领域范围均来自签名声明，
不接受请求正文主体。它只供可信用户网关调用，终端客户端仍通过网关访问，也不提供登录、签发、实验分组
或曝光概率。多API副本须使用同一验证配置，契约见[可信推荐访问凭据](contracts/feed-access-v1.md)。

本地文件发布器使用完整散列/长度校验和不可覆盖发布：媒体对象先完成，再提交内容指纹目录，
最后绑定固定版本。运行实例不追随可变latest，旧版可继续加载。CLI入口、双进程验证和限制见
[不可变媒体与目录发布](../vedioServerRefer/不可变媒体与目录发布.md)。
该入口约束受信发布者，不阻止外部管理员改写底层文件；S3目录发布、在线切流和物理集群尚未完成。

S3媒体对象上传已新增独立离线入口`publish_s3_media`，复用OpenDAL条件写与分段完成；
默认两个上传、5MiB分段、单段并发，支持取消监督及清理结果。命令配置、真实四端点验证和
响应丢失边界见 [S3分段发布集成](../vedioServerRefer/S3分段发布集成.md)。
目录版本仍用本地发布入口；远端目录标记和在线切流尚未接入。

可选缓存复用quick-cache 0.7.0的加权与异步加载守卫，命中前仍执行鉴权、目录和HEAD长度检查；
默认精确键不复用部分重叠，显式块策略共享同块邻近范围。原生stream及超限Range直通，
错误和部分数据不发布到缓存。流式候选可先返回前缀，完整响应仍依赖块尾；
缓存逻辑容量不是进程RSS或活动响应持有字节。
实验、配置与反例见 [媒体范围缓存集成](../vedioServerRefer/媒体范围缓存集成.md)。

## 接口与状态

| 接口 | 行为 |
| --- | --- |
| `GET /healthz` | 存活检查，无鉴权 |
| `GET /readyz` | 目录指纹；有媒体后端和资产时探测首个资产的长度，不冒充全库检查 |
| `POST /v1/recommendations` | 64 KiB 请求上限；最多 16 场景、128 兴趣项、50 返回项 |
| `POST /v1/profile/events` | 接收公开候选的有限行为事件；事件 ID 去重，画像容量上限 10,000 个主体 |
| `POST /v1/feed` | 从当前进程画像生成短期投影，再调用同一排序器返回候选；投影有效期 60 秒 |
| `POST /internal/v2/feed` | 可选的网关内部委托入口；同时验证服务Bearer和用户身份JWT；正文不接收subject；需显式配置`VS_FEED_ACCESS_CONFIG` |
| `GET/HEAD /v1/playback/policy` | api/all角色的固定缓冲策略，绑定目录和策略指纹，支持ETag；供可信网关获取，本地控制器无需逐片RPC |
| `GET/HEAD /v1/media/{sha256}` | 已发布资产；200/206/304/416；单一 Range、If-Range、ETag；不接受任意存储路径 |
| `GET/HEAD /v1/media/{sha256}/{filename}` | HLS类型别名，仅`index.m3u8`及`media.mp4`，与已发布内容类型匹配；沿用原媒体读取路径 |
| `GET /v1/metrics` | 推荐次数、媒体响应体字节数、过载次数、媒体许可，以及 S3 HTTP 读取计数 |

除 healthz 外均需服务鉴权。个性化响应为 `no-store`；媒体响应为 `private`，未来 CDN 公开缓存需单独设计签名授权。
`/v1/metrics`的`delivery`默认null；启用后区分正文已产出、提前释放、读取失败及响应头前取消。
这些计数既不是客户端收到量，也不是观看量；HEAD和错误JSON不计作媒体正文。
`media_bytes_yielded` 是交给 HTTP 层的字节数，**不是**客户端收到的字节、有效观看字节或物理出口带宽。
S3 后端额外返回 `storage_http`；FS 或没有后端时为 `null`。其中 `requests`、`get_requests`、`head_requests` 是 OpenDAL 传输器调用次数；`response_body_bytes` 是实际轮询到的响应体字节，HEAD 的对象长度不计入。`status_errors` 计非 2xx 响应，`transport_errors` 计传输/正文读取错误及提前 EOF。
`storage_read_mode` 返回当前存储读取模式。三个 `chunk-*` 模式按指定大小拆分存储请求并等待整块；`stream` 使用 OpenDAL 原生流式读取同一个有界 Range，不等待整个范围读完才返回。流式模式的网络缓冲、对端读取量及取消残余仍需测量，不能把少 GET 直接当作少带宽或固定内存上限。
`active_exchanges` 表示本地尚未完成的交换；`abandoned_exchanges` 表示完成前被释放的交换。`abandoned_before_headers` 与 `abandoned_during_body` 分别记录响应头前和正文期间被释放的交换，空闲后两者之和等于总放弃数。它们不等于用户取消次数，也不能证明对端停止读盘或释放对象锁。计数器随 `MediaStore` 实例共享，进程重启后清零；各字段为独立原子读取，并发快照不具事务一致性。
计数不含 HTTP 头、TLS/TCP、重传、系统缓冲、存储节点间流量或磁盘读取。应用消费字节只在实验客户端逐块读取时单独记录，不能推算成有效观看量。Range 与取消测量入口见 [测量说明](labs/rustfs/README.md#范围与取消测量)。
读取模式对照见 [矩阵实验](labs/rustfs/README.md#读取模式对照)。模式由可信部署配置选择，客户端不能通过请求任意放大读取块；默认值仍为 64 KiB，生产选择需要真实播放范围、取消与资源证据。

2026-11-05 实验发现 RustFS 1.0.4 在部分响应头前取消之后，后续对象删除因锁获取超时返回 503。四种模式均仅作为实验配置，生产准入暂停；流式正文取消的少量成功样本不足以排除同类风险。详见 [生命周期评估](../vedioServerRefer/读取策略与取消生命周期.md)。
默认排序为可解释的未训练基线：标签平均亲和度、先验同分排序、稳定 ID。可选FTRL为离线学习路径，
不会自动从下载或行为规则生成训练标签；模型分数未经概率/跨域效用校准。
可选 Qdrant 标签召回仍经过场景、画像隐藏和拒绝标签校验，与学习排序暂互斥；
真实推荐质量、跨域分数校准和多样性保障尚未完成。

独立`api`/`all`实例可显式试用默认关闭的有界列表重排：

```powershell
$env:VS_SLATE_POLICY = '{"schema":"tag-rank-mmr-v1","candidates_limit":20,"relevance_milli":600}'
```

两个推荐入口共享策略，最多在50个已授权候选中选择，首项及原`affinity`/`rank_score`
不变。`candidates_limit`低于请求条数时按请求条数扩池；`relevance_milli=1000`不扩池且
严格保留旧结果。小于1000使用排序位置相关性与标签二值余弦冗余；缺失标签不作为新颖证据。
这不是领域配额或用户满意度优化保证，结果也不再保证按原始分数单调下降。
`x-slate-policy`及`/readyz.slate_policy`区分策略；客户端应保留服务返回顺序，不再自行按分数重排。

策略参与`learning-decision-v2`内容指纹，记录原始请求条数和实际返回顺序；
未启用时仍写v1，旧日志指纹不变，新读取器支持混合日志。旧二进制不认识v2，不可盲目降级
打开新日志；切回策略关闭时也必须保留可读v2的二进制或使用新日志文件。
回放报告显式标明历史策略；既有对照算法仍不自动应用该策略，不能拿其精确保真通过证明MMR效果。
固定部署选择尚未绑定列表策略，因此禁止与`VS_DEPLOYMENT_CHANNEL`共用。
策略校验见`contracts/slate-policy-v1.schema.json`，移除环境配置即可在独立实例恢复原排序。

画像投影只校验范围、有效期和结构。新增的内存画像只用于最小闭环：事件按主体写入当前副本，
每个主体最多保存 128 个兴趣标签、256 个隐藏候选和最近 128 个事件 ID；超过画像集合
上限返回 507，不静默截断偏好。未设置 `VS_PROFILE_EVENT_LOG` 时进程重启会丢失状态；
设置后会把事件追加到本地 JSONL，启动时重放恢复画像。独立本地画像不会跨 API 同步；共享模式使用独立画像服务，
不能据此声称完整画像治理、即时撤销或长期记忆已经完成。内存去重覆盖最近 128 个事件，
事件日志对已保存的主体和事件 ID 保持全局去重。事件日志使用单写者锁，同一文件被第二个
副本打开会失败；它不是跨机器事件总线。

启用日志后，成功响应发生在同步写入及内存投影更新之后。已接纳提交最多 16 个，
满载返回 503；HTTP 超时或客户端取消后，已接纳提交仍继续完成。客户端可使用同一
事件 ID 重试。优雅停机最多等待 30 秒排空这些提交。写入或同步失败后的日志停止
接纳新事件，重启重放后再恢复写入，避免继续拼接不确定的尾部。

提交顺序锁与投影读写锁已分离：落盘等待期间，Feed和内部投影接口可读取上一份已提交状态；
短暂发布新投影后才返回成功，所以成功确认后的新读取可见Hide。历史接口和就绪检查
仍经过完整提交屏障，不返回领先于内存投影的历史水位。同步方法`profile_history_checkpoint()`
遇到正在提交时显式返回错误，不阻塞调用线程。该改动不提高单写者的落盘吞吐上限，
也不等于画像已经分片；验证见[画像提交读写隔离](../vedioServerRefer/problem-space/profile-commit-isolation-evaluation.json)。

新v2日志保存提交时特征、目录指纹和规则版本，重放不再依赖当前候选标签。
旧v1需用可信原目录和显式指纹迁移到新文件，禁止自动用新目录补全历史。
运行实例仍固定目录快照，API与画像权威必须匹配目录指纹。
日志达到32MiB后拒绝新增事件，轮转、压缩、跨机器共享及撤销传播仍待接入。
迁移入口及验证见 [开源根选型与事件版本集成](../vedioServerRefer/开源根选型与事件版本集成.md)。

`/v1/profile/events` 当前适合可信事件网关调用，事件中的 `subject` 不等于终端认证。
生产部署需要把事件鉴权、撤销版本和跨副本事件日志放到独立画像服务；当前实现用于验证
数据流和排序边界，不承担跨设备事实库。

2026-11-05 已完成一次真实本地 HTTP 冒烟：先写入 `like` 事件，再请求 `/v1/feed`，
返回 `memory-1` 投影和 `tag-affinity-v1` 排序结果。机器可读记录见
`../vedioServerRefer/problem-space/profile-feed-loop-evaluation.xml`。
同日完成真实进程重启冒烟：第一进程写入事件并退出，第二进程从同一日志重放后返回
相同画像版本和候选。记录见 `../vedioServerRefer/problem-space/profile-log-restart-smoke.json`。

最小运行闭环：

```powershell
$event = '{"event_id":"event-1","subject":"user-a","candidate_id":"video-rust","kind":"like"}'
Invoke-RestMethod 'http://127.0.0.1:8080/v1/profile/events' `
  -Method Post -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $env:VS_SERVICE_TOKEN" } -Body $event

$feed = '{"request_id":"feed-1","subject":"user-a","domains":["video"],"limit":10}'
Invoke-RestMethod 'http://127.0.0.1:8080/v1/feed' `
  -Method Post -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $env:VS_SERVICE_TOKEN" } -Body $feed
```

## 多 API 副本共享画像

一个 profile 进程负责事件提交与投影，多个 API 在本地排序并查询同一个画像服务。
部署步骤及边界见 [多副本画像集成](../vedioServerRefer/多副本画像集成.md)。

```text
事件网关 -> API A/B -> profile -> 单写者事件日志与画像
Feed 请求 -> API A/B -> 有限画像投影 -> API 本地排序 -> 媒体引用
媒体请求 -> Media -> FS/S3
```

内部接口仅在 profile 角色提供：`POST /internal/v1/profile/events` 和
`POST /internal/v1/profile/projection`，同时检查内部 Bearer 和目录 SHA-256。
客户端按进程复用连接池，最多 64 个在途请求、500 毫秒连接预算、2 秒总预算，
响应最多 64 KiB；不自动重试、不跟随重定向。目录不一致或同一事件 ID 被用于不同正文时返回 409；
相同事件正文的重试按重复事件处理。仅内存画像为控制占用只保留最近 128 个事件 ID；
持久日志则在日志保留范围内校验完整历史。画像服务不可用时，
个性化 Feed 返回 503，避免因匿名回退而重新展示隐藏内容。

API 计算副本可独立增加，画像服务仍为单写者；没有实现画像分片、多写者、自动选主、
故障转移或自动扩缩。本轮使用同机独立进程验证，跨机器地址已可配置。
`/readyz` 会检查画像服务及目录。API 的画像主体和事件计数仍为本地值，
权威统计请读取画像服务；`profile_store` 区分 local 与 remote。

### 共识画像只读实验

上述单入口行为仍为默认。可显式开启共识投影到Feed的实验适配：
固定名单内线性读，响应绑定集群、目录、布局、主体、领域及应用索引；
失去多数派或全部失联返回503，不以空画像回退。事件入口405，不代理写入。
配置、权限及有限期限见[共识推荐契约](contracts/profile-consensus-feed-v1.md)。

`labs/profiles/run-consensus-feed.ps1`验证三协调、两API真实进程的签名主体、
跨域Hide、主故障、少数派、恢复和重启；同机实验不证明物理容错或生产容量。
原明文适配不是专用只读凭据；可选[专用读取mTLS](contracts/profile-read-mtls-v1.md)
复用原`vs-tls`固定目标客户端，独立读取证书和令牌仅允许投影及最小就绪。
应用索引仍不是历史前缀摘要；生产CA/发行者、实例身份、在线迁移和真实终端仍待验。

## 验证与上游

```powershell
cargo fmt --all -- --check
cargo test --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

集成测试包含独立 API 进程、进程退出后其他副本继续服务及重启一致性；S3 测试使用本地协议夹具，不代表真实 S3 集群通过验证。
`--all-targets` 同时运行存储探针示例中的取消分类与正文完整性测试。`labs/rustfs/run-contract.sh` 的 `direct-cancel` 模式独立验证直接 S3 取消；最新反例及收据见 `../vedioServerRefer/RustFS取消最小复现.md`。
锁获取取消的候选修复和复跑入口见 [独立锁实验](labs/rustfs-lock/README.md)。实际上游锁库中原版 4 通过/8 失败，补丁版 12 项通过；上游完整单元测试两者均有 1 项截止时间失败，完整 S3 二进制尚未回归。实验单独安装 Rust 1.99，不改变本业务工作区的 1.96 基线或默认存储配置。
测试启动的进程会清理。构建日志、上游克隆位于仓库根目录 `.artifacts`，构建产物位于本目录 `target`，都不提交。

当前机器用户 Cargo 配置使用全量 Git 镜像，验证时使用进程级稀疏镜像覆盖，没有修改全局配置：

```powershell
cargo --config 'source.crates-io.replace-with="video-sparse"' `
  --config 'source.video-sparse.registry="sparse+https://rsproxy.cn/index/"' test --workspace --locked
```

本机固定 `1.96.0` 工具链记录了 Clippy 组件但缺少可执行文件；此前业务验证使用 `cargo +stable clippy`，当时核对 stable 的 rustc 同为 `1.96.0 (ac68faa20)`。镜像覆盖参数需放在 `clippy` 子命令之后；没有修改业务编译器基线或用户全局源配置。锁实验的独立 1.99 工具链见上文。

服务和领域代码为 Rust；rustls 使用 ring，仍含原生密码学依赖，不声称整个依赖树是纯 Rust。
新增离线MP4处理和单视频目录发布入口，复用`mp4san =0.5.4`，保留原编码并前置播放索引；
沿用已有媒体Range、鉴权和固定目录。运行方法、资源预算及边界见
[MP4视频处理与发布集成](../vedioServerRefer/MP4视频处理与发布集成.md)。
新增受限HLS分片发布，未做完整CMAF认证；编解码、训练与播放器动态预取尚未接入。FFmpeg仅用于独立测试，
不属于生产运行依赖。参考与许可证见 `THIRD_PARTY.md`，决策和后续验证见 `../vedioServerRefer/根参考与开发计划.md`。

## Qdrant 候选召回

未指定 `VS_RECALL_BACKEND` 时，设置 `VS_QDRANT_URL` 会在 `/v1/feed` 启用 Qdrant 召回，
否则保持全目录排序；显式 `grouped` 走下述本地分组后端。
先用相同目录文件离线发布索引：

```powershell
$env:VS_QDRANT_URL = 'http://127.0.0.1:6333'
$env:VS_CATALOG = (Resolve-Path 'examples/catalog.json').Path
cargo run --locked -p vs-service --example publish_recall
```

目录 SHA-256 决定物理索引集合和发布别名；完整读回校验通过后才发布别名，已有集合拒绝覆盖。
启用Qdrant的服务在监听前逐点核对目录对应的属性、向量、精确计数、别名和配置；
查询固定物理集合，运行中别名重绑不会移动查询目标。
`/readyz`报告启动校验收据并检查集合实时状态，不重复逐点读取。内容核对是只读检查序列，
不替代发布后禁止原地写入的权限和保留策略。完整边界见
[索引就绪与物理集合固定](../vedioServerRefer/索引就绪与物理集合固定.md)。
在线合并最多 128 个标签兴趣候选和 64 个场景先验候选，复用排序与画像过滤。
Qdrant 不可用时保留有界先验并继续使用有效画像，`x-recall-mode` 标记
`qdrant-tags+prior`、`prior-cold` 或 `prior-degraded`；未启用召回时为 `catalog`。
`VS_QDRANT_SCORING=signed` 可选带符号召回，成功时标记 `qdrant-signed-tags+prior`。
全部兴趣非正且至少一个为负时，`signed` 改用中性优先先验，标记 `prior-nonpositive`，
跳过不可能返回正分的索引查询；中性不足时仍补负分，保持隐藏与拒绝标签过滤。
两种评分复用相同目录索引；个人召回 128、场景先验 64 的预算不变。
`VS_RECALL_BACKEND=grouped` 启用本地完整目录分组归并，成功时标记 `grouped-tags`。
分组索引按场景和完整标签组合建立不可变组，组内按最终排序键归并，能处理已验证的同分边界；
代价是每个 API 副本持有目录分组索引，目录发布时需要重新构建。它不是 Qdrant 集群或分布式
状态方案，默认仍不启用。
`/v1/metrics` 增加 `recall_enabled`、`recall_queries` 和 `recall_degraded`。

已用官方 1.20.0 二进制验证真实索引、共享画像、隐藏及故障降级。
最终测试 55 项通过，包含显式执行的真实合约；排序上限不等于生产性能或质量收益。
索引只保存公开候选标签，画像服务不可用时仍拒绝个性化请求。
复现命令、原始收据及限制见 [Qdrant 召回集成](../vedioServerRefer/Qdrant召回集成.md)。

## 推荐质量回放

2026-11-09新增离线`replay_temporal_holdout`，固定来源/切分/模型，
重现前窗产物后只评价指定验证或测试窗，复用全目录评分、部分标签及逐领域审计。
不把模型自报截止或合成通过当来源事实，不自动选优或改线上；
旧日志回放继续覆盖零反馈决策。格式见[固定时间窗回放](contracts/rank-temporal-replay-v1.md)。

新增隔离的`probe_model_recall`入口：复用Qdrant稀疏索引，把当前线性模型权重移到查询侧，
同一目录索引可供多个模型复用；候选仍交给原Rust模型重排。
真实进程实验同时保留负权重、空标签和近分/全零反例，不改线上默认路径。
实验配置可加`"response_modes":["payload","id_only"]`，对比完整载荷与固定点ID响应。
两轮150组配对的候选与完整重排结果一致，JSON响应正文约减少68.86%；
这是索引服务到调用方的中间正文收益，未证明客户端线路、CPU、RSS或推荐质量收益。
配置、完整读回、正文计量及浮点边界见[模型感知召回实验](contracts/model-aware-recall-v1.md)。

固定来源模型回放可在配置中加入`"recall_audit":{"require_full_retention":true}`，
将旧亲和度分组候选交给同一模型重排，与全目录模型Top-K比较。
审计报告包含保留率、遗漏候选和部分标签指标；严格失败仍发布诊断报告并退出2。
缺省不执行审计，不改线上路径。详情见[固定来源统一模型回放](../vedioServerRefer/固定来源统一模型回放.md)。

已提供可离线运行的质量对照：

```powershell
cargo run --locked -p vs-service --example recommendation_replay -- --demo
```

它复用画像规则和排序器，比较全量目录与有限召回，输出 Recall/NDCG/MRR、全量 Top-K
保留率、候选数量及目录覆盖。历史与未来标签按时间切分，真实输入也可通过两个文件参数
传入；设置 `REPLAY_RECALL_MODE=qdrant` 可查询已发布的真实索引。

合成诊断中，正向召回 Recall@10 为 0.5，带符号召回恢复到全量排序的 0.8。
独立机制校验曾发现纯负兴趣下的中性遗漏与同分截断；中性优先已修复前一条，后一条仍失败。
默认仍为正向模式，带符号模式不能作为全量排序的质量无损替代。数据不是线上用户质量结论。
基础排序同时统一了 `-0.0` 与 `+0.0` 的中性语义，空标签内容按先验参与同分排序。

`REPLAY_RECALL_MODE` 可设为 `prior`、`exact-sparse-reference`、`exact-signed-reference`、
`qdrant`、`qdrant-signed` 或 `grouped`；`REPLAY_TIMING_SAMPLES=1..32` 保存逐请求重复样本与描述性
P50/P95/P99。`--holdout` 运行独立机制校验；不是统计留出集。
报告 v3 还逐请求记录 `prior_examined`、`neutral_prior`、`remote_query_issued`。
先验最多输出 64 个，不代表只检查 64 个；中性筛选最坏两次遍历所请求场景的目录。
分组模式的 v4 报告另记录索引组数、构建耗时、组头数量和候选检查量。

追加 `--require-no-regression` 可启用门禁：运行完成但质量下降或缺少正标签时退出 2，
输入或运行错误退出 1，通过退出 0。没启用门禁时退出 0 只表示报告生成成功。
完整格式见 [推荐回放评估](../vedioServerRefer/推荐回放评估.md)，历史失败反例与
成本边界见 [召回排序目标对齐](../vedioServerRefer/召回排序目标对齐.md)，分组路径证据见
[分组召回评估](../vedioServerRefer/分组召回评估.md)。

## 召回成本矩阵

核心测量入口只依赖 Rust 核心和已有开发依赖，完整矩阵要求 release：

```powershell
cargo build --release --locked -p vs-core --example recall_cost_matrix
& ./labs/recall-cost/run-matrix.ps1 -Samples 64 -Warmup 8 -MemoryRepeats 2
```

比较 256～10000 候选、不同实际组数、过滤和 K；每单元预热后以 ABBA 顺序测完整推荐函数，
逐样本核对有序结果。分组报告保存组头和输出缓冲容量，`allocation_layout()` 单独统计
索引对象及向量容量；Windows 驱动另在自有子进程暂停阶段读取工作集、私有字节和累计峰值。
这些内存口径不能相互替代，也不表示完整服务 RSS 或生产尾延迟。

两轮各 4096 对排序结果一致，但高组数场景出现速度退化，因此没有启用自动后端阈值。
复现范围、原始样本和失败边界见 [召回成本矩阵](../vedioServerRefer/召回成本矩阵.md)。

后续已复制固定 Qdrant 的有界堆与2K缓冲 Top-K 局部代码，对齐完整排序键后进行同场比较。
`grouped` 内部在总组数不超过128时直接归并，其余采用缓冲 Top-K；组头向量容量最多256槽，
不再随组数无界增长。仍遍历相关组，不保证所有负载都快于 catalog。来源与改动见
[上游复用记录](THIRD_PARTY.md) 和 [上游TopK复用评估](../vedioServerRefer/上游TopK复用评估.md)。

同进程策略对照：

```powershell
& ./labs/recall-cost/run-matrix.ps1 -CompareHeads -Workload ties -Samples 64 -Warmup 8
& ./labs/recall-cost/run-matrix.ps1 -CompareHeads -Workload varied -Samples 64 -Warmup 8
```

`-Strategy all|heap|buffered` 单独测一种路径；`-Workload varied` 额外覆盖正、零、负分。
驱动核对报告版本、策略与样本数，记录负载并保存源码及许可证指纹；不自动选生产后端。

## S3远端目录发布

发布媒体后，可用已有`VS_S3_ENDPOINT`、`VS_S3_REGION`、`VS_S3_BUCKET`、
`VS_S3_ACCESS_KEY_ID`、`VS_S3_SECRET_ACCESS_KEY`配置发布目录：

```powershell
cargo build --locked -p vs-service --example publish_s3_catalog
./target/debug/examples/publish_s3_catalog.exe <目录JSON路径>
```

发布器完整读取并验证目录所列媒体，先以散列键提交目录，最后不可覆盖创建版本记录。
同版本同内容可重试，异内容竞争返回冲突；提交响应丢失时只读核对，无法确认则显式返回
`release_may_have_committed`。目录至多8MiB、版本记录至多4096字节，默认最多两个本地操作，
单次存储等待30秒。默认64KiB读块不等于总内存上限，发布重试完整校验有带宽代价。

运行实例显式固定远端版本：

```powershell
$env:VS_PUBLICATION_BACKEND = 's3'
$env:VS_CATALOG_RELEASE = '<已发布版本>'
$env:VS_STORAGE = 's3'
cargo run --locked -p vs-service
```

使用相同`VS_S3_*`配置，并设置已有`VS_SERVICE_TOKEN`和`VS_ROLE`。
此模式不能同时设置`VS_PUBLICATION_ROOT`或`VS_CATALOG`；
`media`和`all`角色要求同一S3存储，`api`与`profile`只加载目录。
运行时应使用只读凭证，写权限留给离线发布者。

固定版本入口不自动跟随新版本；没有`latest`或自动切流。目录可加载不证明Qdrant索引
已经就绪，启用Qdrant时还须通过上述启动校验；`catalog`和`grouped`继续独立运行。来源、此前133项全工作区回归、四端点真实RustFS
验证与剩余边界见[远端目录与固定版本发布](../vedioServerRefer/远端目录与固定版本发布.md)。

## 条件部署选择

API可用一个部署记录绑定固定目录、画像权威入口和召回配置。离线激活器先验证依赖，
写入不可覆盖记录，再用前一ETag条件更新选择。回退创建新代次，陈旧发布者不能按旧ETag
覆盖新选择；超时或响应丢失需只读核对，不能自动改用新前版本重试。

```powershell
cargo build --locked -p vs-service --bins --example activate_deployment
./target/debug/examples/activate_deployment.exe api none activate-001 <目标JSON文件>
```

目标格式、凭证配置和后续更新命令见
[部署选择与条件版本交接](../vedioServerRefer/部署选择与条件版本交接.md)。
目标记录不含密钥，写入方继续使用`VS_S3_*`、`VS_PROFILE_AUTHORITY_TOKEN`和可选
`VS_QDRANT_API_KEY`。读取方使用只读S3凭证，API入口为：

```text
VS_ROLE=api
VS_DEPLOYMENT_CHANNEL=api
VS_DEPLOYMENT_SHA256=<激活收据SHA256>
```

同时提供`VS_SERVICE_TOKEN`、画像令牌与所需索引令牌；禁止重复指定独立目录、画像地址或
召回配置。监听前验证依赖并复查当前选择，`/readyz`报告实例实际加载的部署代次和指纹。
运行中保持固定选择，Feed不增加控制面读取；外部路由仍须按期望指纹选择副本。
部署选择不等于画像单写者日志迁移、生产路由切换、旧实例撤销或跨服务事务。

## 画像历史水位

新部署会验证画像日志的已提交历史前缀，并把`profile_checkpoint`写入部署记录。
API绑定该水位后，事件和投影请求携带短历史凭据；同地址替换为空历史或未注册凭据时
拒绝使用。正常Feed不增加独立历史RPC，首次旧前缀核对才扫描日志。

受保护的`POST /internal/v1/profile/history`接收`{"minimum":null}`或指定水位，
返回当前`checkpoint`和已验证前缀的`guard`。每日志最多缓存32条凭据，进程重启后重新核对。
水位包含规则版本、记录数、字节数与原始日志SHA256，证明内容前缀而非唯一权威身份。

停写转移：

```powershell
cargo build --locked -p vs-service --example handoff_profile_log
./target/debug/examples/handoff_profile_log.exe <已停写源日志> <不存在的目标日志> <目录SHA256>
```

工具先用独占锁验证并封存源，再不可覆盖创建副本。源`*.sealed.json`需保留，
目标失败后源仍封存；只能向同一缺失目标继续转移。部署修改画像地址时必须提供
`profile_minimum`，使用工具回执中的最终`checkpoint`，不能拿初次部署的旧水位替代。

这是受信文件路径的停写交接，存在服务间断；未实现跨机租约、实时撤权或自动路由。
旧部署无水位时仍可读取，重新激活后才获得历史保护；旧二进制不能读取新字段，升级需协调。
流程、成本和证据见[画像历史水位与停写交接](../vedioServerRefer/画像历史水位与停写交接.md)。

## 浏览器播放实验

`cargo build --locked -p vs-service --example playback_lab`构建本机隔离入口。
它复用既有HLS发布和Rust媒体路由，浏览器使用固定hls.js，提供实际出帧、XHR正文、
暂停/恢复/停止与导出观测。内部服务令牌不交给浏览器。
启动、限速验收和Xiu直播准入探针见[labs/playback](labs/playback/README.md)；
该入口不作为公网服务，也未把客户端观测接入训练标签。
可选`vs-playback-web`通过固定wasm-bindgen绑定共享Rust时间滞回，
浏览器以实际连续缓冲控制hls.js取片，不增加逐片决策RPC。
该选项单列模块下载和初始化成本，默认不启用；不含完整`PlayerAdapter`或Android/iOS绑定。

## 三端共同点播授权

可选签发接口`POST /internal/v1/playback/grants`仅由可信用户网关调用，
使用现有内部服务鉴权及主体授权投影；三端读取
`GET/HEAD /v1/playback/{token}/{sha256}/{filename}`不需要内部服务密钥。
HLS主子清单、初始化段和分片均受限，不借读取子清单延长有效期。

启用需成对设置`VS_PLAYBACK_SIGNING_KEY`和`VS_PLAYBACK_AUDIENCE`；
前者为32字节随机密钥的Base64URL无填充编码，不能复用服务令牌。
API/media副本需要相同目录、密钥和受众。默认关闭，不保存逐播放会话表。
响应契约见[contracts/playback-grant-v1.schema.json](contracts/playback-grant-v1.schema.json)，
配置、成本及拒绝边界见[三端播放授权与清单签名集成](../vedioServerRefer/三端播放授权与清单签名集成.md)。
真实用户登录、即时撤回、直播授权及Android/iOS原生接入尚未完成。

## 三端消费输入

feedback角色新增`POST /internal/v1/consumption/events`，由可信用户网关转交
Android、iOS、Web的类型化消费声明，复用已有Iggy配置、写入预算和持久化确认。
协议为[client-consumption-v1.schema.json](contracts/client-consumption-v1.schema.json)。
首帧、可见性、进度和明确偏好分开，文章/服务可使用非媒体呈现来源，
未知计数保持`null`，不自动更新画像或生成负样本。

`snapshot_feedback`读取新旧两类记录并投影为旧学习事件，新增回执保留来源载荷指纹。
先升级快照工具再调用新入口；原生SDK、用户认证和在线跨批连续性仍待完成。
协议、证据及代价见[三端消费事件与跨域推荐输入](../vedioServerRefer/三端消费事件与跨域推荐输入.md)。

有序消费投影使用`gateway-learning-events-v2`，
带来源顺序的训练使用`rank-training-v2`，同一实例代次中的同秒反馈可校验并保留原UTC秒；
没有顺序的v1仍要求严格先后秒。原生请求结构与推理模型格式不变。
顺序结构见[interaction-order-v1.schema.json](contracts/interaction-order-v1.schema.json)。
先升级支持v1/v2的接收、快照、导出、训练和回放工具，再启用v2投影；
原始消费记录可按固定偏移重读，无须改写历史。
边界见[消费顺序保留与同秒反馈](../vedioServerRefer/消费顺序保留与同秒反馈.md)。

设置`VS_CONSUMPTION_ACCESS_CONFIG`后，feedback提供
`POST /v1/client/consumption/events`，正文仍为原消费批次。
三端持消费专用短期JWT，通过Ed25519、公钥kid、issuer/audience、时间和交互绑定校验后，
复用原Iggy链路；该凭据不能访问内部服务接口。
依赖固定为jsonwebtoken 11.1.0，复用已有ring，签发端与原生采集仍需接入。
配置、协议及成本见[消费凭据根选型与三端入口集成](../vedioServerRefer/消费凭据根选型与三端入口集成.md)。

反馈配置可选 `fallback_endpoints`。启动或受保护的 `/readyz` 在一个总预算内探测固定地址，
完整核验主题后才选择后续写入入口；HTTP错误、损坏正文和资源重建不绕行。
反馈POST始终单次发送，unknown不重发。运行中切换依赖外部就绪探测，
没有新增定时器；多地址快照先核验、再固定单入口读取。
实际边界与证据见[反馈入口切换与未知写入边界](../vedioServerRefer/反馈入口切换与未知写入边界.md)。

## WebRTC单房间实验

独立crate `vs-live`固定复用str0m 0.25.0，已验证真实Chrome一发布两订阅的VP8视频、
关闭一路后的隔离以及停止回收；它不包含在`VS_ROLE=all`中。
只监听回环，自定义JSON SDP并非WHIP/WHEP，不接生产房间权限、音频或物理集群。
Windows使用CNG，Linux依赖与运行另验；当前没有三低性能排名。
构建与复跑见[labs/webrtc](labs/webrtc/README.md)，
反例与证据见[Rust实时SFU根与互操作集成](../vedioServerRefer/Rust实时SFU根与互操作集成.md)。

## 本机工作位置

当前工作树为`O:\CodexWorkspaces\superServe-video-b4be`。
终端先执行`. 'D:\CodexVideoTools\enter.ps1'`，
将构建和临时文件固定到`O:\CodexVideoBuild`，工具缓存位于D盘。
旧C盘路径仅保留兼容连接，不再存放本项目实际数据。
清单与验证见[工作目录与缓存迁移](../vedioServerRefer/工作目录与缓存迁移.md)。
