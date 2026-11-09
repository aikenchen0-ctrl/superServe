# 直播视频编码契约

版本v1，2026-11-07。适用于Web、Android、iOS共同的实时媒体入口。
可选Opus音频另见[live-opus-profile-v1](live-opus-profile-v1.md)，视频仍为每房间单一编码。

## 首发编码

受控媒体支持两种单编码房间：

```text
VP8
H.264 Constrained Baseline
  profile-level-id=42e01f
  packetization-mode=1
  RTP clock=90000, channels未设置
```

同一房间的发布者先确定编码，所有订阅者必须匹配发布者的编码和H.264参数。
有效单路offer与当前发布编码不兼容时，在创建Rtc前返回409；
无效媒体形状或发布编码不支持时返回400。
旧匿名模式仍可使用VP8实验；生产启用仍要求凭据和房间控制边界。

服务端复用编码帧并映射payload type，不解码、不转码；
H.264去封包和重新封包由str0m完成，不在业务层自行重写码流。
level-asymmetry-allowed可随offer出现；无论是否出现，固定level仍需相同。
编码器和设备解码器负责实际画质、码率、功耗和关键帧产生。
H.264兼容性不能解释为所有设备都支持硬件编解码。

## 协商边界

服务端复用str0m 0.25.0的CodecConfig和PayloadParams匹配。
H.264只接受固定profile、level和packetization-mode；VP8与H.264均要求90kHz时钟、无音频声道字段。
不依赖上游允许的任意level降级，因为本服务没有转码或能力重写。
发布者和订阅者的RTP payload type可以不同，由str0m的参数匹配完成映射。

不支持：

- H.264参数不一致的跨订阅混合；
- VP8发布者与H.264订阅者混用；
- H.264与VP8在一个房间的多轨混用；
- HEVC、AV1、VP9作为当前首发实时媒体编码；
- 编码转换、simulcast、多码率联动和录制转码。

客户端实验页用`?codec=vp8`或`?codec=h264`选择单编码，并先收窄浏览器能力。
Android/iOS应使用原生WebRTC能力查询和同一编码参数，不用WebView替代真机验收。

## 验证

真实同机Chrome单发布两订阅已验证H.264：

- 三次POST均201，回答中均出现H264；
- SDP fmtp均为`profile-level-id=42e01f;packetization-mode=1`；
- 三条连接均connected；
- 发布者和观看者统计均为640×360；
- 两观看者均有实际解码帧和变化画面；
- 三次DELETE均200，停止后active_peers=0。

这只是Chrome回环合成帧，不证明Android/iOS、跨网、TURN、采集到显示延迟、
CPU/RSS、功耗、线路字节或整体三低收益。
