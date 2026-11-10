# Media3时间控制消费者

显式候选，针对官方Media3 `1.11.1`公开`LoadControl`接口编译。
Rust业务仍复用`TimeBufferControl`；Kotlin只作平台语义和生命周期接线。
它不是完整PlayerAdapter接线，不要求伪造分片长度、每轨区间或追加回执。

## 为什么只接时间

Media3的回调提供`bufferedDurationUs`和`playbackSpeed`，
但没有每轨区间、下一分片字节或网络/追加任务所有权。
因此不能把`DefaultAllocator`占用当媒体下载字节，更不能填0伪造已回收预算。
完整`NativePlayer`继续留给能提供真实证据的自有加载器。

`RustTimeLoadControl`只在以下条件下参与：

- 固定单个播放器、同一播放线程，普通非动态点播，已知period。
- 原Media3 `shouldStartPlayback`已返回true；返回false时立即解除时间门。
- 非广告、非重缓冲、非未来period、无直播偏移，时长/速度在Rust已支持范围。

结果为`原shouldContinueLoading && Rust允许`，不绕过原分配器/预算拒绝。
起播结果完整返回原Media3值；重缓冲/直播等不增加时间门。
period改变、位置倒退、轨选择、停止及释放均重置；
未获新起播允许时不会因较低高水位阻止必要加载。
时长向下取整到毫秒，速度向上取整到千分位。
FFI错误则在本次prepared生命周期禁用附加门并保留原播放器策略。
不自动重试、不写用户状态、不增加每分片服务端RPC。

策略仍可能使普通播放发生不同的预取/卡顿取舍，没有默认启用和收益结论。
返回false只限制后续加载决策，不证明正在进行的下载已取消，
也不提供严格分片字节、进程内存或线路带宽上限。
前后台策略、用户暂停的取消与Media3网络回收仍待单独验收。

## 接入示例

Android消费者准备同版生成Kotlin、Android `.so`及JNA后，
在创建播放器时显式使用：

```kotlin
val control = RustTimeLoadControl(
    DefaultLoadControl.Builder().build(),
    minimumMs = 2000u,
    maximumMs = 4000u,
)
val player = ExoPlayer.Builder(context).setLoadControl(control).build()
```

## Android媒体观测关联桥

`TraceRequestHeaders`是一个窄适配：它接受服务端返回的32位小写非零观测ID和最多64位
请求标识，并将合法值放入Media3 `DefaultHttpDataSource.Factory.setDefaultRequestProperties`
的`x-vs-trace-id`和`x-vs-request-id`请求头。没有该值或值不合法时不添加对应请求头。

该字段只用于媒体交付观测关联，不替代`traceparent`，不参与Bearer、播放能力、缓存键、
CMCD、候选排序或播放授权；它也不创建span、不保存主体和不改变媒体请求的失败语义。
当前使用重新生成的UniFFI绑定通过13组Media3宿主场景，实验APK也已签名与16KiB对齐验证；
它仍是无网络权限的本地素材包。只有Web Chromium+hls.js取得真实媒体请求头收据，
Android网络请求收据、真机解码和iOS仍未通过。

数值只是实验参数，不代表全局最佳。每个播放器独占实例；
播放器负责在其播放线程调用，不能由应用UI线程手动调用加载方法。
`onStopped`与`onReleased`继续委托Media3并关闭本地Rust句柄，
无静态全局播放器表或残留后台任务。

## 可重跑宿主验收

`verify.ps1`要求带SHA256的固定输入清单，
只读Media3发布JAR、JNA、Guava和Android SDK `android.jar`，不自动下载。
生成绑定与DLL必须配对，所有输出留在O盘新目录。
它编译消费者JAR，并使用发布包的真实`Parameters`/`DefaultLoadControl`调用Rust。
Android SDK桩仅支撑宿主类链接，不提供设备行为、解码、音视频或网络证据。

```powershell
& 'vedioServer/native/android/verify.ps1' `
  -InputsManifest '<O盘固定输入清单>' `
  -GeneratedDirectory '<同轮生成绑定与DLL目录>' `
  -KotlinHome '<本机Kotlin编译器根>' `
  -OutputDirectory '<本工作区.artifacts下的新目录>'
```

13组场景覆盖起播、时间滞回、原预算拒绝、回退、period与倒退、
线程/播放器隔离、生命周期显式转发、真实DefaultLoadControl及微秒/倍速取整。
未prepare就停止/释放仍转发，不以附加状态阻止原清理。
Java默认方法必须显式转发，不能依靠Kotlin接口委托省略。
不含AAR/APK、R8、Android运行、真实Media3播放、JNA Android加载或功耗证明。
Swift/Apple和生产存储、集群、推荐效用继续是独立验证门。

## 本地AAR草稿

新增[封装说明](aar/README.md)与`package-aar.ps1`，自有AAR不重复嵌入JNA/Media3，
另交依赖清单、源码归档和摘要。Android侧固定JNA5.19.1官方AAR，
历史JNA5.12.1的宿主验证记录不覆写。
已验证提取AAR后编译消费者、宿主绑定调用及SDK D8处理，
同时核验Rust和JNA arm64两层库的16KiB加载段。
当前dirty工作区只生成本地草稿，不是正式AAR候选或完整APK，AGP/R8及真机仍未验。

## 独立应用实验

[app-lab](app-lab/README.md)已产出完整本地素材实验APK，
含实际Media3模块、资源、固定Rust/JNA库和源码/许可资产，
签名验证与APK原生ZIP对齐通过，不声称AGP/R8已验。
2026-11-09首次真机安装被系统返回`INSTALL_FAILED_USER_RESTRICTED`，
没有绕过保护；无残留实验包，租约已释放。
须用户明确允许该实验安装后才可取得实际播放证据，当前仍无设备运行通过结论。
