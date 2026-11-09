# iOS媒体观测请求头适配

`TraceRequestHeaders.swift`只复用Foundation的`URLRequest`公开入口，
在存在合法32位小写非零观测ID时设置`x-vs-trace-id`，没有合法值时保持原请求。

该字段只用于媒体交付观测关联，不替代`traceparent`，不参与Bearer、播放能力、
缓存键、CMCD、候选排序或播放授权；它不创建span，也不修改Rust播放状态和票据。
它没有重写AVPlayer、HLS解析器或网络栈，不新增Rust或Swift第三方依赖。

## 当前边界

- 这是可复用的Swift请求辅助，不是XCFramework、Swift Package或正式App集成。
- AVPlayer/AVURLAsset没有在本轮被强行接线；若应用没有可注入`URLRequest`的网络层，
  需要单独设计`AVAssetResourceLoaderDelegate`并承担范围请求、重定向、重试和取消成本。
- 不使用未经公开文档和SDK绑定核验的任意AVURLAsset选项，避免把私有或历史行为当稳定接口。
- HLS重定向/重试、后台、切网、真机请求收据和解码仍未验证。
- 服务端授权、播放能力和缓存规则保持不变；只有合法授权的媒体请求才有资格被观测。

`TraceRequestHeadersTests.swift`只覆盖本地URLRequest字段规范化反例，不证明播放器接线、网络传播、
屏幕渲染、功耗或三低收益。编译与真机回执必须使用固定Xcode/SDK、真实网络和独立留出。
