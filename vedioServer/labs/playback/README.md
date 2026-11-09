# 浏览器播放实验

可显式设`VS_LAB_WORKER_MODE=embedded`，让已有播放页面复用固定hls.js主库中的Blob工作器；
原`external`默认保留。`--trace worker --packaging single --entries 65536`对照两次连续播放，
核对线程初始化/销毁和外部响应，详见[工作器代码复用](../../contracts/embedded-worker-v1.md)。

运行器新增`--trace natural --packaging single,500 --entries 65536`：
读取前释放源站屏障，在两档CDP模拟网络下比较1.25秒滑走与6秒连续观看。
独立记录首帧、卡顿、客户端正文和服务资源；原XHR消费标签保持不变。
复现与指标边界见[无屏障播放对照](../../contracts/natural-playback-trace-v1.md)。

封装新增显式`VS_LAB_CHUNK_MS=250/500`，复用sheathe在原HLS对象中写入多个媒体片段。
对照脚本可加`--packaging single,250,500 --entries 262144`；原缺省保持single。
本轮36组中8组在末字节阻塞时提前出帧，小素材6组仍不出帧。
取舍、预算和接口见[HLS片内封装](../../contracts/hls-chunks-v1.md)。

缓存起播新增独立探针`/lab/cache-probe`：通过显式`VS_LAB_CACHE_PROBE`开启，
比较整片与公开`progressive`加载、两档缓存条目，以及首个视频末字节屏障前的真实帧。
原播放页面和XHR消费计量保持原路径，不将Fetch计数混入XHR。
配置、复现和因果边界见[缓存起播因果对照](../../contracts/cache-playback-probe-v1.md)。

第一方入口复用既有Rust媒体路由、内容寻址发布与正文生命周期观测，
浏览器原样复用固定hls.js发布包。内部令牌只在进程内分派时注入。
仅监听`127.0.0.1`，核对Host、Origin及跨站请求，不开放业务写接口。
这是隔离实验入口，不能直接部署为公网匿名媒体网关。
可选普通HLS直播固定连接本机Xiu的`live/lab`房间。

## 启动

在`vedioServer`目录构建：

```powershell
cargo build --locked -p vs-service --example playback_lab
```

在仓库目录启动：

```powershell
./vedioServer/labs/playback/run.ps1 -InputVideo <H.264和可选AAC的MP4路径> -TargetDirectory <Cargo目标目录>
```

输入受既有封装器约束，包括32MiB上限。脚本生成新发布目录，打印本机URL和进程号，
并写入启动收据；端口默认自动分配。结束实验时按收据中的进程号停止该实例。
页面支持播放、原生控件暂停/恢复、停止及导出JSON。

## 观测与边界

- 首帧指标来自`requestVideoFrameCallback`，不是物理屏幕出光时间。
- `playhead_seconds`是当前位置；`played_ranges`是浏览器报告的已播放区间，
  不把跳转后的位置或下载成功当观看时长、可信曝光。
- XHR统计包括清单、初始化段、音视频分片及重试实收正文；
  取消请求按最后进度事件计量，可能漏掉未分派进度的数据。
  不含HTTP头、TLS和线路重传，原生HLS不提供这项XHR测量。
- 每轮最多保存256条明细，超过后仍保留总字节和省略数量。
- `pause`实验策略会调用`stopLoad()`，`play`恢复加载；短暂停顿可能导致重复下载，
  因而不能把取消成功直接解释为节省带宽。
- 上述行为保留为默认`baseline`。点播新增`keep_inflight`和`small_window`两个显式候选：
  暂停时调用固定hls.js的`pauseBuffering()`，恢复时优先`resumeBuffering()`。
  正在下载的片段可继续完成；停止、切换和页面离开仍销毁播放器。
  直播保持基线行为，原生HLS不应用这些hls.js参数。
- 为隔离浏览器缓存，本实验响应统一`no-store`；没有测量CDN、共享缓存收益。
- 默认三个候选仅使用hls.js参数；可选`rust_time`接入下文的Rust时间控制，仍不包含
  `PlayerAdapter`的票据/追加确认、Rust字节预算或ABR。
- 不自动写入用户画像或训练标签。服务端下发量与客户端实收量分别保留。

## 浏览器验收

先用Playwright CLI打开启动URL，再执行`verify-browser.js`。
该文件是CLI的`run-code`输入，不是`@playwright/test`测试套件。
Windows批处理可能破坏复杂JavaScript引号，可直接使用`node.exe`调用已经安装的
`@playwright/cli/playwright-cli.js`，把文件全文作为单个参数。

验收使用Chromium的CDP网络模拟：60毫秒延迟、120000字节/秒下载。
检查非空变化像素、暂停取消、恢复出帧、停止下载和390像素布局，
截图输出到仓库的`output/playwright/`。
单次首帧数值只说明该次环境，不作性能门槛或收益排名。

## 同观看过程的策略对照

`run-comparison.mjs`通过既有Playwright CLI执行`verify-trace.js`，
启动并清理独立Rust实验进程，逐组保存结果和失败。运行前必须加载非C盘环境：

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$env:PWTEST_DAEMON_SESSION_DIR = 'O:/CodexVideoBuild/tmp/playwright-policy-new-run'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:/CodexVideoBuild/tmp/playwright-transform'
node ./vedioServer/labs/playback/run-comparison.mjs --binary <playback_lab.exe> --source <MP4> --cli <playwright-cli.js> --output <尚不存在的非C盘目录> --repetitions 2 --smoke
```

固定候选分别为：原有4/6秒参数并中止暂停请求、同参数但保留在途片段、
2/4秒参数并保留在途片段；三者字节参数均为512KiB。
这些是hls.js时间/大小参数，不是严格缓冲上界、内存上界或Media3滞回。
同素材分别执行1.25秒暂停800毫秒后看到6秒、看到1.25秒即停止。
两档下载速率为120000和48000字节/秒，模拟延迟60毫秒；
动作在浏览器内按媒体位置触发，容差150毫秒，第二轮倒序执行策略。
这里只控制当前内容前向缓冲，没有下一条视频预取。

页面资源在限速前就绪，媒体启动和工作器加载在模拟网络中进行；
首帧包含这些启动成本，XHR正文计数不包含工作器脚本。
客户端正文、服务端产出差值、重复资源路径、暂停期间字节、卡顿及许可回收分别保存。
重复路径早期尝试的字节不直接等于线路浪费；已播放区间不构成可信观看。
结果必须保留失败和反例，不能按同一小素材的结果持续调参再宣布生产优胜。
此前三策略对照仅复用固定hls.js公开接口，没有绑定Rust控制器。
下节新增可选的Rust时间控制；Android/iOS仍未绑定。

## Rust本地时间控制

`vs-playback-web`使用固定`wasm-bindgen =0.2.130`生成浏览器外壳，
实际判断复用`vs-core::playback::TimeBufferControl`和既有Media3移植逻辑。
控制器只接收连续缓冲毫秒数与千分位倍速，保存每个对象自己的滞回状态。
未知缓冲字节不填零，媒体字节参数和起播仍由hls.js负责。

先准备当前Rust工具链的`wasm32-unknown-unknown`目标及对应版本的wasm-bindgen CLI，
再生成独立产物：

```powershell
./vedioServer/labs/playback/build-wasm.ps1 -WasmBindgen <wasm-bindgen.exe> -OutputDirectory <尚不存在的非C盘目录>
```

启动`playback_lab`前设置`VS_PLAYBACK_WASM_DIR`到生成目录。
未配置时Rust候选禁用，资源路由返回404；配置错误时启动失败，不静默回退。
仅接受固定文件`playback.js`和`playback_bg.wasm`，分别限制128KiB、512KiB。
入口只在启用资源时增加`wasm-unsafe-eval`，不开放JavaScript的`unsafe-eval`。

`rust_time`每个播放对象读取一次`/lab/policy`，核对目录和策略指纹；
指纹用于一致性检查，不是密码签名或新的权限来源。
随后在浏览器本地运行Rust时间判定，通过hls.js公开接口暂停/恢复新分片调度，
不发送逐分片决策请求。反馈来自`video.buffered`，按当前位置选择连续区间，
不把累计下载字节或跨缺口的时间段当作可播放缓冲。
当前实验每100毫秒及分片追加后检查，完整分片可能跨越高阈值；
临时暂停不取消在途片段，停止、自然结束和致命错误时释放对象与定时器。
跳转时重置滞回并先解除取片暂停，避免等待新数据才能触发`seeked`的依赖循环；
定位完成后重新应用时间控制，暂停中的定位会重新暂停后续取片。

复用原对照工具验证，参数示例：

```powershell
node ./vedioServer/labs/playback/run-comparison.mjs --binary <playback_lab.exe> --source <MP4> --cli <playwright-cli.js> --output <新实验目录> --policies keep_inflight,rust_time --wasm-dir <生成目录> --repetitions 2 --gate-check --lifecycle-check --smoke
```

`--gate-check`独立使用300000字节/秒、持续观看12秒，验证阈值确实触发、
边界错误、重置、倍速及对象隔离。它不参与两档网络的收益汇总。
`--lifecycle-check`另验高阈值暂停后跨缓冲跳转、自然结束、策略切换、对象重建和
公开错误事件注入后的回收；错误注入只验证控制器回收，不是真实解码故障证据。
新增控制资源正文通过同源Resource Timing单列，包含策略、JS外壳和Wasm；
同时输出媒体正文加新增控制正文，避免只比较媒体字节掩盖冷启动代价。
Wasm线性内存只是模块的内存空间，不等于进程RSS或浏览器总内存。
Android/iOS仍未绑定；不能将此Web实验当作完整跨端SDK。

## 直播候选探测

`probe-xiu.ps1`接受显式Xiu、原生FFmpeg和MP4路径，动态分配端口，
有界推流8秒、检查HLS清单并清理两个实验进程。
它记录失败与成功事实，不把FFmpeg退出码0当成直播消费成功。
Xiu原生实验进程可能监听所有网卡，只应在隔离开发环境短时执行。
同一探针验证：v0.14.0默认HLS初始化失败；v0.13.0生成清单且未崩溃。
两个版本同报`XIU 0.13.0`，选型必须核对发布标签、源码提交和二进制指纹。

## 接入直播

实验根为Xiu v0.13.0官方Windows发布物，源码提交
`dffca6e682a6e444b090ff2b700c191453f1082d`，许可证副本位于
`../../LICENSES/xiu-MIT.txt`。当前没有修改或重新编译Xiu内核。

```powershell
./vedioServer/labs/playback/start-xiu-live.ps1 -XiuBinary <固定Xiu路径> -Ffmpeg <原生ffmpeg.exe路径> -InputVideo <MP4路径> -OutputRoot <新实验目录>
./vedioServer/labs/playback/run.ps1 -InputVideo <MP4路径> -TargetDirectory <Cargo目标目录> -LivePort <启动收据中的hls_port>
```

启动器校验固定二进制SHA256，默认循环推送180秒合成或指定素材。
页面“来源”可切换点播与直播。直播只转发`lab.m3u8`和数字命名TS，
不接受任意URL、房间或浏览器凭证；禁用上游重定向、自动重试和系统代理。
8个读取许可随响应体存活，正文按块转发；清单上限128KiB、片段上限8MiB，
单次上游读取超时8秒。这些是实验预算，不是生产参数。

`verify-live.js`核验清单序号推进、非空运动画面、手机布局、直播切回点播的代次隔离、
停止下载和许可回收。新验收截图带时间戳，避免覆盖先前收据引用的文件。

清理实验：

```powershell
./vedioServer/labs/playback/stop-xiu-live.ps1 -LaunchFile <Xiu启动收据launch.json>
```

停止器先核对进程号和启动时间，拒绝误停已复用的进程号。
推流到时退出后，Xiu本身仍需要清理。直播结束后，可不带`-LivePort`重新启动点播入口。
本轮直播实验已清理；常驻的本机入口只启用点播。

该版本为普通MPEG-TS HLS，约5秒分片，不能以播放器首帧回调推断采集到显示的延迟。
WebRTC、LL-HLS、房间路由、鉴权撤销、录制恢复与物理集群仍是独立准入问题。
详细数据见参考目录的《Rust直播根复用与浏览器互操作》。

## 签名点播授权实验

页面点播现通过`POST /lab/playback`申请临时签名地址。
本机适配只为固定测试主体和素材签发，不接收客户端自报的主体/权限；
生产调用仍须经过真实用户网关。每次启动生成临时签名密钥，重启会使旧凭据失效。
子清单、初始化段和分片由生产Rust授权内核改签，页面观测与导出遮蔽凭据部分。
`/v1/media`的本机实验代理仍用于对照，不是生产匿名读取许可。

`run-access-contract.ps1`启动两个独立服务进程，分别签发和读取，
用FFmpeg验证HLS子资源无需服务请求头，检查到期和内部匿名路径拒绝，最后回收进程。
输入应使用本实验产生的`browser-lab-v1`发布目录。
真实用户登录、Android/iOS客户端、共享消费事件及生产撤权仍未接入。
# 真实浏览器消费至原始证据

2026-11-09增加显式本机合成持久化接线，不改变默认规范化入口。
先加载`D:\CodexVideoTools\enter.ps1`并构建`playback_lab`，
再执行`run-consumption-browser.ps1 -InputVideo <O盘MP4绝对路径>`。
运行器创建新目录、真实Chrome与受控HTTP消息夹具，验证检查点/尾批、
显式重传、未签发实例拒绝、原始快照、重建字节及进程端口回收。
默认素材路径仅为已有合成夹具，可用参数替换。

默认运行器不连接真实Iggy进程，不证明物理持久性或集群，
也不证明原生Android/iOS、真实用户和三低收益。
范围、预算及失败未知语义见`../../contracts/playback-consumption-persistence-v1.md`。
历史实验说明如下。

## 真实Iggy组合恢复

`run-consumption-iggy.ps1 -LaunchFile <已清理O盘Linux来宾收据>`
显式复用既有来宾和固定broker，创建独立流、显式持久主题及分离账户。
它调用相同浏览器验收，但消息不经HTTP夹具；播放后只读验证正常停止、
确认后强杀及两次重启的主题身份、原始消息和消费重建一致。
须先构建`playback_lab`、`snapshot_feedback`、`replay_consumption`和`feedback_log`。
结果在新的`.artifacts/consumption-iggy-*`目录，历史证据不覆盖。
写者读取元数据会继承消息读取权限，不称严格只写；root令牌不交播放进程。
同机软件仿真仍不是物理多机、断电、真实用户效果或三低基准。

