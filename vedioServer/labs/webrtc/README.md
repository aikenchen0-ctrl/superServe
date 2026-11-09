# WebRTC单房间实验

入口为独立Rust crate `vs-live`，固定复用str0m 0.25.0。
当前只验证单路VP8视频、一名发布者、两名订阅者，不是生产SFU或多机集群。
媒体协议由str0m处理，第一方代码只负责固定房间、输入预算、生命周期与编码帧转发。

在`vedioServer`目录：

```powershell
. 'D:\CodexVideoTools\enter.ps1' -KeepLocation
cargo +stable --config 'source.crates-io.replace-with="rsproxy"' `
  --config 'source.rsproxy.registry="sparse+https://rsproxy.cn/index/"' `
  build --locked -j 1 -p vs-live
$launch = .\labs\webrtc\run.ps1 -RunSeconds 300
$launch.url
```

页面“开始推流”创建合成画面和首个订阅，“增加订阅”接入第二名订阅者。
“停止”关闭浏览器连接并删除服务端会话，固定会话租期60秒，不续租。
启动器返回实际地址、PID、启动时间、二进制SHA256及`launch_file`。
实验期限为30至900秒，不注册系统服务。

停止本轮实验：

```powershell
.\labs\webrtc\stop.ps1 -LaunchFile $launch.launch_file
```

停止器核对PID、完整程序路径及UTC启动时间，只处理对应实验进程。
JSON中的ISO时间可能被PowerShell解码为日期对象，比较使用日期类型而非格式化字符串。

## 访问与资源边界

- HTTP和UDP仅监听回环，拒绝错误Host、Origin和跨站请求。
- 网页使用`POST /whip`和`POST /whep`，原始SDP正文、201及Location资源地址；
  退出先DELETE再关闭本地连接。默认完整收集，可用`?ice=trickle`启用同代次候选追加；
  仍是WHIP/WHEP草案05接入子集，
  不是完整规范实现。旧JSON接口只保留诊断，不接生产登录或消费JWT权限。
- 服务器资源标识是128位随机值；客户端将Location作为不透明地址保存。
  GET/OPTIONS、跨角色拒绝、旧进程地址和PATCH的ETag/权限/容量有独立回归。
  共同跨端契约见`../../contracts/live-sdp-http-v1.md`。
  新增受限片段契约见`../../contracts/live-trickle-v1.md`，不支持ICE重启。
- 每进程一个媒体工作线程和UDP端口，无逐连接工作线程；HTTP使用单独Tokio运行时。
- 控制队列4条，协商正文最多64KiB，HTTP等待8秒。
- 编码帧队列最多8帧、每帧256KiB；上游包/重传缓存和系统缓冲另计，不能据此宣称RSS上限2MiB。
- 原编码帧通过Arc共享；每条订阅仍需独立加密和网络发送，不宣称全链路零复制。
- 关键帧请求节流为每秒一次。这些均为实验预算，未按生产轨迹调优。
- Windows使用上游CNG后端；非Windows配置为RustCrypto，其证书链仍会引入AWS-LC。
  Linux构建和运行没有完成，不以特性名承诺全部依赖为纯Rust。

## 验证

```powershell
cargo +stable --config 'source.crates-io.replace-with="rsproxy"' `
  --config 'source.rsproxy.registry="sparse+https://rsproxy.cn/index/"' `
  test --locked -j 1 -p vs-live
```

17项Rust检查覆盖容量、方向、异常UDP、端口回收、线程退出与队列满区分、
HTTP边界、资源生命周期、无IP/mDNS候选、权限/所有者/到期、
分配接受/排空、延迟旧激活及重启后旧地址隔离。
浏览器使用既有Playwright CLI，配置位于`playwright.config.json`，
`verify-browser.js`是CLI的run-code输入，不是另一套测试框架。
运行CLI时先执行工具环境脚本，并设置：

```powershell
$env:NO_UPDATE_NOTIFIER = '1'
$env:PWTEST_DAEMON_SESSION_DIR = 'O:\CodexVideoBuild\tmp\webrtc-cli'
$env:PLAYWRIGHT_TRANSFORM_CACHE_DIR = 'O:\CodexVideoBuild\tmp\playwright-transform'
```

验收在帧回调内取像素并计算SHA256，显式轮询已读取的状态；
不能将返回Promise的谓词直接当作已满足状态。
验证一发布两订阅、画面变化、单订阅退出后另一路继续、停止归零及媒体计数稳定，
并记录三次SDP创建和三次资源删除，确认不走旧JSON入口，
截图放到仓库`output/playwright/`。
浏览器回环成功不代表Android/iOS真机、跨网、音频、端到端延迟或物理集群通过。

完整来源、反例及取舍见`../../../vedioServerRefer/Rust实时SFU根与互操作集成.md`。
后续SDP接入证据见`../../../vedioServerRefer/实时SDP接入根复用与验证.md`。

## 可选直播凭据实验

配置VS_LIVE_ACCESS_CONFIG后，固定房间、角色、目标节点及启动代次需直播专用JWT，
资源管理另检查用户所有权。匿名JSON写入口关闭；错误配置不回退匿名。
启动器支持`-AccessConfig <配置绝对路径>`，回执包含公开binding，
不包含私钥或用户令牌。配置和载荷见`../../contracts/live-access-v1.md`。

access-fixture.mjs使用Node内置crypto生成隔离测试密钥，
prepare创建资料、mint生成短期凭据、browser机械生成CLI准备输入、
probe验证两个真实进程的范围和重启旧代次拒绝。
每次使用新的O/D盘目录；工具拒绝覆盖已有密钥和输出。
准备脚本含短期凭据，留在忽略目录，运行CLI时须隐藏日志中的JWT，
不得将其纳入产品源码或源码指纹清单。

verify-browser.js验证正常一发布两订阅；
verify-expiry.js配合短期观看凭据验证到期后停止转发/呈现、发布者继续，
以及观看者DELETE 401不阻断发布者回收。不是正式签发服务或原生SDK。
最新证据见`../../../vedioServerRefer/直播权限与节点代次绑定.md`。

## 可选房间分配控制

VS_LIVE_ROOM_CONTROL_CONFIG要求已启用凭据模式，启动器支持-RoomControlConfig。
受控媒体启动时关闭新会话，可信服务激活已提交分配后才接受匹配版本JWT。
媒体排空确认先于控制面Release，版本下界阻止旧激活恢复。
端到端真实媒体复跑见../coordination/HANDOFF.md，
配置和迁移限制见../../contracts/room-handoff-v1.md。
