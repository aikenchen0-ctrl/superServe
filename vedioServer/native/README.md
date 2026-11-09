# 原生播放控制绑定

通过固定UniFFI `0.32.2`将既有`vs-core::PlayerAdapter`和`TimeBufferControl`暴露给Kotlin和Swift。
这是共享状态接口，不是播放器、HTTP客户端、WebRTC SDK、AAR或XCFramework。
网络、渲染、媒体散列校验、实际取消和追加仍由平台拥有。

新增[Media3消费者](android/README.md)，针对官方1.11.1公开接口编译，
实际类和DefaultLoadControl在宿主经生成绑定调用Rust。
仅将时间门用于原起播允许后的普通点播；不伪造LoadControl没有提供的分片长度、
每轨区间或追加证据。返回false不代表当前网络请求取消。
Android实际播放/设备仍未验，不改变Web或服务端默认。

Android Media3消费者还提供可选的`TraceRequestHeaders`窄适配，将合法的
`x-vs-trace-id`交给`DefaultHttpDataSource.Factory`；它只做交付观测关联，不参与授权、
缓存或CMCD。当前源码、消费者编译和本地APK结构验收已就绪，Android真实网络请求、真机播放和iOS仍未验。

## 边界

- `BufferPolicy`固定时间与字节预算，语义继续使用原Rust内核。
- `PlayerObservation`报告同一时间线的每轨连续区间、单调时间、状态和字节；
  每轨最多128区间、1至8轨，时间至多24小时，缓冲与单次预留至多512MiB。
- `NativePlayer.update`可返回`DownloadTicket`，调用者不得无票据下载；
  同一对象至多一个预留，不允许凭状态推测已有任务已回收。
- 下载完成只进入等待追加；`appended`收到真实新快照才替换预算。
- 暂停、隐藏、跳转返回取消票据，但不会自动取消平台任务。
  平台确认网络或追加任务结束后再调用`release`。
- 切换内容/不连续跳转用`changeGeneration`，旧票据不释放新请求预算；
  另一个对象的票据也不匹配。票据无公开构造器，字段不可变。
- 同时调用返回`Busy`，不排队；锁中毒返回`Unavailable`，不得恢复未知状态。
  平台应串行提交快照并按错误类型处理，不无限重试。

FFI中的集合先由生成代码分配再受业务预算检查。
调用者是可信同进程宿主，不是恶意输入隔离层；不能把原业务预算当跨语言内存沙箱。
生成器自身内存/句柄/ABI规则继续由固定UniFFI负责，未复制改写。
错误中的领域原因可能含原有英文标识符，不能作为稳定机器协议。

## 隔离与许可

独立Cargo工作区与锁文件，不将生成`unsafe`代码、JNA或生成器并入服务端。
原服务端`unsafe_code=forbid`和锁文件不变。运行库不默认启用`bindgen`。
源码改编与MPL-2.0全文见`NOTICE.txt`和`LICENSE-MPL-2.0`。
Android消费者本地接线与测试使用Apache-2.0，完整许可沿用`../LICENSES/media3-Apache-2.0.txt`。
生成代码和动态库必须使用相同固定版本及同一接口；升级后重新生成并跑实际调用。

Kotlin生成路径使用JNA；首轮宿主验证固定`5.12.1`，保留为历史实验记录。
后续[Android草稿](android/aar/README.md)固定官方`5.19.1@aar`，
已检查两层arm64库和封装消费，但尚不是生产准入。Android仍需验证16KiB设备、
APK打包压缩/对齐、R8保留规则和目标运行；ELF对齐不能推导APK也通过。
Swift源、C头和modulemap已生成，尚无Apple工具链编译、签名或真机收据。

## 宿主复验

先加载`D:\CodexVideoTools\enter.ps1`；首次取依赖需显式联网，
之后`verify.ps1`只按独立锁文件离线构建，不自动升级或下载。

```powershell
& 'vedioServer/native/verify.ps1' `
  -OutputDirectory 'O:\CodexWorkspaces\superServe-video-b4be\.artifacts\native-new' `
  -KotlinCompiler '<既有kotlinc.bat绝对路径>' `
  -JnaJar '<O盘固定JNA JAR>' `
  -JnaSha256 '<固定SHA256>'
```

不提供Kotlin三参数时，只验Rust和实际Python动态库调用。
所有输入、生成文件、JVM临时库提取、测试JAR和输出均写O盘；
本机编译器可只读使用，不创建C盘Gradle/Android缓存。
JVM验证不是Android运行时。Python仅作开发验收，不进入线上栈。

## Android交叉构建

本轮复用本机NDK `28.2.13676358`和配对Rust `1.96.0`的Android标准库；
目标标准库只解包在O盘独立sysroot，没有安装到C盘或D盘rustup。
脚本不下载工具，使用明确输入和新的O盘输出目录：

```powershell
& 'vedioServer/native/build-android.ps1' `
  -Sysroot 'O:\CodexVideoBuild\native-cross\rust-std-1.96.0-aarch64-linux-android\rust-std-aarch64-linux-android' `
  -NdkRoot '<本机NDK根目录>' `
  -OutputDirectory 'O:\CodexWorkspaces\superServe-video-b4be\.artifacts\android-new'
```

只构建arm64/API24的未优化实验库，核对AArch64/动态库/16KiB加载段。
该交叉脚本不自动生成APK/AAR或连接设备，也没有iOS二进制；
本地AAR由独立`android/package-aar.ps1`封装，仍不是正式发布。
设备首帧、后台、切网、耗电、功耗和三低仍为独立验收门。
