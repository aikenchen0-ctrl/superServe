# 播放工作器代码复用

<重表述提示词为问题>主库已经包含工作器代码时，能否直接复用上游内置工作器，减少重复脚本请求与起播等待，并保持线程执行、版本一致和停止回收？</重表述提示词为问题>

## 显式选择

`playback_lab`新增`VS_LAB_WORKER_MODE=embedded`，现有播放页面从`/lab/config`读取模式，
将固定hls.js的`workerPath`设为`null`，仍保持`enableWorker=true`。
不设置时为原`external`，仍使用`/vendor/hls.worker.js`。
未知值、额外空格和编码无效在监听前拒绝。

独立探针使用`/lab/cache-probe?worker=embedded`显式选择；
缺省`external`，其他值拒绝。探针参数不改变主页面的服务配置。
主页面的CMCD、XHR观测、消费标签、播放授权与取消流程保持已有路径。

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$env:VS_LAB_WORKER_MODE = 'embedded'
./vedioServer/labs/playback/run.ps1 -InputVideo <MP4路径>
```

本入口只在已有本机实验服务生效，不是原生Android/iOS适配。
第一方服务仍为Rust，浏览器继续原样使用固定hls.js发布物。
本功能没有新增Cargo/npm包、工作器保活服务、跨页面共享池或资源缓存。

## 机制与版本边界

复用`video-dev/hls.js@1.7.4`，发布提交
`142fcab1fd0de99beafb0e1b07102ec674a9ddf9`：

- `src/demux/inject-worker.ts`中的`injectWorker`从主库内置代码生成Blob工作器，
  按上游版本维护引用计数。
- `src/demux/transmuxer-interface.ts`继续发送初始化、区分音视频实例，
  销毁时释放引用；最后消费者销毁后终止线程并回收对象URL。
- 本项目只选择公开配置，不调用私有函数、不复制或修改播放器内核。

当前主库623915字节，内含工作器构造；外部工作器另118366字节。
内置候选没有把工作器代码变没，它复用已下载的相同主库。
如果以后改为不含工作器的精简包、分离构建或另一个版本，必须重新验证：
不能把`workerPath=null`直接等同一定后台执行。
本机CSP原已允许`worker-src 'self' blob:`，没有扩大权限边界。
主库、工作器指纹及许可继续沿用`labs/playback/vendor/README.md`。

## 对照与计量

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$env:PWTEST_DAEMON_SESSION_DIR = 'O:/CodexVideoBuild/tmp/playwright-worker'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:/CodexVideoBuild/tmp/playwright-transform'
node vedioServer/labs/playback/run-cache-probe.mjs `
  --binary O:/CodexVideoBuild/target/debug/examples/playback_lab.exe `
  --source <至少2秒的H264及可选AAC素材> --cli <playwright-cli.js> `
  --output <新的非C盘目录> --trace worker --packaging single `
  --entries 65536 --repetitions 2
```

固定single封装、整片加载、无缓存直通，每组同一页面连续播放两次，
各次到媒体位置1.25秒销毁播放器和工作器。两档网络为60毫秒、
120000/48000字节每秒，第二轮完整倒序。每素材8组、16次播放。
不是预取媒体、长期保留工作器、热会话复用或页面无缝切换的实验。

主库及页面在点击前不限速加载，播放授权、工作器和媒体在点击后的模拟网络内。
CLI初次打开后会重载并开始计量，`bootstrap`只覆盖被观测重载，
不含CLI首次打开的那份相同主库。两种候选这项额外开销相同，
不能将bootstrap称为整个会话的全部下载，冷页面完整起播也没有测量。

父页面CDP可以看到外部工作器请求开始，但本机未收到正文及完成事件；
所有正式收据的工作器CDP正文总量为`null`，不能补为0。
底层原始请求事件中未增长的计数只是未观测值，不能单独用于带宽结论。
Rust `/lab/metrics.worker_script`单独记录静态GET响应次数和正文预算：
`yielded_body_bytes`在构造静态响应时累加待交付字节，不保证已经发到客户端，
不代表线路、完成下载或浏览器总字节。HEAD不增加GET正文预算。
浏览器实际`init`事件、无错误和变化解码画面另行确认工作器可用，
媒体停止后检查初始化的线程全部终止、源与响应体回收。

汇总器`summarize-workers.mjs --run <目录> --output <新文件>`按素材、速率、轮次与第几次播放配对，
分别记录主库/页面CDP正文、媒体CDP正文、控制CDP正文和工作器服务端响应预算，
不把它们加总成已实收线路流量。

## 实验取舍

两种合成素材，共16组、32次播放；16次外部播放各构造一次118366字节工作器响应，
16次内置播放均无外部工作器请求和响应，线程仍真实初始化并在停止时销毁。
同一页面第二次播放也重建工作器，避免以悬挂线程换取快启动。
内置候选与外部候选均使用相同623915字节主库，没有增加bootstrap库下载。

在本机无缓存外部路径下，内置候选的配对平均首帧提前约1.0秒（120000字节/秒）
和2.5秒（48000字节/秒），两种素材及两次播放方向一致。
每个条件仅2次重复，没有统计显著性、生产P95、主线程/解码完整CPU、RSS或功耗结论。
媒体实收也有少量差异，仍按同观看位置保留，不能写成总下载恰好减少118366字节。

**适用条件**是同一主库已经携带工作器，且原外部路径要额外取得脚本。
本实验禁用浏览器缓存且全部响应为`no-store`；已经正确缓存的外部工作器、
HTTP压缩、不同主库构建、CDN和原生播放器都可能改变取舍。
因此原默认保留，新增显式复用候选，不做普适性能排名。
首次计量失败与修正过程保留在评估中。

证据见[内置工作器评估](../../vedioServerRefer/problem-space/embedded-worker-evaluation.json)。
