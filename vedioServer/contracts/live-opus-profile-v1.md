# 直播可选Opus音频契约

版本v1，2026-11-07。补充live-codec-profile-v1和live-sdp-http-v1。
三端目标为Web、Android、iOS，当前实现仍只在回环实验使用。

## 轨道与编码

一个会话必须包含一条视频，另可包含一条Opus音频：

- 视频沿用VP8或固定H.264参数。
- 音频使用Opus、48kHz RTP时钟、channels=2。
- 音源限单声道；拒绝显式stereo=1或sprop-stereo=1。
- channels=2是Opus RTP映射，不能据此推断实际音源是双声道。
- 不支持音频RED/RTX、混音、音频转码、纯音频会话或第二条音频。

媒体节顺序不限，MID按每个会话独立维护。
服务器从已解析SDP和配置的PayloadParams选择编码，不手写音频/SDP解析器。
发布/观看仍使用一份原有直播凭据，同一Rtc、资源Location和租期管理全部轨道。
权限与角色含义不变，不因增加音频而扩大用户/房间范围。

订阅者可以只观看视频，不接收源音频；
视频单轨源不允许凭空建立带音频订阅，返回409。
音频参数、方向、媒体形状不符时拒绝整个请求，不创建部分成功会话。
单媒体节和双媒体节都须完成ICE收集，每节answer标记end-of-candidates。
PATCH仍405，不提供Trickle或新增音频轨的在线重协商。

## 发送与缓冲

str0m提供Opus去封包、重新封包、参数匹配和独立SRTP发送。
业务层复用编码数据Arc；保留原RTP时基和talkspurt标记，不解码或混音。
每订阅连接仍有自己的发送、SRTP及拥塞成本，不是复制一次就无额外传输。
本轮不传播音量/语音活动等额外RTP元数据，不将totalAudioEnergy当作解码真相。

视频队列保持8帧、每帧至多256KiB；音频另保留16包、每包至多1KiB。
音频队列满时丢弃最旧包以接收新包；视频队列满时拒绝新视频帧并请求关键帧。
音频排出优先于本轮视频，但两路都受有限上界约束。
服务端音频发送缓存显式32包；这些是实验预算，不能解释为时延或进程RSS承诺。
1KiB上限低于当前固定str0m默认MTU扣除SRTP后的负载预算，
避免上游Opus packetizer把一包任意拆分。不支持全部Opus合法最大包长或任意MTU配置，
改变str0m版本、RTP扩展或MTU时须重新检查该边界。

新增/lab/metrics计数：

- active_audio_codec：当前发布者有Opus轨时为opus，否则null。
- audio_packets_received、audio_packets_forwarded：音频数据进入/提交发送的次数。
- audio_payload_bytes_forwarded：提交给各订阅连接的编码音频字节总量。
- dropped_audio_packets、audio_queue_peak_bytes：音频排队丢弃与逻辑正文峰值。

原encoded_frames_*继续只统计视频。UDP计数仍是正文，不能冒充物理线路字节。

## 生命周期与验证

观看者到期或撤权同时移除其音视频；其他观看者继续。
发布者到期、撤权或退出按原规则清空房间，排空清除全部Rtc和两类队列。
续权不重建轨道；音频不创建额外的分布式所有权或媒体线程。

实验页用`?audio=opus`添加440Hz合成单声道，不调用麦克风、不向扬声器播放。
验收使用接收端实际Opus RTP、解码采样计数和WebAudio波形/频谱。
音量元数据缺失时Chrome的totalAudioEnergy可为0，不能据此认定静音；
同样不能只凭该统计有值就认定人耳收到有效语音。

当前保留接收时刻作为转发墙钟、原媒体RTP时基。
没有校准发送者时钟漂移、采集端偏移或绝对捕获时间映射，
不宣称严格音画同步、会话切换时无缝同步或真实采集到扬声器延迟。
Android/iOS音频会话、音频焦点、后台、AEC、真实语音、弱网/PLC/FEC、
硬件功耗、TURN及物理多机仍须独立验收。
