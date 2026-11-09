# 无屏障播放联合对照

<重表述提示词为问题>取消人工尾部屏障后，片内封装与播放器流式消费能否在相同观看轨迹下降低起播或卡顿，并让新增正文和处理成本保持可接受？</重表述提示词为问题>

本入口沿用Rust发布、播放授权、媒体路由、OpenDAL对象源及固定hls.js 1.7.4，
增加相同消费轨迹与独立计量，不改变生产默认。
受控源站在播放器开始读取前释放屏障；不能将本结果与此前1200毫秒尾部屏障时间混算。

## 复现

```powershell
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$env:PWTEST_DAEMON_SESSION_DIR = 'O:/CodexVideoBuild/tmp/playwright-natural'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:/CodexVideoBuild/tmp/playwright-transform'
node vedioServer/labs/playback/run-cache-probe.mjs `
  --binary O:/CodexVideoBuild/target/debug/examples/playback_lab.exe `
  --source <至少6.2秒的H264及可选AAC素材> --cli <playwright-cli.js> `
  --output <新的非C盘目录> --repetitions 2 --trace natural `
  --packaging single,500 --entries 65536
```

`--trace gated`仍为默认，沿用旧屏障合约。`natural`报告为
`natural-playback-comparison-v1`，单次浏览器收据为`natural-playback-trace-v1`。
两档模拟网络为60毫秒、120000或48000字节/秒；媒体读取前才启用模拟，
已加载的页面、hls.js主库不含在起播冷下载中，工作器和播放授权仍在测量路径中。
正文只汇总凭据播放路径，不含工作器脚本；首帧却包含工作器加载，
因此本轮不能以该正文代表客户端全部下载，也不能独立归因首帧瓶颈。

自然轨迹只使用`direct`服务端路径，避免同时改变缓存和封装。
播放器整片/渐进配置与`single/500`封装形成四种组合；
每种在1.25秒滑走与6秒连续观看两种动作中运行，第二轮完整倒序。
一份素材共32组。所有进程、缓存、浏览器上下文重新创建，不热启动复用。
源素材必须足够长；超时、失败或轨迹不满足时明确保留失败，不算作零卡顿成功。
两档条目默认列表仍可用，但无缓存时该配置不形成不同媒体处理，应显式固定一档。

## 行为和真实性检查

- 浏览器用帧回调，在媒体时间达到目标后立即停止，允许最多150毫秒采样误差。
  不按墙钟时间停止，以免更慢起播被误算为更短观看。
- 校验已播区间与停止位置一致，避免跳转或重复观看伪造相同轨迹。
- 记录0.5秒和停止时的非空变化像素，不把网络成功当作解码成功。
- 源站、缓存填充、媒体响应和读取许可在停止后回收；CDP取消事件结算后再次检查无新增请求或正文。
- 原播放页面及`web_xhr_body`消费标签保持原实现。新探针不提交用户画像、训练或消费标签。
- 迟到授权代次检查继续保留。停止后不得追加、呈现或重新启动媒体读取。

## 计量

| 观测 | 含义与限制 |
| --- | --- |
| `first_frame_ms` | 点击后到首个视频帧回调，含签发、工作器、媒体加载与追加，不是屏幕出光 |
| `stall_ms` | 首帧后的`waiting`至`playing`或停止，排除初次起播、暂停和seek；不等于完整QoE模型 |
| `client_cdp_body_bytes` | 指定播放凭据路径请求的CDP `dataLength`之和；包含音视频、初始化及改签清单，不含页面库和HTTP/TLS |
| `source_http_body_bytes` | 内存HTTP源产出正文，可能在浏览器滑走前已进入传输缓冲；不等于客户端实收 |
| `service_yielded_bytes` | Rust媒体路由产出的正文；与源站、CDP分别记录，不混成线路流量 |
| `media_requests` | 绑定凭据播放路径的请求次数，按CDP事件记录；重试和取消保留 |
| `usage.deltas` | CDP主渲染器累计任务、脚本、布局时间差；不含完整工作器、解码、GPU或进程CPU |
| `JSHeapUsedSize` | 端点V8堆用量；没有调用强制GC，不是浏览器RSS或峰值 |
| `server_process.cpu_delta_ms` | 同一Rust媒体与内存源站合并进程的CPU累计差，检查PID和启动时间一致；包含收尾，排除封装启动，分辨率有限 |
| `working_set_bytes` | 服务进程测量前后端点工作集，另留生命周期峰值；不能直接归因封装或当作严格内存上限 |

资源观测采用现有CDP和PowerShell系统接口，不新增运行依赖。
PowerShell子进程显式输出UTF-8，Node以UTF-8流解码，避免中文说明受宿主代码页影响。
不把缺失指标设为0，报告null表示不可用。CPU毫秒的系统量化和主机其他负载会影响短样本。
本轮网络仅在Chrome侧模拟，内存源站没有真实WAN延迟或真实S3磁盘竞争；
因而不能据此选择生产集群容量、存储扩容参数或原生设备功耗。

## 评价

同一素材、速率、动作和相对顺序下比较，不跨素材直接求总平均；
明确分别观察起播、卡顿、正文、源站和处理开销，保留一项变好另一项变差的组合。
每个组合两次重复仅为描述性对照，不宣称统计显著、生产尾延迟或总体三低达成。
是否扩大默认取决于更多真实素材、原生设备、弱网和总体成本的联合证据。

`summarize-natural.mjs --run <运行目录> --output <新报告>`会核对收据指纹，
按同一素材、速率、动作和轮次与`single/whole`基线配对，
报告均值、范围、缺失数量和逐对差值；不根据已观察结果改变参数或补挑有利样本。

CDP协议参考固定到`ChromeDevTools/devtools-protocol`提交
`b0d96c6cdf39e5583e67a3762b2815a33154455b`的`json/browser_protocol.json`。
该参考将`emulateNetworkConditions`标记弃用，建议新接口组合；
本轮为了保持前后实验方法一致，继续执行本机Chrome支持的原接口，
没有把协议master当作本机浏览器版本的完整实现。后续迁移模拟方法应单独验证。
参考文件与BSD许可保存在本轮证据目录，不引入到运行依赖中。
