# HLS片内多片段封装

<重表述提示词为问题>能否复用已有Rust封装器，让一个HLS对象中的完整媒体片段先被消费，同时保持原关键帧分片、编码载荷、时间线和对象数？</重表述提示词为问题>

## 可选入口

原`publish_hls`保持`Single`布局，原清单与媒体正文不变。
新增`publish_hls_with_layout(..., HlsLayout::Chunked { target_ms })`，
`target_ms`仅100至1000毫秒。CLI增加一个可选末尾参数：

```powershell
publish_hls.exe <已存在发布根> <源MP4> <目录版本> <候选ID> <外部分片秒数1至6> 500
```

`playback_lab`显式设置`VS_LAB_CHUNK_MS=250`或`500`可选择本轮候选。
未设置保持单片段布局。对照运行器增加：

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$env:PWTEST_DAEMON_SESSION_DIR = 'O:/CodexVideoBuild/tmp/playwright-chunk-probe'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:/CodexVideoBuild/tmp/playwright-transform'
node vedioServer/labs/playback/run-cache-probe.mjs `
  --binary O:/CodexVideoBuild/target/debug/examples/playback_lab.exe `
  --source <源MP4> --cli <playwright-cli.js> --output <新的非C盘目录> `
  --repetitions 2 --packaging single,250,500 --entries 262144
```

运行器缺省仍为`single`及65536/262144两档条目；
报告升级为`cache-playback-comparison-v2`并记录封装身份、源码及发布收据。
历史v1报告保留。发布收据保留`hls-publication-v1`身份，新增`layout`及每个分片的`chunk_count`字段，
原脚本按字段读取不受影响；严格拒绝未知字段的外部收据消费者需要更新。
这些是离线发布收据，不是媒体HTTP协议字段。

## 复用与边界

锁定`sheathe-mp4/core/hls 0.6.1`，固定参考
`vbasky/sheathe@540f87cf55bc5243854efce6e8257a89f7ad463d`。
先沿用原`fragment`、`keyframes_only=true`确定HLS外部分片；
再在每个分片内部调用同一`fragment`，按目标时长、`keyframes_only=false`切分。
最后逐个调用原`write_media_segment`，保留首个`styp`及每组`moof/mdat`。
样本DTS/PTS、时长、标志、顺序和编码数据不改变，原电影时基与编辑列表保留。

上游`write_media_segment`的`sidx`固定声明SAP，内部非关键帧片段不能沿用该随机访问声明；
本布局不输出`sidx`，不重写它的偏移和样本表。每个`moof`仍使用上游的
`default-base-is-moof`及相对数据偏移，轨内`mfhd`序号从1递增。
每个HLS对象开头仍在原随机访问点；内部片段不保证独立随机访问，
不能单独取出中间非关键帧片段并宣称可以从零解码。

原输入、轨道、样本、时长与目录预算保持。
新增每个HLS对象最多128个内部片段、每轨最多4096个，
达到限制则拒绝，不提交对应目录。失败后可有未引用内容寻址对象，与原发布语义一致。
原封装器仍将输入和采样载荷放入内存；本功能不是实时有界流封装器或RSS优化。

媒体对象数、清单条目数、权限、内容寻址、Range及播放授权继续使用已有路径。
本布局没有增加`EXT-X-PART`、预加载提示或服务端阻塞式清单，
没有完整LL-HLS、CMAF认证、直播编码或原生SDK声明。

## 实测取舍

同一32秒合成H264/AAC素材，2秒外部分片，视频/音频各16对象。

| 布局 | 全部发布资产字节 | 资产数 | 每轨内部片段 |
| --- | ---: | ---: | ---: |
| single | 2494944 | 37 | 16 |
| 250毫秒 | 2514784 | 37 | 128 |
| 500毫秒 | 2502496 | 37 | 64 |

媒体正文增量分别19840和7552字节；本表包括清单和初始化等发布资产，
不含HTTP/TLS/重传，也不是播放器实际下载总量。
清单对象集合不增加不等于CPU、逐步追加次数或实际请求轨迹不变。

三布局、两种播放器配置、三种读取路径、正反两轮共36组末字节屏障对照：
只有250/500毫秒、播放器`progressive=true`、直通或流式缓存的8组提前出帧，
其余28组仍为0帧；缓冲缓存必须等待完整对象。
8组在屏障释放前呈现22至24帧，屏障仍有一个等待者，媒体请求未完成。
完整解码与原素材逐轨比较768条视频、1500条音频记录的时间戳、时长与散列一致。

反例：小素材首片低于固定hls.js的128KiB媒体加载阈值，
6组500毫秒对照均无提前出帧；独立解码24条视频、47条音频仍与原片一致。
将外部目标设1秒时，原素材2秒关键帧间隔使视频仍为16片，
音频增至32片、资产增至53项；不能仅通过缩小目标承诺更快视频起播。

500毫秒因本次相同提前出帧门槛下封装增量较小，保留为下一轮优先实验，
250毫秒继续对照，默认不变。没有真实网络、CPU/RSS/功耗、Android/iOS或物理多机结论。
证据见[片内封装评估](../../vedioServerRefer/problem-space/hls-chunks-evaluation.json)。
