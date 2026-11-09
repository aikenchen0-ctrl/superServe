# 上游复用记录

2026-11-09完成当前Rust服务的Linux实际部署验收：
复用rust-cross/cargo-zigbuild v0.23.4官方Windows发布制品，
压缩包SHA256为`cd1226091f9f99ac7b46fb413968fb0b46edbe3ea961817d31b968352de4d4a6`；
Zig0.15.2官方包SHA256为
`3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c`。
Rust1.96 Linux标准库校验后解包到O盘独立sysroot，
构建`x86_64-unknown-linux-gnu.2.36`，未修改业务Cargo.lock。
上述均为隔离构建工具，不进入在线服务依赖；
未将这些工具或其源码直接并入产品，实际再分发须随工具自带许可处理。
官方用法来自`rust-cross/cargo-zigbuild` v0.23.4 README，
Zig来源为`ziglang.org/download/index.json`和相应0.15.2下载项。
复用Debian13云镜像来宾、现有systemd候选与Rust程序进行两轮实际部署，
并未新增服务管理器、broker或训练框架。
本轮记录见`../vedioServerRefer/problem-space/linux-service-deployment-evaluation.json`；
软件仿真单宿主不构成性能、物理故障域或生产容量证明。

2026-11-09修正实际服务退出结果：继续使用固定Axum
`40d061fdacd468217c7a609bede16357276b6c40`的
`examples/graceful-shutdown/src/main.rs`既有接入，
并调用锁定Tokio 1.54.1的`timeout_at`与`Instant`。
不复制新上游代码、不新增框架或依赖。
新增`vs-service/src/shutdown.rs`为本地阶段编排：共用截止时间，
HTTP错误也排空已受理提交，失败返回主函数错误而不只打印警告。
Axum/Tokio已有许可继续适用；原示例来源与发布包身份不混同。
systemd模板依据官方service/kill手册自行编写，不复制服务管理器实现，
也不声明已通过Linux/systemd实测。
边界见`contracts/service-shutdown-v1.md`及`deploy/systemd/README.md`。

2026-11-09追加真实浏览器消费接线：继续使用既有hls.js 1.7.4供应资源，
核对研究提交`15ded1909feda7a414998ba022d3b88e647592f7`
`src/utils/xhr-loader.ts`的XHR进度和终止路径；研究源码与实际发布资源身份分开。
不复制新的播放器源码，不引入遥测SDK。既有Apache-2.0许可继续适用。
后端实验网关仅新增有限服务器签发实例绑定，转交原Iggy反馈路由；
原始证据和OpenTelemetry来源跨批重建继续复用，无新外部依赖或broker内核修改。
真实Chrome实验的消息服务仍是HTTP协议夹具，不冒充真实Iggy持久性。
调用和边界见`contracts/playback-consumption-persistence-v1.md`。

2026-11-09追加跨批消费重建：稀疏克隆OpenTelemetry Collector Contrib，
固定`b83eb00d069d77f9bd77c6c247dfcdaa3628cdc9`，
从`processor/cumulativetodeltaprocessor/internal/tracking/tracker.go`
局部转写`InitialValueDrop`首点保留和单调整数求差到
`vs-service/src/upstream/cumulative_delta.rs`。
保留Copyright The OpenTelemetry Authors与Apache-2.0完整许可，
本地修改及不适用的上游NOTICE部分说明见`LICENSES/otel-cumulative-NOTICE.txt`。
不引入Go、Collector、直方图、后台状态或新增Cargo外部版本。
事件去重、顺序重建、计数窗口和报告接线是本项目领域适配，
原消费归一化、固定证据读取及Qdrant来源原子发布仍为唯一实现。
Vector动态源码的LRU去重只作机制对照，未复制或依赖，不构成性能排序。
见`contracts/consumption-replay-v1.md`和
`../vedioServerRefer/problem-space/consumption-replay-evaluation.json`。

2026-11-09追加原始反馈证据快照：继续复用Apache Iggy固定提交
`71f29618ba04917fded0ef5cd085c206fef0ee49`的
`core/sdk/src/http/messages.rs`中显式位点、分区、数量及`auto_commit`机制，
并复用既有Rust HTTP适配、消费归一化与Qdrant来源原子发布。
没有复制新的broker内核、升级外部包或引入另一套采集/训练框架；
原Apache-2.0许可与Iggy NOTICE继续适用。
`feedback_evidence.rs`的有限原始载荷封装及训练投影接线为本项目新增实现。
固定官方HTTP源码与本地CRLF版本归一化后相同，分别记录字节摘要，
不把README对照或局部复用当作全网性能最强证明。
详情见`contracts/feedback-evidence-v1.md`和
`../vedioServerRefer/problem-space/feedback-evidence-evaluation.json`。

2026-11-09追加固定时间留出回放：继续复用RecBole
`7b02be5ec80a88310f2d04a27a82adfcbb5dc211`的全局时间机制Rust适配，
以及Recommenders `cc47866b0599721f8544d1cc850a5a1db091acb3`
`merge_ranking_true_pred/recall_at_k/ndcg_at_k`的命中分母与逐查询汇总参考。
原Rust指标和DomainAudit保持唯一实现，不复制pandas或按共同预测用户丢样本。
新增`temporal_replay.rs`仅做固定来源、前窗重现、指定后窗和报告接线；
未知不当负例、不进行因果估计或修改线上策略。完整MIT与来源继续见
`LICENSES/recbole-MIT.txt`、`recbole-NOTICE.txt`和`recommenders-MIT.txt`。
无新增外部依赖；JSON权重两端经过同一原发布/读取链严格比较，不改全局解析特性。

2026-11-08追加受控TURN中继：浅克隆`mycrl/turn-rs`
`e7d7642eecd7e97e2dcfafc9c5a4d5945d14e29f`和`ystreet/turn-proto`
`d8d127ab1e37aef14f95a9f6b529073c31ee04a5`用于机制比较。
前者固定源码限定自身external接口IP及虚拟端口，不直接复制为独立SFU的通用中继。
当前选用已发布`turn-server-proto/turn-types 0.7.3`，测试复用`turn-client-proto 0.7.3`，
其余适配为有界Tokio UDP驱动、固定完整对端、到期及代次回收。

真实UDP回归发现server 0.7.3的Binding回复误发监听地址。
直接复制该发布crate到`vendor/turn-server-proto`，固定发布VCS
`52209bfadde1bf7be7423cdf53654c5d68e59102`，唯一源码行改为发给请求者；
不改D盘缓存、不在外层伪造回应。协议解析、认证、权限、nonce及channel内核仍是原实现。
MIT全文、作者版权与改动范围见`LICENSES/turn-proto-MIT.txt`、
`LICENSES/turn-proto-NOTICE.txt`及供应目录`PATCHES.md`。
新增19个外部名称/版本和本地`vs-turn`，旧依赖版本未替换；该包仅进入协调测试依赖，
不进入`vs-live`正常依赖。强制relay浏览器和默认直连分别留证。
本轮不证明公网NAT、TURN TCP/TLS、真机、独立TURN进程媒体吞吐或三低收益；
详情见`../vedioServerRefer/problem-space/turn-integration-evaluation.json`。

2026-11-08追加终端HTTPS信令及私网媒体：回读固定Axum
`40d061fdacd468217c7a609bede16357276b6c40`的
`examples/low-level-rustls/src/main.rs`，复用已有有界接入改编，
显式增加服务端TLS入口而不降低原mTLS接口的验证要求。
MIT版权及完整许可继续保留于`LICENSES/axum-tls-MIT.txt`。
实际候选、ICE、DTLS/SRTP和H.264/Opus转发继续调用固定str0m 0.25.0，
不复制或改写协议、转码、数据库或共识内核。
精确来源、终端路由、JWT接线、私网对端收发策略及CLI实验为本项目适配。
没有新增外部Cargo包版本或整仓克隆。RFC9725只作为协议规范阅读，不复制标准正文。
本轮不等同生产证书、原生设备、公网或物理集群，详见
`../vedioServerRefer/problem-space/live-signaling-tls-evaluation.json`。

2026-11-08追加动态TLS媒体登记：回读固定Danube
`10950acb975dcf5bfe8678311ccfd7c56db52460`的
`danube-broker/src/danube_service/broker_register.rs`登记地址、元数据与安全方案字段；
仅迁移职责分离机制，不复制其TTL、后台续租、重试或所有权推断。
沿用原OpenRaft/redb、已有Axum/Rustls接入改编及`vs-tls`固定目标客户端。
原Danube Apache-2.0、Axum MIT等许可和来源记录保持，没有新增克隆或外部包版本。
在线核对reqwest官方`ClientBuilder::resolve`实现，实际请求名称和端口均来自固定目录，
而非任意登记URL；不使用DNS失败后的其他解析或HTTP回退。
新传输标记、预授权节点目录、策略摘要和恢复校验均为本项目适配。
静态与动态真实进程实验共用原辅助函数，分别保留回执。
本轮边界见`../vedioServerRefer/problem-space/media-registry-mtls-evaluation.json`。

2026-11-08追加同代次增量ICE：回读已固定
`8xFF/atm0s-media-server@0507f5eddc5b67bbf5c59700aae3be451adcdad5`的
`bin/src/http/api_media/whip.rs`、`whep.rs`、`utils/payload_sdp.rs`与
`packages/transport_webrtc/src/transport.rs`，局部迁移
“PATCH片段→媒体线程命令→Candidate::from_sdp_string→Rtc::add_remote_candidate”结构，
没有引入其Poem、RPC、会话ID体系或宽松的任意候选忽略规则。
候选解析与状态修改直接调用`str0m =0.25.0`，源码提交仍为
`5f2183ce7c67117cd1960dfeb11bed11fc188b66`。逐次修改后排出输出，未改ICE/DTLS内核。
完整SDP解析器会要求片段不含的方向及rtpmap，因此片段外层只做有界字段分节；
不称其为上游自带的完整SDP fragment解析器。
沿用`LICENSES/atm0s-MIT.txt`与`LICENSES/str0m-MIT.txt`，新增代码保留版权和修改说明。
本项目增加强ETag/If-Match、既有JWT/撤权/租期/分配边界、规范化键去重、候选预算、
严格外层校验及有界Web队列。按RFC9725只忽略未支持传输和不可解析的合法mDNS候选；
格式错误仍拒绝，替代地址仅作语法校验且不注入Rtc或解析DNS。
没有新Cargo包、上游修改或外部服务。最终证据见
`../vedioServerRefer/problem-space/live-trickle-evaluation.json`。

2026-11-08追加有界列表重排：实际局部改编已有
`qdrant/qdrant@222b2e44ab1c3f17e8246396ead6558e45041df7`的
`lib/shard/src/query/mmr/mod.rs::maximal_marginal_relevance`，
放入`crates/vs-core/src/upstream/mmr.rs`，保留Apache-2.0标识、版权与固定来源。
沿用`LICENSES/qdrant-Apache-2.0.txt`，与该固定源码LICENSE的SHA256一致；
该提交根目录无NOTICE。没有新增克隆、运行包或向量数据库依赖。
保留“首项最高相关、后续相关性减最大冗余”的贪心结构；
改为索引/回调、确定性同分规则和增量最大相似度，未复制临时向量存储、矩阵、
Qdrant传输/分片层或其评分语义。标签二值余弦、位置相关性、空标签保守处理、
50候选预算、策略接口和v2决策记录均为本项目适配，不宣称等同原生向量MMR。
原分数不改写；标签不同不代表用户满意或领域公平。来源摘要、退化反例和最终验证见
`../vedioServerRefer/problem-space/slate-reuse-evaluation.json`。

2026-11-08追加Iggy消息键探针v2：固定Apache Iggy
`91e0206367aad2d30259f7d45203832b08ae84e7`，局部改编
`core/common/src/http/messages/poll_messages.rs`、
`core/common/src/types/message/polled_messages.rs`和`message_header.rs`的JSON字段，
并复用既有`feedback_log.rs`固定offset、`auto_commit=false`快照方式。
新增有界分页、正文摘要核对、回环限制与不重试写入；未复制SDK传输器、VSR、日志或存储算法。
Apache-2.0及NOTICE原文继续保留于`LICENSES/iggy-Apache-2.0.txt`和`LICENSES/iggy-NOTICE.txt`。
没有新增Cargo包或更改锁文件；11项本地/HTTP夹具测试不是Iggy服务或集群收据。
本轮SDK只读核验发现过期reader generation的`commit()`可为成功空操作；
不把此语义解释为外部画像投影已具备旧写者隔离。证据见
`../vedioServerRefer/problem-space/iggy-profile-readback-evaluation.json`。

2026-11-08追加跨领域反馈审计：回读固定
`recommenders-team/recommenders@cc47866b0599721f8544d1cc850a5a1db091acb3`
的`recommenders/evaluation/python_evaluation.py`中
`merge_ranking_true_pred`、`recall_at_k`命中/相关分母机制与分组平均。
第一方Rust仅做有界计数，保留零命中与无标签决策；未复制pandas模块、增加包
或按“有共同预测的用户”剔除回放对象。未标注候选继续为未知，不训练、不调整在线策略。
MIT全文见`LICENSES/recommenders-MIT.txt`，固定来源和失效反例见
`../vedioServerRefer/problem-space/domain-feedback-audit-evaluation.json`。

2026-11-08追加跨领域反馈审计：回读固定
`recommenders-team/recommenders@cc47866b0599721f8544d1cc850a5a1db091acb3`
的`recommenders/evaluation/python_evaluation.py`中
`merge_ranking_true_pred`、`recall_at_k`命中/相关分母机制与分组平均。
迁移为第一方Rust有界计数，完整保留零命中领域和未标注决策，不复制pandas/Python实现，
没有使用该项目按共同用户筛除样本的分析流、没有新增包。
评估基于明确曝光/Like/Dislike，未知不是负例；不做IPS/因果推断，不改变FTRL训练或在线策略。
MIT原文位于`LICENSES/recommenders-MIT.txt`，官方固定源码和许可证快照、
集成反例见`../vedioServerRefer/problem-space/domain-feedback-audit-evaluation.json`。

2026-11-08追加维护运维客户端：参考固定OpenRaft 0.9.25
`databendlabs/openraft@8815cdba2826f74e848acef361ad03f93bb1c3f8`
官方`raft-kv-memstore/src/client.rs`和`network/api.rs`中独立HTTP客户端、
权威读取及写结果处理边界；沿用原reqwest依赖，不复制完整Raft客户端或新增框架。
`media-admin`复用同一协调协议，新增单POST、完整operation读回、
同锁预览、有限响应/退出码和不含secret的收据。
重定向/HTTP自动重试关闭；unknown不重发。沿用`LICENSES/openraft-MIT.txt`许可选择，
固定源码快照另保留上游`LICENSE-MIT`与`LICENSE-APACHE`。
固定源码与故障证据见`../vedioServerRefer/problem-space/media-admin-evaluation.json`。

2026-11-08追加节点停止接单：回读固定`danube-messaging/danube`
提交`10950acb975dcf5bfe8678311ccfd7c56db52460`的
`danube-broker/src/admin/brokers_admin.rs`与`danube_service/broker_watcher.rs`。
迁移“先标记draining、逐项卸载、清空后完成”的机制；没有复制完整broker、元数据服务、
自动迁移器或另写分布式租约。Apache-2.0原许可继续保留于`LICENSES/danube-Apache-2.0.txt`。
实际状态转换仍由原OpenRaft 0.9.25和redb 2.6.4执行，实际媒体排空仍用原str0m线程和控制回执，
无新依赖、共识/数据库/媒体内核修改或逐帧协调RPC。
新增接单布尔状态、CAS/启动身份、恢复/幂等/持久化、显式策略门控及浏览器闭环为本项目适配。
固定快照、初次范围断言反例及实际验证见
`../vedioServerRefer/problem-space/media-node-draining-evaluation.json`。

2026-11-08追加内置工作器复用：回读hls.js固定发布提交
`142fcab1fd0de99beafb0e1b07102ec674a9ddf9`的
`src/demux/inject-worker.ts`、`transmuxer-interface.ts`和`src/config.ts`，
公开`workerPath=null`复用同一主库的Blob工作器、原引用计数与销毁。
没有复制工作器内核、另写线程池或增加包；原Apache许可和发布指纹仍保留于
`labs/playback/vendor/`。新增Rust显式配置、静态响应计量及浏览器生命周期探针为本项目适配。
两种素材、两档模拟网络下实际后台初始化和终止均验证；
父页面CDP工作器正文缺失保留未知，与服务静态响应预算分别记录，不误作线路收益。
完整机制、首次计量失败及选型边界见
`../vedioServerRefer/problem-space/embedded-worker-evaluation.json`。

2026-11-08追加无屏障播放对照：继续使用已固定hls.js 1.7.4公开渐进加载、
原sheathe封装和Rust媒体链，没有新增依赖或改写播放器内核。
新增CDP计量、同媒体位置轨迹、PowerShell进程快照和按轮次配对汇总。
网络模拟及性能接口参考`ChromeDevTools/devtools-protocol`固定提交
`b0d96c6cdf39e5583e67a3762b2815a33154455b`的`json/browser_protocol.json`，
仅阅读并保留文档快照，原BSD条款一并保存在本轮证据`references/LICENSE`中。
协议master不等于本机Chrome实现；弃用的网络模拟命令仍在本机实测执行以保持方法一致。
未将主渲染器TaskDuration当完整CPU、V8堆当RSS、CDP正文当线路字节，
没有复制新运行时或向生产消费标签注入这些合成轨迹。
结果与初始中文说明编码反例见
`../vedioServerRefer/problem-space/natural-playback-evaluation.json`。

2026-11-07追加HLS片内封装：继续复用已固定`sheathe-mp4/core/hls =0.6.1`，
参考提交`vbasky/sheathe@540f87cf55bc5243854efce6e8257a89f7ad463d`。
回读`crates/sheathe-mp4/src/fragmenter.rs`、`segment.rs`及`crates/sheathe-core/src/sample.rs`，
调用原`fragment`、`SegmentPolicy`及`write_media_segment`生成多个片内`moof/mdat`。
没有复制或重写编码器、样本表或媒体写入内核，没有新增包或改锁。
本项目保留原外部关键帧边界、去除片内sidx的固定SAP声明、添加序号与预算及发布收据；
这些为适配逻辑，不冒称上游现成完整LL-HLS平台。
MIT许可仍保留在`LICENSES/sheathe-MIT.txt`，固定源码快照、独立解码与反例见
`../vedioServerRefer/problem-space/hls-chunks-evaluation.json`。

2026-11-07追加缓存到首帧联合对照：继续使用原样固定的hls.js 1.7.4发布物，
固定提交`142fcab1fd0de99beafb0e1b07102ec674a9ddf9`。
从该提交导出并阅读`src/config.ts`、`src/utils/fetch-loader.ts`、
`src/loader/fragment-loader.ts`、`src/demux/mp4demuxer.ts`及
`src/controller/base-stream-controller.ts`；没有以本地克隆当前HEAD替代已发布固定版本。
实际仅调用公开`progressive`配置与原有事件，没有复制或修改播放器内核，没有新增Cargo/npm包。
MIT/Apache等许可仍按各现有依赖记录，hls.js原有Apache许可及版权保留于
`labs/playback/vendor/`；新探针、屏障源和计量为第一方实验适配。
固定来源与反例见`../vedioServerRefer/problem-space/cache-playback-evaluation.json`。

2026-11-07追加请求驱动流式填充：克隆`tokio-rs/async-stream@v0.3.6`，
固定提交`b0b2f22df8e87b7fed7b2fa234509797adbff7db`，
阅读`async-stream/README.md`、`src/lib.rs`、`src/async_stream.rs`和`src/yielder.rs`。
实际依赖`async-stream =0.3.6`及其同版本宏实现；使用公开`stream!`，
没有复制或修改生成器内部实现。原MIT版权和许可保留于`LICENSES/async-stream-MIT.txt`。
它让响应流内部跨轮询持有借用型quick-cache守卫，无需自行构造自引用对象或任务通道。
库内部有unsafe，第一方继续禁止unsafe；不能将“全Rust”解释成无第三方unsafe。
块键、前缀切片、末字节保留、预算与错误计数为本项目适配，
不是上游已有媒体缓存功能。没有将上游异步流示例称作完整缓存根。

本轮另回读已固定RustFS的`crates/ecstore/src/object_api/body_cache_hook.rs`、
`crates/object-data-cache/src/cache.rs`和`rustfs/src/app/object/get.rs`：
完整正文缓存及后台tee写回分别有不同边界；其后台排空不直接用于当前随请求取消的缓存。
Foyer仍保留为混合缓存对照，没有新增整套存储平台依赖。
来源、复用边界和实验反例见
`../vedioServerRefer/problem-space/media-progressive-cache-evaluation.json`。

2026-11-07追加媒体块键适配：继续使用已锁定`quick_cache 0.7.0`，
复用原`arthurprs/quick-cache@99809ceaeb8b494a5425054711b7bb02fceb79ee`的
加权条目和异步加载守卫调用，以及锁定`bytes 1.12.1`切片。
没有复制缓存内核、另写单飞协调或增加Cargo包；块范围映射、客户端切片、
额外范围计量和策略选择为本项目适配。
MIT原文仍保留于`LICENSES/quick-cache-MIT.txt`，
来源和冷读8倍放大反例见`../vedioServerRefer/problem-space/media-block-cache-evaluation.json`。

2026-11-07追加本地块上界机制参考：`quickwit-oss/tantivy`的`0.25.0`标签，
固定提交`b4139bc3536ac7217995633cbd469a4bf2a23fc3`，
回读`src/query/boolean_query/block_wand.rs`。
没有复制完整Block-WAND、倒排引擎或新增运行时依赖；
块端点上界、负系数、零值、授权及完整排序键为本地六维模型适配，
继续复用既有Qdrant派生Top-K与紧凑分组。
原始MIT许可证保留于`LICENSES/tantivy-MIT.txt`，
准确复用范围见`LICENSES/tantivy-blockmax-NOTICE.md`。

2026-11-07追加模型召回响应裁剪：复用同一Qdrant固定提交的`with_payload=false`
和返回点ID，保留原UUID派生规则与完整读回；不改上游内核或索引表示。
接口依据`lib/api/src/rest/schema.rs`及`lib/segment/src/types.rs`，
本地映射、授权复检和配对报告为项目适配，无新Cargo依赖。
完整载荷与点ID模式均显式保留；本地键存储增加和原有同分遗漏也记录在
`../vedioServerRefer/problem-space/model-recall-compact-evaluation.json`。

2026-11-07追加模型感知召回实验：继续使用已固定Qdrant 1.20.0官方二进制，
回读同提交`lib/sparse/src/index/search_context.rs`的点积及负查询权重剪枝限制。
`model_recall`为本项目的线性特征投影，`qdrant_model_recall`复用既有HTTP客户端调用索引；
未复制或修改上游存储、检索和分布式内核，未新增Cargo包。
候选边界仍有f32精度和同分截断损失，不能视为精确模型结果的替代。
固定来源、两次Windows长路径反例和真实矩阵见
`../vedioServerRefer/problem-space/model-aware-recall-evaluation.json`。

2026-11-07追加三节点反馈故障实验：回读同一Iggy固定提交的
`core/integration/src/harness/orchestrator/builder.rs`、`core/integration/tests/cluster/crash_durability.rs`、
`core/server/src/http/forward.rs`及视图/配置代码，适配名册环境变量和故障验证顺序。
新脚本`labs/iggy/run-cluster-linux.sh`和既有Rust实验入口复用已构建二进制；
没有复制共识、重写消息日志或新增业务依赖。
两轮通过与WSL挂载盘退出阻塞分别记录于`../vedioServerRefer/Iggy三节点故障与恢复.md`，
来源指纹见`problem-space/iggy-cluster-evaluation.json`。不宣称生产集群或性能准入。

2026-11-07追加共享反馈适配：从已固定Apache Iggy提交的HTTP消息客户端、主题元数据和消息JSON结构改编
`crates/vs-service/src/feedback_log.rs`；增加严格持久化确认、固定坐标、在途预算、
不确定结果、固定偏移快照、启动前主题策略预检及既有归档转换。没有复制或修改Iggy共识、存储和io_uring内核。
Apache-2.0和NOTICE原文分别保留于`LICENSES/iggy-Apache-2.0.txt`和`LICENSES/iggy-NOTICE.txt`。
只将锁文件已有`base64 0.22.1`提升为直接依赖，未增加包或改变版本；锁文件的vs-service
依赖列表新增该项，不能声明锁文件字节不变。
来源、协议夹具及真实后端未验边界见`../vedioServerRefer/共享反馈入口与Iggy适配.md`。
同日从该提交构建Linux服务端，Rust 1.98、`--no-default-features`、系统分配器；
`labs/iggy`及Rust实验入口接通真实单节点确认、权限和进程重启验证。
主题DTO改编来源补充`core/common/src/types/topic/mod.rs`和`types/options/mod.rs`，
权限边界参考`types/permissions/permissions_global.rs`；未复制服务端内核。
一次真实实验发现流/主题/分区允许零坐标，已修正本地适配而未修改上游。

2026-11-06统一证据回放继续复用既有CQRS派生信封解析、Qdrant派生不可覆盖文件发布、
本地指标和三条排序路径；训练导出与回放共用来源关联，无新Cargo依赖。
VW官方上下文老虎机教程用于核对动作/反馈/选择概率边界，
OPA官方决策日志文档用于核对决策ID与敏感输入处理；未复制二者代码或引入其运行时。
网页正文快照、散列及实际使用范围见`../vedioServerRefer/固定来源统一模型回放.md`。

核查日期：2026-11-05。克隆在仓库根目录 `.artifacts/upstream/`，该目录不提交。
2026-11-06 追加：已从固定 Qdrant 源码复制并改编两个局部 Top-K 选择器，详见下文。
同日新增MP4容器处理复用，版本、源码和独立验证见文末。

| 项目 | 固定参考提交 | 使用方式 | 许可证 |
| --- | --- | --- | --- |
| tokio-rs/axum | `40d061fdacd468217c7a609bede16357276b6c40` | 改编 `examples/graceful-shutdown/src/main.rs` 为 `vs-service/src/main.rs`；依赖发布版 `0.8.9` | MIT，原文保留于 `LICENSES/axum-MIT.txt` |
| apache/opendal | `532050ac3c099dd8591cde652a8ed1aaf03ba418` | 阅读 Reader、Fs、S3 的实现；通过发布版 `0.59.5` 调用，没有复制其源文件 | Apache-2.0，依赖包中保留原 LICENSE/NOTICE |
| qdrant/qdrant | `222b2e44ab1c3f17e8246396ead6558e45041df7` | 固定 1.20.0 REST 召回；另复制改编 `top_k.rs` 的2K压缩路径与 `fixed_length_priority_queue.rs` 的有界堆，供本地组头选择 | Apache-2.0，原文保留于 `LICENSES/qdrant-Apache-2.0.txt` |
| rustfs/rustfs | `46337942d55f3a8e6a97b147ca98d9ea8115555d`（1.0.4） | 已克隆；改编 `.docker/compose/docker-compose.cluster.local-build.yml` 为 `labs/rustfs/compose.yaml`；官方 Linux 二进制的 WSL 四进程基础合约通过 | Apache-2.0，原文保留于 `LICENSES/rustfs-Apache-2.0.txt` |
| deuxfleurs-org/garage | `586726edb0170bb46f604e84fba09e5659610649`（v2.5.0） | 已克隆并核查设计、配置、限制及 Range 实现；副本型存储对照，未复制实现或运行 | AGPLv3，原仓库 LICENSE 保留 |
| serverlesstechnology/cqrs | `37c1ab09b5de20ae47aaf0b72a0775b92a45a0cd` | 从`src/event.rs`的EventEnvelope改编类型化事件信封，供画像历史事实落盘 | Apache-2.0；`LICENSES/cqrs-Apache-2.0.txt`及`cqrs-Apache-2.0-notice.txt`保留全文和版权声明 |
| foyer-rs/foyer | `0fb762837b38a50681eff9c37c5f1f8b1893af8b` | 已克隆；阅读S3-FIFO、SIEVE与混合缓存边界，未复制代码或加入依赖 | Apache-2.0，原仓库LICENSE保留 |
| arthurprs/quick-cache | `99809ceaeb8b494a5425054711b7bb02fceb79ee` | 改编README的加权示例、调用异步加载守卫；内核使用`quick_cache =0.7.0`，默认特性关闭，供可选精确Range缓存 | MIT，原文保留于`LICENSES/quick-cache-MIT.txt` |
| apache/arrow-rs-object-store | `c216edef0ac3d0d39da5bcdfeed3dcd034e26597` | 已克隆，阅读`MultipartUpload`、`WriteMultipart`和`PutMultipartOptions`；仅交叉核对，未加依赖或复制模块 | MIT/Apache-2.0；原仓库LICENSE.txt及NOTICE.txt保留 |
| privacyresearchgroup/mp4san | `ccc2bec881a730981886b144a9660b303126c6f3` | 已克隆；从官方CLI改编输出流程到`vs-service/src/video.rs`，容器内核使用发布包`=0.5.4` | MIT；原文保留于`LICENSES/mp4san-MIT.txt` |
| alfg/mp4-rust | `35560e94f5e871a2b2d88bfe964013b39af131e8` | 已克隆；读取README、writer和许可证作通用MP4读写对照，未复制或引入运行依赖 | MIT；原仓库LICENSE保留 |

Axum 的改动包括：角色配置、目录校验、服务鉴权、请求上限和 30 秒排空期限。
OpenDAL 提供存储访问层，并非分布式存储服务器；RustFS 优先进入容量型媒体实验，Garage 保留为对照，生产选型仍需容量、故障与扩容实测。
RustFS 配置改动：从四节点十六盘缩减为四节点四盘；固定版本标签和 EC:2；仅回环端口；凭证由实验环境提供；关闭控制台、FTPS、WebDAV；保留数据卷并限制日志轮转。没有修改其存储内核。镜像摘要尚未核验，版本标签不能当作源码构建对应关系的证明。
后续 WSL 实验使用官方 `rustfs-linux-x86_64-musl-v1.0.4.zip`，SHA256 为 `4924ad4b699b9f59943051efedae2d1eb6d4cac503a1b0384c4b25f7c2c31b5c`，与发布方 `SHA256SUMS` 相符；运行时报告提交与表中一致。`run-contract.sh` 和 Rust 合约探针为本项目新编写的实验工具，复用现有 OpenDAL、Axum 和系统 curl，不复制上游存储实现。
上游参考提交用于追溯，发布依赖与传递依赖以 `Cargo.lock` 为准；不假定上游 HEAD 与发布包字节相同。
Qdrant 2026-11-06 单机合约使用官方 Windows 发布二进制，自报版本 1.20.0，服务日志中的构建
提交为 222b2e44。ZIP 的本地 SHA-256 为
`6d13553584fd0411f00637519e293331ff0aa1fb79bd9e30db45839bb75de2be`，二进制为
`3e86f79bd516097586afb5ceacf6b843bc9e32b8e4b311d94b63a3cc11432a40`；
未核对发布方独立签名或散列清单。详见 `../vedioServerRefer/Qdrant召回集成.md`。
实际遇到的差异：OpenDAL 0.59.5 发布包的无提供器模式不自动安装 HTTP 传输器，而参考 HEAD 已覆盖此特性。当前适配显式调用其传输器初始化函数，并用真实本地 HTTP 协议测试验证。

## Qdrant 局部 Top-K 复用

源码基准均为上表固定提交，未复制或修改 Qdrant 存储、网络和分布式内核。原始来源：

| 上游路径 | 原始 SHA-256 | 本地路径 |
| --- | --- | --- |
| `lib/common/common/src/top_k.rs` | `0686779eea8dbd31535de7590141053461b3f194dbca2839b744472eb2134fc2` | `crates/vs-core/src/upstream/buffered_top_k.rs` |
| `lib/common/common/src/fixed_length_priority_queue.rs` | `8158b3d2ecf6793ccff6360ff04ecb427b8518761179b0d18301910a249e8012` | `crates/vs-core/src/upstream/bounded_heap.rs` |

改动：移除无关序列化、迭代接口及 `bytemuck`；使用安全标准库转换；以完整 `Ord` 键替代
仅分数门槛，保留亲和度、先验、ID 的同分规则；内部固定候选上限非零；缓冲模块只保留适合
K=128 的2K压缩路径，不复制小K排序分支。本地模块含 SPDX、来源提交和改动声明。

Qdrant 源码将压缩算法关联到 Quickwit 的 `top-k-complexity` 文章；本项目直接复制的代码来源
是 Qdrant 固定提交，不把文章或其他仓库列为已复制实现。根目录未发现额外 NOTICE 文件。
实际候选对照、最终选择和保真边界记录在 `../vedioServerRefer/上游TopK复用评估.md`。

2026-11-06续用：`crates/vs-core/src/model_top_k.rs`将相同选择器用于学习评分，
以模型f64分数、先验、ID构成完整排序键，K取合法请求上限1至50。
该轮原移植模块没有改动，当时SHA256为
`307345c8cedd1d6477026f6b3c05b1bf40c00f88aaddfa43857c7587805a2257`；
沿用Apache-2.0原文，无新依赖、网络内核或许可变化。
该路径仍遍历并评分全部合法候选，仅限制选择器暂存与最终排序；
两轮成本和负面结果见`../vedioServerRefer/模型精确TopK与召回边界.md`。

后续模型分组剪枝继续复用相同固定提交的选择器，仅新增只读`threshold()`访问器，
本地缓冲模块当前SHA256为
`01ee81da998fd453b011927554b46f8f631d7e47c1bb13b6150f4d6c44d76c6c`。
另阅读同提交`lib/sparse/src/index/search_context.rs`的门槛与上界剪枝，
其原始SHA256为`97386c8ad8ffe63886cfbe97d8715b1ef213dc705f02c6ea7c44b828703d6e1e`。
该稀疏实现对负查询权重禁用剪枝；本轮没有复制或修改其稀疏索引内核。
`model_pruned.rs`的双端点上界、完整授权过滤和严格低于门槛规则是本项目针对六维模型的适配，
不是上游现成支持声明；沿用已有紧凑成员结构，无新Cargo依赖。
成本与来源边界见`../vedioServerRefer/模型分组上界与评分消减.md`。

重新取得参考源码：

```powershell
git clone https://github.com/tokio-rs/axum.git .artifacts/upstream/axum
git -C .artifacts/upstream/axum checkout --detach 40d061fdacd468217c7a609bede16357276b6c40
git clone https://github.com/apache/opendal.git .artifacts/upstream/opendal
git -C .artifacts/upstream/opendal checkout --detach 532050ac3c099dd8591cde652a8ed1aaf03ba418
git clone https://github.com/qdrant/qdrant.git .artifacts/upstream/qdrant
git -C .artifacts/upstream/qdrant checkout --detach 222b2e44ab1c3f17e8246396ead6558e45041df7
git clone --depth 1 --branch 1.0.4 https://github.com/rustfs/rustfs.git .artifacts/upstream/rustfs
git -C .artifacts/upstream/rustfs rev-parse HEAD
git clone --depth 1 --branch v2.5.0 https://github.com/deuxfleurs-org/garage.git .artifacts/upstream/garage
git -C .artifacts/upstream/garage rev-parse HEAD
```

克隆后将 `rev-parse HEAD` 与上表完整提交比较；不把可移动标签当最终校验值。已存在的参考克隆保持原位，不覆盖工作树。

## 事件信封与迁移发布复用

2026-11-06新增的局部模块：

| 来源 | 原始SHA256 | 本地模块 |
| --- | --- | --- |
| cqrs `src/event.rs` | `5d694861ed41ec5ae4a8e767a0b31d5ca540937ad67bb329bb9d26aaec7da9c1` | `crates/vs-service/src/upstream/event_envelope.rs` |
| Qdrant `lib/common/common/src/fs/ops.rs` | `4966b37e8532986af9ed3a7d2fe7e0a2de2b9106e77b1a6bb0fcb1c9207657cd` | `crates/vs-service/src/upstream/atomic_create.rs` |

事件信封改动：移除Aggregate框架约束，载荷和元数据分别类型化，序号使用u64，增加严格
Serde序列化；不复制cqrs-es调度器、数据库适配器或上溯转换器。特征冻结、版本验证、
序号连续性、历史迁移和HTTP边界是本项目适配逻辑。
上游根LICENSE版权声明原样保留，SHA256为
`4e618a5e7435c81a38e290724843d8ebfde3bf00ce5cf67e370d1cbf047fdd04`。

迁移发布模块沿用Qdrant的同目录临时写入、缓冲写与刷新模式；把atomicwrites覆盖发布改为
既有tempfile的`persist_noclobber`，同步文件并在Unix同步目录。不引入atomicwrites、
fs_err或bincode。tempfile从开发依赖提升为运行依赖，锁文件不变。

Foyer仅进入参考克隆，没有把其侵入式队列和内部不安全代码复制到第一方源码。
各子问题当前首选及验证等级见 `../vedioServerRefer/开源根选型与事件版本集成.md`。

## 媒体范围缓存复用

2026-11-06继续：从quick-cache的README加权模式和`src/sync.rs`的异步守卫调用改编
`crates/vs-storage/src/media_cache.rs`，精确范围、加载预算、完整性校验、按需轮询和取消观测
为本项目适配逻辑。没有复制或修改其内部容器、占位者及不安全代码，运行时使用锁定发布包。
关闭默认特性后只引入quick_cache 0.7.0、equivalent 1.0.3及hashbrown 0.17.1三个新包。

固定参考原始SHA256：

| 文件 | 参考克隆散列 |
| --- | --- |
| README.md | `eb5ab78d53fbe048b714a2622e65007fda142d524d97268b40e739c2c5843334` |
| src/sync.rs | `9d241ebd7f07dbe6763f065ada3b62b2115fd608993c064d04654b177f5aa906` |
| src/sync_placeholder.rs | `3a45763636a1bc9f8d398a0de5a6e323807152c775232e050878cbb0d1895ee0` |
| LICENCE.md | `0c5c328c7a38bb7d5a5a5a4774e6454e541b81702123f933341258d842b353f1` |

发布包的`.cargo_vcs_info.json`指向同一提交；上述文件将CRLF正规化为LF后逐一相同。
发布包原始字节散列因行尾不同而不相同；其中`src/sync.rs`为
`b95a52871f13e4e586031a83c22374601d76725bb83a17fc88661521d5683f01`。
锁文件中的发布包校验值为
`403c1a912fec895cafb223201e368234842acb9220aaf08ab042ae89ba5f135c`。

该库自述为修改版Clock-PRO、接近S3-FIFO，不标成Foyer的同一实现，也未做两库同场性能比较。
Foyer继续保留为完整混合缓存对照。范围缓存默认关闭，只缓存公开目录已发布的内容寻址对象，
不缓存用户私有画像；鉴权与HEAD长度检查仍在命中前执行。证据和代偿见
`../vedioServerRefer/媒体范围缓存集成.md`。

## 不可覆盖媒体与目录发布

2026-11-06继续复用既有Qdrant派生`atomic_create`，没有再复制另一份或引入新依赖。
`crates/vs-service/src/publication.rs`是本项目的流式散列、资产验证、内容指纹目录与版本记录适配，
不是Qdrant原生媒体发布功能。固定版本启动和离线CLI在既有Axum/Tokio骨架上接入。

比较源码为OpenDAL固定参考的Fs writer/core及S3 core；本机探针使用锁定的
`opendal-service-fs 0.59.5`，发布包`.cargo_vcs_info.json`指向
`fce9cdefdea7c8e54dfbaf3c88c3b6d5ec68146e`，与参考HEAD分开记录。
实际发布包Fs writer散列为`87663b9be432cf934d638e25eab32cc45023f590dc2e09f5d6fcecde29c38d82`。
隔离探针在该版本复现原子暂存写者依次关闭后覆盖，不据此改变OpenDAL读路径或宣称S3同样失败。

tempfile的`persist_noclobber`只用于同目录完整内容的不可覆盖发布，文档明确它可能留下原临时链接，
不能把发布和暂存清理描述为完全原子事务。源错误清理、并发和本机进程重启通过，不代表断电、
网络文件系统或物理集群恢复已通过。完整来源及收据见`../vedioServerRefer/不可变媒体与目录发布.md`。

## S3分段发布复用

2026-11-06新增`crates/vs-service/src/s3_publication.rs`。复用已锁定OpenDAL的
Writer写入/close/abort、S3条件头与分段调度，新增窄的接纳预算、取消监督、源散列及
清理状态适配。没有复制OpenDAL签名、分段或不安全内核，没有增加包版本。
OpenDAL与其既有HTTP传输器提升为service直接运行依赖，quick-xml用于协议夹具解析，
Tokio显式声明fs/io-util；锁文件因直接依赖关系改变，不能宣称锁文件字节不变。

实际发布包源码散列：

| 文件 | SHA256 |
| --- | --- |
| opendal-core 0.59.5 `src/raw/oio/write/multipart_write.rs` | `e6636136151664c038981a63450c1905bc2d88158e701e9785d37bb6b531fd05` |
| opendal-service-s3 0.59.5 `src/writer.rs` | `582f9ce7d117003eabdcd0d9f3f7ca440f537bef07e4044b1822552d60b0bd25` |

另克隆object_store固定提交，声明版本0.14.2、Rust最低1.85；其`src/upload.rs`
原始散列`2e00d4f7afb529d66598922df12ba1f6eb4c46641b7724e4ef7fa76b0183f8ae`。
该源码同样要求显式abort，并提示异常退出应由存储生命周期清理兜底。
本轮没有运行或性能比较该库，不宣称OpenDAL在所有场景下更强。
来源比较、反例及真实后端收据见`../vedioServerRefer/S3分段发布集成.md`。

## S3目录发布复用

2026-11-06继续从固定OpenDAL `Operator::write_with(...).if_not_exists(true)`示例和
S3条件头实现改编`crates/vs-service/src/s3_catalog.rs`，运行时仍使用已锁定0.59.5。
本项目新增目录/记录协议、逐媒体散列、并发预算和响应丢失核对，不复制签名、存储内核或
不安全代码。复用本地`publication.rs`的目录校验和版本记录，与已有S3媒体发布共用
Operator构造，未增加依赖或改变锁文件。

固定源码对照：

| 来源 | SHA256 |
| --- | --- |
| 参考OpenDAL `core/core/src/types/operator/operator.rs` | `f43b3b247d97afa515ace48205b32c8041320b2e96cc992f68026944e6dc602f` |
| 参考OpenDAL `core/services/s3/src/core.rs` | `64a8b14eab96b3605f48754f514375be96d01cc97676c3445d30992693070c56` |
| 发布包opendal-core 0.59.5 `src/types/operator/operator.rs` | `7bdd2ca7477bf1729a38d072213b153c4f38dfe4ff8da40e8b44b1550d396c96` |
| 发布包opendal-service-s3 0.59.5 `src/core.rs` | `98ffa8976ed62ce34a5b4136ad1847cd1a848b2e96a621459c02e91f91d2467f` |
| 参考object_store `src/lib.rs` | `6bb5b24c9aba18099c4c21a410ce36a397cfe6eb05bbe119e6f925bdad2d389f` |

参考HEAD与发布包提交仍分别记录，不能把两者散列当作同一制品。
object_store的`PutMode::Create`可表达本轮单对象条件创建，继续作为未引入依赖的源码候选，
没有同场性能比较。OpenDAL是当前已有验证面下代偿更小的选择，不是全局性能排名。
协议、真实后端和边界见`../vedioServerRefer/远端目录与固定版本发布.md`。

## Qdrant索引就绪协议复用

2026-11-06继续复用固定Qdrant公开的集合信息/集合别名、精确count、批量点与向量读取，
不复制或修改索引内核、不新增SDK或依赖。`qdrant_recall.rs`中的分批验证、目录映射、
状态检查和物理集合固定是本项目的协议适配。参考提交仍为
`222b2e44ab1c3f17e8246396ead6558e45041df7`，运行官方1.20.0制品。

| 固定参考文件 | SHA256 |
| --- | --- |
| `src/actix/api/retrieve_api.rs` | `cd00d470e523fb39a999d2462cff8c6f94366af1237a84a457f96a5fcb625bdb` |
| `src/actix/api/count_api.rs` | `bd5c10cd59dfd3312bbb13f3b517227ed579ed60d8480c96591840db426cd962` |
| `lib/storage/src/content_manager/toc/collection_meta_ops.rs` | `4c1d7edead235e619e6c9f1a00efe2f4c725285e574869f6c5bc23ffc98c359c` |
| `lib/collection/src/operations/types.rs` | `841436adf0ceccef014260895f1cde66a22b31fbcf7262126961f7c8d781cc3b` |

别名可重新映射已由源码和实际制品交叉验证，原子操作不当成不可覆盖锁。
本轮没有发布Qdrant fork、改变推荐模型或宣称查询性能收益。
实现和验证边界见`../vedioServerRefer/索引就绪与物理集合固定.md`。

## 部署选择条件更新复用

2026-11-06从锁定OpenDAL `FutureWrite::if_match` 条件替换示例改编
`crates/vs-service/src/deployment.rs`，通过运行依赖调用签名/传输/条件头实现，
未复制存储或共识内核。部署目标、前版本记录、不可覆盖历史、先决校验和不确定结果核对
是本项目适配；沿用ProfileClient、S3CatalogRepository和QdrantRecall既有验证。
未增加依赖，锁文件指纹保持不变。

实际运行包提交仍为`fce9cdefdea7c8e54dfbaf3c88c3b6d5ec68146e`：

| 上游文件 | SHA256 |
| --- | --- |
| opendal-core 0.59.5 `src/types/operator/operator_futures.rs` | `18166d9e4160458d68a72b554fe0bbbd7132f526cd8b37c48e3ea7bc0ceb6e54` |
| opendal-service-s3 0.59.5 `src/core.rs` | `98ffa8976ed62ce34a5b4136ad1847cd1a848b2e96a621459c02e91f91d2467f` |

条件替换与Apache Object Store固定参考的`PutMode::Update`对照，不做无基准的性能排名。
真实RustFS按端点分别读取前快照，验证两端条件替换唯一赢家、回退新代次与旧发布者拒绝；
不是画像事件写入fencing或生产路由实现。
完整取舍、失败实验和最终证据见`../vedioServerRefer/部署选择与条件版本交接.md`。

## 画像历史水位与封存转移复用

2026-11-06继续复用既有cqrs事件信封、SHA-256依赖和Qdrant派生`atomic_create`。
水位、已证明前缀缓存、HTTP短凭据、部署绑定和封存目的地是本项目适配逻辑，
不复制另一套事件数据库或自行实现共识。日志v2原始记录保持不变，未增加依赖。

固定cqrs提交仍为`37c1ab09b5de20ae47aaf0b72a0775b92a45a0cd`，
本轮只读核对以下提交序号/持久化上下文，未新复制这两个模块：

| 参考文件 | SHA256 |
| --- | --- |
| `src/persist/context.rs` | `df1376823fb694c629c54e7080af0979f1da10febe0913c1fe241ee5b2a7b861` |
| `src/persist/event_store.rs` | `4ec9485aeb202dcdade60c99c8d241f5a0652af07dc075e799f2666529af7612` |

文件锁和同步使用Rust固定1.96标准库，语义按官方文档及本机进程验证；
停写封存不当作分布式租约。封存及目标分别不可覆盖发布，不宣称跨文件事务。
后续NATS共享事件权威仍为候选，本轮未加入依赖或运行集群。
完整边界见`../vedioServerRefer/画像历史水位与停写交接.md`。

## Apache Iggy参考克隆

本轮按`server-0.9.0`固定克隆至`.artifacts/upstream/iggy`，
实际提交`71f29618ba04917fded0ef5cd085c206fef0ee49`，不是最新版本声明。
已核对Apache-2.0的LICENSE/NOTICE，仅阅读README、Cargo及消费位点HTTP客户端。
没有复制Iggy服务端核心、修改上游或将Iggy SDK加入业务Cargo依赖；
窄HTTP适配、主题元数据预检和独立服务端实验见文件顶部新增记录。

| 固定参考文件 | SHA256 |
| --- | --- |
| `README.md` | `1dc3e85a17efb1d8f9259b84e760ba83311485234ef3f00b305f56688722fe4d` |
| `Cargo.toml` | `5d078ee76894af4980e69de545bd77f020433fac27d21dd3e13cf6de28b24bb7` |
| `core/sdk/src/http/consumer_offsets.rs` | `872833599ac935609d6d58b6095a7533e338ed716727ab7d04b9b098b7814a05` |
| `LICENSE` | `7808d2fc6ce4cdc1aa5b89e4e36c9769122f702d1ee394228a710e7fbec8a1ae` |
| `NOTICE` | `5b0bb43d50a8000a8e5a5c1f47b674ac0dc06b0cd613f9b118243afd1ee82b1e` |

源码声明最低Rust1.95，README描述Linux io_uring/compio、消费位点及VSR集群；
这些是候选能力，不等于本机运行、跨机故障或资源收益已验证。
当前接入限于固定HTTP契约；真实单节点确认和进程重启已有证据，
主节点变化、保留、跨副本故障和实际成本仍须独立验证。

2026-11-07适配续验的固定文件：

| 文件 | SHA256 |
| --- | --- |
| `core/sdk/src/http/messages.rs` | `f0e1c82fb089591e7d64864f1ffae8c2d686c3d5ebd04fac71f4f0eb3948abca` |
| `core/common/src/http/messages/send_messages.rs` | `568ce92b6d9e712ed838c0b546e29daeead17e3289e9d6e2a263387aae14e542` |
| `core/common/src/types/options/durability.rs` | `9134c5b57b1ab5db851dff27009e52d13d9b8328421b9ef6c75de66cd6d486c0` |
| `core/server/src/http/handlers.rs` | `f8af4e2fd1e64dc5532712e0601ce810364dbf281a12cf66525447802692760f` |

上游固定版本的HTTP写入为至少一次，不保证消息ID去重。普通201不自动证明稳定存储；
本地适配需同时取得persisted声明和匹配分区偏移。只读导出用显式offset且auto_commit=false。
官方配置/持久化网页在2026-11-06读取并存档，不把可变文档当成固定二进制的真实运行证据。

## MP4索引前置复用

2026-11-06新增`crates/vs-service/src/video.rs`。从固定mp4san的官方CLI改编
“重定位元数据 + 原媒体范围”的输出流程；新增资源预检、64KiB完整复制、流式散列和
既有`atomic_create`不可覆盖输出。内部容器解析与stco/co64偏移修正使用`mp4san =0.5.4`，
未复制或重写该内核。盒子头预检调用其公开但标为不稳定的解析接口，因此精确锁版。

| 参考文件 | 克隆原始SHA256 |
| --- | --- |
| `cli/src/main.rs` | `52debf8877775219261b86fd331f090bc0612acf3c259493df076247d0dc7f17` |
| `mp4san/src/lib.rs` | `a094ac9b5c771e7fd55bb001724b089ba02069b0eee0557584550e4942d2d6fd` |
| `LICENSE` | `79ded8f891fb7c8a3a227ebce09aae1bcd70646b631ba39514947db77569e18d` |
| 对照mp4-rust `src/writer.rs` | `969587383e727ea72e46565741b9cb33afb1d7b0dd420c3a1a97e802c3fc11cd` |

发布包`.cargo_vcs_info.json`指向同一固定提交，`src/lib.rs`原始SHA256为
`9c1b3e5b93e9fcf83ca8e32c45d8677826249dfa2c92dde27166bc5f7d9e9d30`；
克隆和发布包行尾正规化后相同。注册表包校验值为
`7f065a39e3fc6a64ae2d86fc97f3a5c6aab21cec8120d8875ac634ac55832056`。
锁文件新增23个包，原有包版本未升级；当前锁文件SHA256为
`16ef7210cccb5be711111c9d754bbed7e50a46b804e0e8abf6529d53f1e127bd`。

该库不支持分片MP4等布局，不是转码器、通用文件安全证明或元数据隐私清理工具。
运行依赖未引入FFmpeg或GPAC；本机FFmpeg 8.0仅生成测试夹具并独立解码HTTP读回视频。
实际选型、局限与可复跑命令见`../vedioServerRefer/MP4视频处理与发布集成.md`。

## HLS分片复用

2026-11-06克隆`vbasky/sheathe`，参考提交`540f87cf55bc5243854efce6e8257a89f7ad463d`；
从`crates/sheathe-package/src/lib.rs`的逐轨分片/写入/清单流程改编本地`src/hls.rs`。
内部媒体模型、MP4解析/写入和HLS清单使用`sheathe-core/mp4/hls =0.6.1`，
没有复制或修改编解码内核，没有引入整个package/origin/CLI。
MIT版权原文保留于`LICENSES/sheathe-MIT.txt`。

发布包VCS提交是`10d701561468d7c30501077446500b1b132d3e72`，与参考HEAD分开记录；
两个提交的core/mp4/hls目录无差异，发布包demux正文与克隆正规化后相同。
实际新增8个包，包括传递的sheathe-crypto及AES；当前入口不启用加密。

| 固定源码 | 克隆原始SHA256 |
| --- | --- |
| `crates/sheathe-package/src/lib.rs` | `b6cd7ccc242643d104ea13585ba39832b14be2b88dffe61f33d3369c803adf9e` |
| `crates/sheathe-mp4/src/demux.rs` | `6fd3abf5c4a41d61c2320bf52ec30de17f44a8430646af537319f9156f6412f7` |
| `crates/sheathe-hls/src/lib.rs` | `7d4c46a81402e2131206613e3fc1fcfae2fea110cb240557ded2b9e8b84a372d` |
| `LICENSE-MIT` | `3750e6879d4099b7e2b3931d35ce4f742b8ac30805aa4bb070f2262c5c56f895` |

本地新增采样表/载荷预算、原编辑列表和时间头保留、不可覆盖发布，以及受限HTTP类型别名。
源文件和样本仍进内存，不能标记为全程流式；只验证受限H264/AAC。
FFmpeg 8.0用于两个素材的独立HTTP解码，未作为生产依赖。
对照克隆`scufflecloud/scuffle`固定`6cafac75a66bdd57f0a401ed12593d824452d392`；
阅读MP4 crate的README、接口与Cargo，保留其开发中警告，未复制或加运行依赖。
取舍、最终证据与限制见`../vedioServerRefer/HLS分片与窗口交付集成.md`。

## CMCD结构化字段与交付观测

2026-11-06克隆`undef1nd/sfv`固定参考`2ea1221def3ec81b6b18d62bbb15d081d0f74aea`，
从`examples/priority.rs`的类型访问器与重复键覆盖流程改编`src/delivery.rs`。
运行使用`sfv =0.16.0`、关闭默认完整字典特性；发布包VCS提交是
`373ba7b3b6265a36d77f9184309e841056d3ffc3`，与HEAD分开记录。
新增4个包；`form_urlencoded =1.2.2`仅提升为直接依赖，复用既有锁版。

参考示例SHA256为`f577c2dc4a419316396c9b9cc74cb2ab206dd46a78e8ceb63d20f3910fd774b7`；
MIT原文保留于`LICENSES/sfv-MIT.txt`。没有复制sfv词法解析内核或添加逐会话数据库。
默认关闭的CMCD子集、守卫、生命周期计数及示例HTTP探针是本项目适配。

对照`cmcd 0.1.0`发布包校验
`43c59d3e0fcd7fb47a7c2f019ad1ba3de5fb3e5f626edc5b1101a605f645caa9`，
VCS提交`15b8f9703b3fe0203db3c24b3abfa29c02d1a417`。源码存在递归查询入口，
未调用该函数、复制实现或引入运行依赖。当前仓库克隆只含README，不能代替发布包审查。
官方CTA仓库与标准HTML仅作语义参考，没有复制标准全文进业务实现；
本轮没有宣称全CMCD v2合规。证据和取舍见`../vedioServerRefer/CMCD请求归因与取消观测.md`。

## Media3缓冲控制移植

2026-11-06克隆`androidx/media`，固定参考提交
`8c6678b657ede1e7883fc164ef73ed483c7796c3`。从
`libraries/exoplayer/src/main/java/androidx/media3/exoplayer/DefaultLoadControl.java`
的`shouldContinueLoading`和`shouldStartPlayback`移植最窄的大小/时间阈值与滞回分支，
本地为`vs-core/src/upstream/media3_load_control.rs`。
原始SHA256为`35fda990f38ec585509ee89eda367b7d9b6a4d663126d42ce22a72c878f490b2`。

保留`Copyright (C) 2016 The Android Open Source Project`，
Apache-2.0全文原样复制至`LICENSES/media3-Apache-2.0.txt`，散列
`3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5`，
改动说明见`media3-NOTICE.txt`。
改用整数毫秒/千分位倍速，最低需求保守向上取整，不移植Android分配器、播放器表和预加载。
外围的活动、在途、完整分片预算及短尾片保护属于本项目适配。
没有引入Java/Android/JS运行依赖或新增Cargo包。

另克隆`Dash-Industry-Forum/dash.js`固定
`23f755d41fcb4a63d57f39da0013407f7b928cce`，阅读`BolaRule.js`和BSD许可作多码率对照；
源码SHA256为`c8e06a033a75dfcdea9c3f42ec534ed67701097f46fbf97d186ead365ccd2a9e`。
未复制BOLA实现或加入依赖。当前只有单码率，未做ABR性能排名或真实QoE结论。
取舍、运行方式和边界见`../vedioServerRefer/Media3缓冲控制与策略发布.md`。

## hls.js缓冲区间移植

2026-11-06克隆`video-dev/hls.js`固定提交
`15ded1909feda7a414998ba022d3b88e647592f7`，阅读`src/utils/buffer-helper.ts`。
区间排序、包含当前位置和选取连续区间的机制移植至
`vs-core/src/upstream/hlsjs_buffer.rs`，原始SHA256为
`8cfe02f2f93206da91f5d0609b984dfc62d4b7a87d5156babab039790231afd3`。
使用整数毫秒，合并重叠/相接区间，不跨正长度缺口；音视频交集、代次和两阶段预留为本项目适配。

保留`Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)`及Apache-2.0声明，
原仓库LICENSE原样保留于`LICENSES/hlsjs-LICENSE.txt`，SHA256为
`4fd40d44f81f24a99c80f7617bc493be3ee21c68291f7d7416d41964e387e20f`；
Apache-2.0全文另见既有`LICENSES/media3-Apache-2.0.txt`。
没有复制hls.js下载器、解码器或JS运行时，没有新增Cargo依赖。
详细接口和证据边界见`../vedioServerRefer/播放器快照与异步追加适配.md`。

## RillML FTRL局部移植

2026-11-06固定克隆`hello-yunshu/rill-ml`提交
`9602750202f56ed860fc8815bb91e81083d0ffdb`，阅读`src/models/ftrl.rs`和
`src/loss/log_loss.rs`，局部移植至`vs-core/src/upstream/ftrl.rs`。
保留`Copyright (c) 2026 RillML contributors`及MIT许可，
全文见`LICENSES/rill-ml-MIT.txt`；本地文件换行与上游克隆可能不同。

| 来源 | 克隆原始SHA256 |
| --- | --- |
| `src/models/ftrl.rs` | `c1dff4df3a7dd487cdfd6d1b9a03c422f7e7df691df0666f1acd439a063ac500` |
| `src/loss/log_loss.rs` | `9a09f1d9baf29facfb7a5125bfa83e12abadb06364d709ffadd3f349af330bf7` |
| `LICENSE-MIT` | `a18d99a0b57d216b17025c5365ca713025dcdb894b2ac27ec245498f5e9abe31` |

本地改为有界坐标表、固定超参数和单次离线训练；在线只加载权重。
样本/时间/权限检查、六维特征、领域修正、模型指纹与不可覆盖发布属于本项目适配。
未复制RillML运行时、插件框架或持久化状态，不加入RillML Cargo依赖。
对照`outbrain/fwumious_wabbit`固定`b3435aa00a92be8e8e603830c1556b2f66c2ff9c`，
读取README、Cargo和BSD许可，未移植或依赖；其默认原生MKL依赖不适合本轮的小模型边界。
新增Cargo包为0，锁文件SHA256仍为
`89ba884f2ba229d5b731ffde8dc81c23ae074829eeb2d419d80d6139a43b56d9`。
取舍与证据限制见`../vedioServerRefer/FTRL学习排序集成.md`。

## 推荐决策与证据关联

2026-11-06继续复用既有`upstream/event_envelope.rs`和`upstream/atomic_create.rs`，
用于副本决策序号、类型化载荷/元数据及离线训练文件不可覆盖发布。
CQRS来源仍为`37c1ab09b5de20ae47aaf0b72a0775b92a45a0cd`；
`src/event.rs`原始SHA256
`5d694861ed41ec5ae4a8e767a0b31d5ca540937ad67bb329bb9d26aaec7da9c1`，
沿用已有Apache-2.0许可和版权声明，没有复制新的第三方实现。

OPA Decision Logs与Vowpal Wabbit Contextual Bandits官方文档仅提供
决策ID/输入结果关联和动作概率语义参考；没有复制代码、启动服务或加入运行依赖。
本地明确区分返回、可见声明与偏好，不虚构随机探索概率。
新增Cargo包0，锁文件不变。来源、实际代价与未验证边界见
`../vedioServerRefer/推荐决策与训练证据集成.md`。

## 机会式组提交机制参考

2026-11-06回读Apache Iggy固定提交
`71f29618ba04917fded0ef5cd085c206fef0ee49`的
`core/journal/src/partition_journal.rs`，原始SHA256为
`615f0eb320bc081534513a61131ddb5e05c726d3d8c5f74c9e93a37972fc3c87`。
只参考`append_batch_buffered`与`sync`的缓冲/持久化确认分离机制；
本地有界队列、零主动等待分组和同文件同步为本项目实现，
未复制其分区日志、frontier、引用段、运行时或分布式协议，未加入Iggy依赖。

另读Qdrant固定提交的`lib/wal/examples/bench.rs`，SHA256为
`9c509d366b643d56f8fd179c604d24e369af80348a8e983f2d6462788ffe4f7e`。
实际同步调用已被注释，未复制或使用其性能输出作为本地依据。
既有CQRS信封与指纹格式继续复用，新增Cargo包0；实验与代价见
`../vedioServerRefer/学习日志组提交.md`。

## 排序模型内容发布与部署绑定

2026-11-06继续复用OpenDAL 0.59.5的`write_with().if_not_exists(true)`、
`reader_with().if_match(etag)`和既有部署仓库条件替换，不新增运行包。
参考克隆`532050ac3c099dd8591cde652a8ed1aaf03ba418`的operator_futures.rs SHA256
为`30b6823a370d1e3c1ac718c8ad207e7cc3628bce91022d7cff1a5d508aa4a6a3`；
实际发布包同文件为`18166d9e4160458d68a72b554fe0bbbd7132f526cd8b37c48e3ea7bc0ceb6e54`，
二者分开记录。模型对象键、部署可选字段和共用校验属于本项目适配，
没有复制新第三方源码或引入模型注册服务，锁文件不变。
官方AWS条件写/OpenDAL文档仅作语义核对，协议与进程证据限制见
`../vedioServerRefer/排序模型发布与部署绑定.md`。

## 三端点播授权的清单与签名复用

2026-11-07克隆`rutgersc/m3u8-rs`，提交
`8df664c7574a4a1b283e6d8543622c5e9842604c`与实际6.0.1发布包VCS一致。
固定依赖`m3u8-rs =6.0.1`，保留MIT许可及
`Copyright (c) 2016 Rutger Schoorstra`，见`LICENSES/m3u8-rs-MIT.txt`。
复用`parse_playlist`、主/媒体清单、初始化映射及`write_to`，未修改上游源码。

签名和随机数直接复用既有`ring =0.17.14`，新增直接声明但未新增该锁文件包；
调用HMAC-SHA256、常量时间验证与SystemRandom，不复制密码算法。
实际包校验和为`a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7`。
许可说明与原许可文件见`LICENSES/ring-LICENSE*.txt`；
不将当前ring克隆HEAD或包的dirty VCS记录当作可复现构建证明。
RustCrypto/MACs仅作机制对照，未新增该项目运行依赖。

本地媒体能力负载、范围/到期检查、主子URI改签及路由是本项目适配。
新增锁文件包共6个；详细身份、代价、验证及原生未验边界见
`../vedioServerRefer/三端播放授权与清单签名集成.md`。

## 三端消费输入的既有日志复用

2026-11-07继续复用固定Apache Iggy提交
`71f29618ba04917fded0ef5cd085c206fef0ee49`的窄HTTP适配，
以及既有CQRS信封、决策日志、固定快照、原子导出和回放。
消费协议与平台来源校验是本项目适配；本轮新增Cargo包为0，锁文件不变。

CloudEvents规范提交`56b54136a6088c47058ed43c2df45e433b4868f0`
只提供稳定`source + id`语义参考，没有复制SDK或承诺CloudEvents线协议兼容。
Media3固定源码和Apple官方接口说明仅用于保留原生信号差异；
没有复制Android/iOS SDK，也没有把后端契约检查当作真机验收。
详细边界见`../vedioServerRefer/三端消费事件与跨域推荐输入.md`。

## 消费顺序保留

继续以固定CQRS提交`37c1ab09b5de20ae47aaf0b72a0775b92a45a0cd`的
`EventEnvelope`聚合身份/序号为结构参考，使用现有消费代次和单调毫秒，
以Rust标准排序完成固定窗口归并。`vs-core/src/event_order.rs`为本项目的窄适配，
没有复制新的第三方实现、引入时钟服务或增加Cargo依赖。
新格式和旧模型兼容边界见`../vedioServerRefer/消费顺序保留与同秒反馈.md`。

## 反馈固定入口切换

2026-11-07继续复用既有 Apache Iggy 窄 HTTP 适配和 reqwest 0.13.5。
固定 Iggy 提交仍为`71f29618ba04917fded0ef5cd085c206fef0ee49`，
回读`core/server/src/http/forward.rs`，SHA256
`4f7f9bed887f25ada1b66e653cf4b534d366f25352104ae82952ccb6356adc67`。
仅参考“未接受”和“结果未知”的边界，不复制上游转发器或共识实现。
reqwest错误分类源码SHA256为
`b7aa133184a6519cd71d6f28fe2424f2db55ea4b9bef3a17b5df2d8be176a0d5`。

本地固定地址选择、总期限和主题创建时间核对为本项目适配。
没有新增第三方源码或Cargo包，既有许可保持；详细边界见
`../vedioServerRefer/反馈入口切换与未知写入边界.md`。

## 消费凭据的JWT根

2026-11-07固定接入`jsonwebtoken =11.1.0`，关闭默认特性，使用既有ring提供Ed25519验签。
实际发布包VCS为`4c0ae752e9acc108c8e2c4c8ed8128dc66014210`，
克隆位于`.artifacts/upstream/jsonwebtoken`并已固定到该提交。
最初读到的主分支`11f83ab50d796f7e3a51d8fbd203ab3d050fed1b`不作为发布包接口证据。
直接调用公开的解码、验证及CryptoProvider接口，没有复制或修改JWT库或密码算法。
本地`src/upstream/jwt_ring.rs`仅适配已有ring和上游扩展接口。

MIT版权与许可原文保留于`LICENSES/jsonwebtoken-MIT.txt`，
`Copyright (c) 2015 Vincent Prouillet`。
新增锁文件包为jsonwebtoken、signature、rand_core、zeroize_derive；
没有引入PEM、AWS-LC、完整RustCrypto后端或身份数据库。

对照克隆`slowli/jwt-compact`提交`6b410eeff261738123d6993388183fde66df5e26`，
只读README、工作区及crate配置与算法接口，不复制代码或新增该依赖。
RFC8725仅提供算法、发行者、受众、显式类型和互斥验证规则的机制参考。
比较、版本差异反例、成本及边界见`../vedioServerRefer/消费凭据根选型与三端入口集成.md`。

## str0m实时媒体内核

2026-11-07固定`str0m =0.25.0`，发布包VCS为
`5f2183ce7c67117cd1960dfeb11bed11fc188b66`，注册表校验和
`357c7e453c033c8bb59e912312f9f9ff07c2a9ce7268bcb94f0c828a5b47e58f`。
本地克隆`.artifacts/upstream/str0m`已固定到该提交；
最初主分支`8e0067cca6a45ae4ea0532148d08a3d803d29841`不作为发布包构建证据。

`vs-live/src/lib.rs`改编`examples/chat.rs`与`examples/http-post.rs`的单UDP分流、
编码帧转发和关键帧请求，保留`Copyright 2022 Martin Algesten`，
示例改编选择MIT，原文见`LICENSES/str0m-MIT.txt`。
ICE、DTLS、SRTP、RTP、编解码器及拥塞控制均直接调用上游，没有复制或修改协议核心。
Windows固定使用官方str0m-wincrypto 0.9.0，其VCS为相同提交；
Linux条件配置使用RustCrypto，但证书生成功能还会引入AWS-LC，不声称纯Rust依赖或Linux已验收。

对照`8xFF/atm0s-media-server`固定
`0507f5eddc5b67bbf5c59700aae3be451adcdad5`，仅阅读README/工作区与依赖边界，
未复制代码、编译或加入其完整运行时。
完整比较、失败和最终证据见`../vedioServerRefer/Rust实时SFU根与互操作集成.md`。

## atm0s的SDP HTTP资源结构

2026-11-07继续复用上述固定atm0s提交，
从bin/src/http/api_media/whip.rs和whep.rs局部改编SDP创建、
201/Location和DELETE结构到vs-live/src/sdp_http.rs。
保留Copyright (c) 2023 8xFF与完整MIT许可，见LICENSES/atm0s-MIT.txt。
未复制Poem、集群RPC、Token体系或ICE片段实现，未编译或引入整个atm0s平台。
上一节“未复制代码”只指前一轮的架构对照，本轮复用范围以上述记录为准。

SDP解析/生成仍由固定str0m包处理；
资源随机数、base64与MIME分别复用锁内ring、base64和mime，未新增Cargo包。
RFC9725与WHEP草案05仅提供规范参考，没有复制规范中的代码组件。
来源指纹、真实mDNS和删除时序反例见
`../vedioServerRefer/实时SDP接入根复用与验证.md`。

## 直播凭据的共享验签

继续使用固定jsonwebtoken 11.1.0和ring 0.17.14。
原vs-service/src/upstream/jwt_ring.rs迁移为crates/vs-auth/src/lib.rs，
消费和直播共用同一验签适配；既有MIT/ring许可与来源保持，不新增外部包。
新增vs-live/src/access.rs为本项目的直播范围校验。
atm0s的tokens.rs与endpoint.rs只作房间、角色及进程代次的结构参考，
没有复制其签发、Token验证或连接ID解析器。
Node内置crypto仅作隔离实验的独立签发实现，无新增npm依赖。

## 房间分配的共识与持久根

固定openraft 0.9.25，发布包和克隆提交均为
8815cdba2826f74e848acef361ad03f93bb1c3f8，局部改编官方
examples/raft-kv-memstore的网络、状态机/快照与管理结构。
MIT原文见LICENSES/openraft-MIT.txt，协议算法直接调用依赖。

固定Danube v0.16.0提交10950acb975dcf5bfe8678311ccfd7c56db52460，
局部改编danube-raft/src/log_store.rs到vs-coordination/src/storage.rs。
Apache-2.0全文保留在LICENSES/danube-Apache-2.0.txt。
没有复制消息平台、watch/TTL、gRPC或其整套状态机。
署名与修改范围见LICENSES/room-authority-NOTICE.txt。

redb固定2.6.4，发布包与克隆提交
0e7f350dfea376eccc5229033f3cde031c422632相符；直接依赖数据库内核，
显式设置8MiB缓存预算，不修改redb源码。
新vs-coordination单独运行，不作为vs-live或vs-service运行时依赖；
工作区新增46个外部锁文件包，不将此代偿描述为零开销。

## 房间分配到媒体执行的接线

继续复用上述固定OpenRaft、Danube/redb、str0m和jsonwebtoken/ring根。
新增vs-core/src/room_assignment.rs最小线协议、
vs-live房间版本接受/排空及vs-coordination媒体回执检查属于本项目适配，
无新增外部Cargo包，不复制共识、媒体协议或数据库算法。
etcd官方contrib/lock只作资源端版本检查的设计参考，未复制Go代码或运行其服务。
当前复用范围和真实证据见../vedioServerRefer/房间分配接受与真实媒体排空.md。

## 协调节点的双向TLS

2026-11-08从已有Axum克隆固定提交
40d061fdacd468217c7a609bede16357276b6c40的
examples/low-level-rustls/src/main.rs局部改编TCP接入、
TlsAcceptor及Hyper到Tower的桥接到vs-coordination/src/tls.rs。
源码SHA256为dedd06bf6f8799b95b1b8e939b10542068d74fb13e222b5f8ddffd1a949bd6b4。
保留Copyright (c) 2019–2025 axum Contributors和完整MIT许可：
LICENSES/axum-tls-MIT.txt。旧axum-MIT.txt属于另一历史来源，不覆盖。
已校验许可原文一致；克隆的CRLF/无末尾换行与本地LF/末尾换行导致字节摘要不同，
两份摘要分别保留在coordination-mtls-evaluation.json，不将其误判为许可文本差异。

该示例提交不是锁定Axum 0.8.9发布包的源码身份；
本项目在锁定包上做了适配和实际编译验证，不混称两者。
本地增加客户端证书强制验证、证书角色、固定名称/地址、请求和连接预算、
有界停机及稳定传输模式策略。没有复制或修改密码、验签或共识算法。

直接调用锁内hyper 1.12.0、hyper-util 0.1.21、tokio-rustls 0.26.6、
rustls 0.23.46、reqwest 0.13.5及既有Tower。
tokio-rustls发布包VCS为8aebb7c9556ea8024c1b974b84a4a6f2e306889a，
rustls为f04804fa13341a9b1dc02b5d1dd8a746f2c4b7fb；
前者MIT OR Apache-2.0，后者Apache-2.0 OR ISC OR MIT。
仅测试调用rcgen 0.14.10和pem-rfc7468 1.0.0生成隔离证书，
许可分别为MIT OR Apache-2.0、Apache-2.0 OR MIT。
这些包已在原锁文件中，本轮增加直接依赖及ring特性引用，没有新增包版本。

axum-server只作官方README能力对照，未克隆、复制或加入依赖。
当前选择依据是已有框架、窄适配和可验证预算，不是TLS性能排名。
来源、失败及最终验证见../vedioServerRefer/协调节点双向TLS与换证边界.md。

## 运维客户端复用既有协调TLS

2026-11-08在同一固定Axum/rustls/reqwest根上接入media-admin可选mTLS，
复用已有PEM读取、CA验证及固定目标客户端构造，未另复制上游源码。
直接调用rustls 0.23.46的WebPkiClientVerifier、
CertifiedKey::from_der和keys_match，未知密钥一致性也显式拒绝。
reqwest 0.13.5的根集合、身份、resolve及禁重试接口沿用；
既有开源许可继续有效，Cargo.lock完全不变。
固定运行包源码与官方API文档作为接口证据，不声称其为最新版本或性能冠军。
验收见../vedioServerRefer/problem-space/media-admin-mtls-evaluation.json。

## 媒体只读权威核验与窄TLS客户端

2026-11-08从本项目原vs-coordination/src/tls.rs复制并抽取固定目标客户端实现到
vs-tls/src/lib.rs，运维、协调和媒体出站读取共同调用；旧OperatorTlsSettings保留公开别名。
该模块不复制新的上游源码，也不包含OpenRaft/redb、媒体运行时、服务角色或签发逻辑。
原Axum低层接入改编仍留在协调服务；既有Axum/rustls/reqwest许可与署名不变。
上游依旧通过锁定rustls 0.23.46和reqwest 0.13.5的公开API调用。

新增本地包vs-tls 0.1.0；锁文件没有新增或升级外部包版本，
测试仅增加到已锁定base64 0.22.1和ring 0.17.14的直接引用，用于隔离测试密钥。
只读角色与owner.node_id检查属于本项目领域规则，不引入通用IAM或策略引擎。
OpenRaft的既有ensure_linearizable继续决定权威读，不以TLS成功替代多数派。
来源比较、成本和真实进程边界见
../vedioServerRefer/媒体权威只读TLS与执行器隔离.md。

## 反向TLS排空候选

2026-11-08把既有Axum低层接入改编迁移到vs-tls/src/server.rs，
保留原固定提交和Copyright (c) 2019-2025 axum Contributors，
原LICENSES/axum-tls-MIT.txt继续适用；未复制新的上游算法源码。
共享层只提供真实证书指纹，协调角色和排空名单仍由服务端领域模块判断。
锁文件只增加既有包的引用，没有新增外部版本。
早期链接曾因磁盘已满失败，检查点保留；容量恢复后94项常规与2项显式进程实验通过。
最终范围是静态名册控制链路，不是媒体全链路跨机或生产准入。
当前验收见../vedioServerRefer/problem-space/media-drain-mtls-evaluation.json，
历史失败见media-drain-mtls-checkpoint.json。

## 原生播放控制语言绑定

2026-11-09稀疏克隆Mozilla UniFFI v0.32.2，
固定提交7bc621ee9d0d15371d792612707ba5ed4111f950，MPL-2.0。
`native/src/lib.rs`的宏接线改编自
`examples/arithmetic-procmacro/src/lib.rs`，
`native/src/bin/bindgen.rs`改编自`uniffi/uniffi-bindgen.rs`；
原MPL源码标记、完整许可和范围在`native/NOTICE.txt`及`native/LICENSE-MPL-2.0`。
未复制或修改UniFFI的内存、ABI、句柄和语言生成内核。
业务状态直接使用原vs-core的PlayerAdapter，Media3与hls.js原来源保持。

独立原生workspace/锁文件新增27个外部名称版本，不进入服务端锁文件；
宏生成unsafe被隔离在此边界，服务端unsafe_code=forbid不变。
Kotlin/JVM实验固定JNA5.12.1，Maven原JAR保留自身META-INF许可；
它是测试及未来Kotlin运行时依赖，不属于Rust服务端依赖。
来源、SHA256和仓库SHA1见实验jna-source.json，SHA1只作完整性对照，不作为签名验证。
原生发布仍须独立审核MPL、JNA及全部依赖分发义务，未宣布生产许可准入。

Rust包装器/宿主外语调用、Kotlin编译调用及Android arm64交叉制品已验，
Swift仅生成；Android/iOS真机、AAR/XCFramework、JNA Android原生库、
媒体真实快照映射和三低尚未验。
见../vedioServerRefer/problem-space/native-binding-evaluation.json。

## Media3发布接口消费者

2026-11-09复用原TimeBufferControl并增加窄FFI对象，没有新增Rust外部版本。
Kotlin消费者按Google Maven实际发布的media3-exoplayer/common 1.11.1 API本地编写，
没有复制DefaultLoadControl、ExoPlayerImplInternal或新的播放器。
本轮研究调用顺序及接口的来源是1.11.1源码JAR，不冒称它等于原研究git提交。
消费者和Kotlin测试使用Apache-2.0标记；完整许可继续见LICENSES/media3-Apache-2.0.txt。
原MPL Rust FFI边界与Apache Kotlin消费者分记于native/NOTICE.txt。

开发验收新增实际Media3 AAR/JAR及Guava33.5.0-android，
JNA仍沿用固定5.12.1；原发布制品和许可保留在O盘实验目录，不进入服务端Rust依赖。
宿主以Android SDK桩类链接，实际Parameters/DefaultLoadControl和Rust DLL均调用；
不把桩环境当Android运行，也不声称实际播放器解码或取消。
验收见../vedioServerRefer/problem-space/media3-consumer-evaluation.json。

## Android AAR本地草稿

2026-11-09保持Media3 1.11.1/UniFFI0.32.2/Rust内核，新增标准AAR封装。
自有AAR不嵌入JNA或Media3依赖；显式固定官方JNA5.19.1 Android AAR，
按其官方Apache-2.0 OR LGPL-2.1-or-later声明保留许可，本轮采用Apache-2.0路径，
不修改Java/JNI源码或原始AAR。
完整原声明和Apache文本见LICENSES/jna-5.19.1-LICENSE.txt及jna-5.19.1-Apache-2.0.txt。
历史JNA5.12.1宿主证据保持，不覆写或伪称其Android已验。

JNA新AAR/JAR、Media3实际制品与Guava33.5.0-android均为开发/Android外部依赖，
Rust两锁不变。自有AAR及源码归档保留MPL、原Media3版权、Apache许可和本地变更范围。
源码归档是当前dirty工作区快照，不是某个干净提交的正式候选。
打包固定文件顺序/时间并两次同摘要，只证明同输入ZIP封装确定性，不是跨环境源码构建复现。
原生16KiB段和D8处理不能替代APK ZIP对齐、R8、Android设备或依赖分发审核。
本轮未远端发布或创建候选事件，见../vedioServerRefer/problem-space/android-aar-evaluation.json。

## Android独立播放实验应用

2026-11-09本地Activity生命周期参考官方Media3 1.11.1 Demo
`demos/main/src/main/java/androidx/media3/demo/main/PlayerActivity.java`的
onStart创建/onStop释放结构，窄实验Activity以Apache-2.0标记，未复制完整Demo或重写播放器。
实际使用Media3发布的common/exoplayer/container/datasource/decoder/extractor/database模块、
Guava33.5.0-android、failureaccess1.0.3、AndroidX annotation1.6.0、
annotation-experimental1.3.1和exifinterface1.3.6；JNA5.19.1和Kotlin2.1.21保持。
固定制品/资源摘要、POM来源均在本轮O盘证据，不新增Rust依赖或改变两锁。

APK附已有native/vs-core源码归档、Activity源码、MPL/Apache/MIT与原制品自带许可通知；
仅本地未收缩实验，不代表生产分发审核、正式候选或依赖树穷尽证明。
官方SDK工具完成完整DEX/资源/临时签名及ZIP对齐，不宣称AGP/R8已验。
首次真机安装被用户侧安全边界拒绝，未绕过、未运行；
设备实验必须取得明确安装许可后重试，详见../vedioServerRefer/problem-space/android-device-evaluation.json。

## 画像离线备份与封存恢复演练

2026-11-09回读固定Qdrant提交222b2e44ab1c3f17e8246396ead6558e45041df7的
`src/common/snapshots.rs`恢复前外部checksum核验，以及
`lib/collection/src/common/snapshots_manager.rs`暂存/同步/最终发布机制。
复用本项目原`upstream/atomic_create.rs`（此前派生自同固定Qdrant的
`lib/common/common/src/fs/ops.rs`，Apache-2.0标记及LICENSES/qdrant-Apache-2.0.txt保持），
没有另复制Qdrant snapshot/tar、数据库或集群内核。
本地实现有界单文件magic/头/原始JSONL容器，以避免归档路径解包；
字段、画像投影重放指纹、严格只读打开和封存恢复是本项目领域适配。
固定源码HTTP拷贝与SHA256留在本轮sources证据；不是上游原生画像备份功能。

原cqrs事件信封、ProfileState、File锁和tempfile公开API保持复用。
读源共享锁对原写者独占锁，严格模式不截尾/chmod/创建源；
恢复前固定外部归档摘要并校验原始日志和投影，先封存标记再发布副本，不自动赋予写者权威。
无新增Rust包、外部版本或锁文件变化；默认服务角色及画像算法不变。
Windows定向及独立进程、Linux来宾权限/符号链接和CLI通过，
不证明异机灾备、物理多数派、掉电、在线扩容、真实效用或三低。
归档含敏感原始主体数据，生产加密/删除撤回/保留治理仍为独立准入门。
验收见../vedioServerRefer/problem-space/profile-backup-evaluation.json。

## 固定画像分片实验

2026-11-09继续复用原ProfileClient/JSONL、CQRS事件信封、ProfileState和
固定Qdrant派生的atomic_create，不增加外部版本或复制新数据库/共识内核。
回读固定Qdrant 222b2e44ab1c3f17e8246396ead6558e45041df7的
lib/collection/src/hash_ring.rs与shards/shard_holder/resharding.rs作机制对照：
只借鉴稳定归属及读写迁移阶段分离，不移植双哈希环/双写。
本地SHA256主体映射、HTTP身份与日志标记属于领域胶合，不声称Qdrant协议兼容。
原Apache-2.0许可、CQRS和Qdrant来源标记保留；无新源码许可或锁文件变化。
本实验不实现全局fence、复制、在线重分片或生产准入。
见contracts/profile-shards-v1.md及../vedioServerRefer/problem-space/profile-shard-routing-evaluation.json。

## 画像共识权威实验

2026-11-09复用现有OpenRaft v0.9.25、redb 2.6.4和Danube
v0.16.0日志适配，新增隔离ProfileLedger状态机。
固定根提交、来源路径与许可见LICENSES/room-authority-NOTICE.txt；
没有新外部版本、源码克隆或锁文件变化。
写者代次、事件facts、event_id幂等和ProfileState投影在同一Raft日志顺序、
redb state事务内；快照安装重放并核对目录/分片/epoch/facts，拒绝房间历史接管。
实际三节点故障/少数派/恢复、快照清理水位、TLS角色与媒体跨包回归通过。
本实验一个Raft组承载所有逻辑分片，不代表独立分片吞吐、在线迁移、物理多机或生产准入。
Iggy、Qdrant、Citus、TiKV仅保留候选边界，不被本地实验结果替换或宣称性能排名。
见contracts/profile-consensus-v1.md及../vedioServerRefer/problem-space/profile-consensus-evaluation.json。

## 画像负载调度诊断

2026-11-09克隆hatoo/oha并固定43c7cf207fa7153ff1dbb566b0a9d60b3741d0d6，
局部改编src/client.rs的固定到达调度和计划起点计时，见
crates/vs-coordination/examples/support/load_schedule.rs。
MIT全文与署名/变更范围保存在LICENSES/oha-MIT.txt和oha-NOTICE.txt。
本地使用有界Semaphore/JoinSet、明确丢弃、原始样本和精确分位数，
不复制oha HTTP内核、TUI、CLI或无界kanal队列，不新增外部依赖。
领域协议核验、换代屏障、进程身份握手和资源采样是本项目适配。
Windows debug同机数据不证明生产容量、物理集群或三低收益。
见contracts/profile-load-v1.md及../vedioServerRefer/problem-space/profile-load-evaluation.json。

## 共识画像只读Feed适配

2026-11-09回读固定OpenRaft提交8815cdba2826f74e848acef361ad03f93bb1c3f8的
examples/raft-kv-memstore/src/client.rs，参考consistent_read与读取节点发现机制，
继续使用既有reqwest/固定白名单，不复制ExampleClient写重试、任意leader地址跟随或请求日志。
没有复制新的上游源码模块；原OpenRaft MIT及room-authority-NOTICE来源保持。
新增ProfileBackend共识只读变体、受限回环配置、响应身份/水位校验，
原Feed隐藏/范围/Ed25519主体验证复用；服务正常依赖不引入OpenRaft/redb或协调库。
零新外部版本、克隆和锁文件变化。只读代码不代表生产只读凭据，当前仅回环实验。
固定源码`openraft/src/raft/mod.rs`的线性读等待契约亦核对；HTTP与本地克隆按换行归一后逐字符一致。
真实三协调/两API的签名推荐、主故障、少数派和回收通过，合成发行者不是生产身份。
见contracts/profile-consensus-feed-v1.md及../vedioServerRefer/problem-space/profile-feed-consensus-evaluation.json。

## 共识画像专用读取mTLS

2026-11-09复用既有vs-tls FixedClientTls、协调TlsTransport/VerifiedPeer与固定角色表，
以及rustls/reqwest公开API。原Axum low-level-rustls改编署名和许可保持，
没有复制新认证平台或密码学源码；vs-service仅新增到本地vs-tls的依赖边，
无新外部名称/版本。精确方法/路径、独立读取令牌和画像模式配对为本项目领域适配。
rustls 0.23.40官方验证器文档与etcd v3.6恢复文档仅作边界复核：
证书验证不代替业务授权，恢复身份不等于可随意复用旧集群身份。
未复制etcd代码，也未实现历史实例/前缀证明；不存在新的“全局最强”排名。
见contracts/profile-read-mtls-v1.md及../vedioServerRefer/problem-space/profile-read-mtls-evaluation.json。
