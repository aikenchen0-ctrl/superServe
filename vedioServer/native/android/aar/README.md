# 本地Android库草稿

通过现有SDK和编译器将已验Media3消费者打包为标准AAR。
当前只有本地草稿，没有Gradle发布模块、兼容性基线、正式版本或远端仓库。
不能把本目录打包器当成AGP/Maven发布替代品。

## 内容与依赖

自有AAR包含：

- 固定生成Kotlin和Media3消费者的`classes.jar`。
- `jni/arm64-v8a/libvs_playback_native.so`。
- API24清单，不额外申请权限、不声明Activity。
- `proguard.txt`保守保留规则及完整许可/来源。

不嵌入JNA/Media3/Kotlin class或JNA原生库，不含宿主DLL和测试。
与AAR一同交付`dependencies.json`、`sources.zip`、`HANDOFF.txt`和摘要收据。
依赖清单不是Maven POM或Gradle模块元数据，不会被`files(...)`自动解析；
消费者必须明确添加依赖：

```kotlin
dependencies {
    implementation(files("libs/superserve-playback-local.aar"))
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("net.java.dev.jna:jna:5.19.1@aar")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.1.21")
}
android {
    defaultConfig {
        minSdk = 24
        ndk { abiFilters += "arm64-v8a" }
    }
}
```

该片段为后续实际消费者提供输入，不代表AGP解析/打包或真机已经运行。
JNA必须使用Android AAR而非仅桌面JAR，且只与匹配的`libjnidispatch.so`组合。
本轮固定JNA5.19.1，由官方变更和制品核验选用，
不推导其对所有设备/业务都最强。正式消费者应锁定传递依赖并执行依赖冲突审查。
保守保留规则会保留窄绑定和JNA，体积与收缩收益未测；R8行为尚未验。

## 离线打包

`../package-aar.ps1`只读取带SHA256的固定输入清单，不自动联网或下载工具。
输出须为本工作区`.artifacts`下的新目录；已存在即拒绝。
手工编辑的清单只能由可信构建操作者交付，摘要不证明来源授权。

```powershell
& 'vedioServer/native/android/package-aar.ps1' `
  -InputsManifest '<O盘android-aar-inputs-v1清单>' `
  -KotlinHome '<现有Kotlin根目录>' `
  -AndroidBuildTools '<现有SDK build-tools 36.0.0>' `
  -ReadElf '<现有NDK llvm-readelf.exe>' `
  -OutputDirectory '<本工作区.artifacts下的新目录>'
```

Kotlin2.1至少要求D8/R8 8.6.17。
本轮使用SDK36.0.0的D8 8.10.9；旧SDK35的D8 8.6.2即使退出0，
仍有无法解析Kotlin元数据的反例，不算通过，打包器现在提前拒绝。
编译器的JDK弃用警告如实保留，不宣称所有工具无警告。

## 验收范围

打包器固定文件顺序及ZIP时间，同一输入封装两次摘要一致。
这只是本地封装确定性，不保证不同JDK/编译器/源码构建的制品一致。
从AAR重新提取class后编译真实`ExoPlayer.Builder.setLoadControl`消费者；
用这些class在宿主调用配对Rust DLL。
D8处理消费入口、自有绑定、JNA Android class和Kotlin stdlib；
Media3仅作为classpath，因此生成DEX不是完整可运行应用。
检查Rust与JNA arm64库均为AArch64 DYN及16KiB加载段，
不把此事实扩展成APK ZIP对齐、签名、设备加载或页面尺寸运行证明。

没有APK、AAR正式候选上传、消费者升级事件、AGP合并、R8收缩或Android解码收据。
正式发布前需干净确定提交、配置运行根/Gradle发布流程、完整依赖及许可复核、
实际消费者和真机验收。不能用当前脏目录草稿冒称某个HEAD的发布制品。

`../tests/verify-package-inputs.ps1`实际检查拒绝覆盖、旧D8、错误SHA256及宿主库替代；
拒绝后原制品不变且新目标不生成。源码归档包含原native/vs-core源码、锁文件和许可，
可在解包目录独立执行锁定离线`cargo check --lib`，但不证明跨环境字节复现。
