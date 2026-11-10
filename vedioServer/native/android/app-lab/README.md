# 独立Android播放实验

只用于固定合成MP4和独立包名`org.superserve.playback.lab`。
应用调用发布Media3 `1.11.1`、固定JNA `5.19.1`和已验Rust库，
采用官方Media3 Demo的`onStart`创建、`onStop`释放方式。
没有重新实现解码器、提取器、网络层或Rust业务状态。

## 当前结果

完整arm64/API24、target35 APK已生成，含本地素材、实际Media3运行模块、
自有AAR的class、Rust/JNA原生库和对应资源。
SDK36的D8 `8.10.9`、APK签名验证和`zipalign -c -P 16`通过；
无网络或存储权限，临时实验签名，不是生产签名。
APK内附原Rust/UniFFI源码归档、实验Activity源码以及原许可/依赖自带通知。
这是官方SDK工具构建，不声称Gradle/AGP或R8已验。

当前Activity源码还包含可选的`x-vs-trace-id`和`x-vs-request-id`请求头接线：
`TraceRequestHeaders`通过Media3 `DefaultHttpDataSource.Factory`传递服务端观测关联字段。
当前消费者源码与本地APK编译、签名和结构已验，但实验包没有网络权限且只播本地asset；
不能据此声称Android网络传播或真机证据。

2026-11-09曾取得一台在线API36/arm64设备租约，
该设备当前页大小4096。首次安装被设备拒绝：
`INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`。
实验包和进程均不存在，租约已释放；没有修改USB安装保护或系统设置，
没有重复安装或绕过限制。**尚无Android运行、Rust/JNA加载或播放通过结论。**

下一次设备实验必须由用户明确允许该安装后再执行。
不能默认认为旧租约仍有效，也不能在未准备设备时自动安装。
不改其他应用、用户数据或安全选项，不以4KiB设备证明16KiB运行。

## 模式与结果

- `baseline`：原Media3加载策略。
- `rust`：同一发布播放器附加`RustTimeLoadControl`。
- 两模式都会先实际调用Rust时间控制探针，防止基线完全避开JNI库加载。
- 固定`asset:///source.mp4`，静音，不接收URL/凭据或访问公网。
- 首帧回调、视频解码器名、播放进度至少2500ms、无错误且释放完成才允许通过。
- 20秒内结束并写入本应用私有目录，唯一`run_id`不覆盖旧结果。
- 页面离开即释放；初始/播放失败如实记录，不把UI启动当解码。

单次首帧时间、缓冲转换和本地文件运行不证明质量提升、网络带宽、
设备功耗、后台恢复、切网或真实用户注意，也不是基线/候选性能排名。
当前应用不验证WebRTC直播、远程HLS、推荐策略或画像效用。

## 构建

`build.ps1`要求固定文件/资源摘要，现有Kotlin与Android SDK只读使用；
所有下载、APK、临时签名和输出留O盘，拒绝覆盖旧目录。
复用发布库全部MP4路径相关模块和资源，不手写或删除解析器绕过缺依赖。
JNA Java/JNI和Rust库沿用上轮固定输入；consumer AAR不含重复依赖。

```powershell
& 'vedioServer/native/android/app-lab/build.ps1' `
  -InputsManifest '<O盘android-player-app-inputs-v1清单>' `
  -KotlinHome '<既有Kotlin根目录>' `
  -BuildTools '<既有SDK build-tools 36.0.0>' `
  -OutputDirectory '<本工作区.artifacts下的新目录>'
```

`verify-inputs.ps1`检查拒绝旧输出、旧D8、资源摘要变化和过期租约，
过期租约用例在调用ADB前失败，不访问真实设备。

## 有授权的设备运行

由调用方先通过当前协调工具取得设备租约。
`run-device.ps1`要求匹配设备、有效期至少剩90秒的租约记录，
检查固定APK摘要和同包名不存在，拒绝替换既有应用。
成功安装后仅读取本应用收据与有限进程日志；
运行器最终强停并卸载本轮应用，确认无残留，不卸载其他应用。
调用方无论成功失败都必须释放设备租约。
运行器不请求绕过安装保护，不操作安装确认按钮或修改系统设置。

```powershell
& 'vedioServer/native/android/app-lab/run-device.ps1' `
  -Serial '<已授权设备>' -Apk '<O盘APK>' -ApkSha256 '<固定摘要>' `
  -Adb '<现有ADB路径>' -LeaseRecord '<当前租约记录>' `
  -OutputDirectory '<新的证据目录>'
```

## 来源与分发

Activity生命周期结构参考官方Media3 `1.11.1` Demo `PlayerActivity.java`，
本地窄实验代码以Apache-2.0提供，沿用`../../../LICENSES/media3-Apache-2.0.txt`。
Rust/UniFFI的MPL及其他第三方来源继续适用，详见原AAR源码归档和
仓库`THIRD_PARTY.md`。本APK只是未收缩本地实验，未完成生产分发许可审核。
