# 缓存起播因果对照

<重表述提示词为问题>流式缓存提前交付的前缀，经过固定版本播放器和当前封装后，能否在分片尾部到达前产生真实解码帧？</重表述提示词为问题>

本契约仅描述本机实验入口，不改变生产媒体、缓存、推荐或播放器默认配置。
第一方服务、对象源和权限分派均复用Rust实现；
浏览器播放器继续使用原样固定的hls.js 1.7.4，不重写媒体解复用器。

## 范围与配置

`playback_lab`新增可选环境变量：

| 变量 | 值 |
| --- | --- |
| `VS_LAB_CACHE_PROBE` | 不设置时保持原文件读取；实验值为`direct`、`exact`、`block-64k`、`block-64k-stream` |
| `VS_LAB_CACHE_ENTRY_BYTES` | 仅65536或262144；默认65536，仅影响本实验启用的缓存 |
| `VS_LAB_CHUNK_MS` | 可选100至1000毫秒片内封装；不设置为原单片段布局 |

启用后先沿用原HLS发布器，再将本次发布对象载入最多64MiB的内存源站，
由OpenDAL S3读取和原媒体HTTP路由访问。源站只绑定回环地址，
只检查SDK生成的AWS4授权头前缀，不能作为密码验签或真实对象存储集群证据。
播放器仍从原有本机推荐与播放授权接口取得固定素材授权。

本机路径：

| 路径 | 行为 |
| --- | --- |
| `GET /lab/cache-probe?progressive=0` | 保持hls.js默认整片加载的独立实验页面 |
| `GET /lab/cache-probe?progressive=1` | 只在该页面开启hls.js公开`progressive`配置 |
| `GET /lab/cache-origin` | 源站、屏障、缓存及存储HTTP状态 |
| `POST /lab/cache-origin/release` | 一次性释放本进程的分片尾部屏障 |

不启用实验时，探针页面、源站状态和释放接口返回404。
所有接口继续受原本机Host、Origin、跨站请求及CSP边界控制。
原页面和XHR消费计量不切换到Fetch，探针不提交训练或消费标签。
探针在用户停止或离开时递增代次，授权接口迟到响应不能重新启动播放器或媒体读取。

## 因果屏障

只阻塞首个视频分片最后一个字节。源站对落到对象末端的读取先发其余部分，
然后等待显式释放；HEAD、清单、初始化段和音轨不被该屏障阻塞。
这不是人为降低整个视频带宽，也不是生产网络分布模拟。

自动对照固定执行：

1. 启动全新Rust进程和冷缓存，浏览器独立打开探针页面。
2. 观察源站末字节等待者为1，固定等待1200毫秒。
3. 在释放前保存缓存、CDP正文、缓冲追加与帧回调状态。
4. 释放屏障，验证后续帧回调及非空变化像素。
5. 检查桌面和390像素视口，停止并确认源站正文、存储交换和缓存填充全部回收。
6. 关闭浏览器和本次子进程，检查对应监听端口退出。

缺省三种服务端路径、两档条目、两种播放器配置为12种组合；
第二轮完整倒序，保留24份结果。单次运行也可设为一轮12组。
成功的功能检查不要求提前出帧；没有帧可能正是被验证的反例。
运行错误则停止后续组合并保存失败，不能把未执行组合算作通过。

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$env:PWTEST_DAEMON_SESSION_DIR = 'O:/CodexVideoBuild/tmp/playwright-cache-probe'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:/CodexVideoBuild/tmp/playwright-transform'
node vedioServer/labs/playback/run-cache-probe.mjs `
  --binary O:/CodexVideoBuild/target/debug/examples/playback_lab.exe `
  --source <H264及可选AAC的MP4> --cli <已安装的playwright-cli.js> `
  --output <尚不存在的非C盘目录> --repetitions 2
```

## 指标与推理边界

- CDP `dataLength`表示浏览器报告的解码正文；不同于XHR、缓存产出、源站产出或线路字节。
- `early_yielded_bytes`是整个缓存实例的累计量，也包括清单、初始化段和音轨；
  必须按被阻塞视频的内容散列匹配CDP请求，不能直接当作该视频前缀。
- 帧回调来自`requestVideoFrameCallback`，还需非空变化像素检查；
  它不等于屏幕物理出光，也不等于原生Android或iOS效果。
- 首帧时间包含人为的1200毫秒屏障、签发和播放器初始化；
  不能用这组数值排名真实网络延迟或推断生产P95。
- 当前HLS发布器每个视频分片写入单组`moof/mdat`。
  固定hls.js的128KiB加载阈值及MP4解复用器保留最后片段的行为，
  都可能让已经收到的前缀无法进入MSE。
- 原默认保持单组，显式片内切分可产生多个`moof/mdat`；
  `--packaging single,250,500 --entries 262144`输出v2报告，
  记录每种布局，不把不同封装混为同一素材字节对照。
- 256KiB条目只是一档显式对照；不能为获得缓存命中而默认扩大容量。
  也不能将跨块精确键回退称为单块邻近复用。

固定源码、具体结果和后续选择见
[缓存到首帧评估](../../vedioServerRefer/problem-space/cache-playback-evaluation.json)。
后续多片段正向及小素材反例见[片内封装](hls-chunks-v1.md)。
