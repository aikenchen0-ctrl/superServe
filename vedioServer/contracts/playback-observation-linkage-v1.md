# 播放联合观测契约

2026-11-07。该契约把推荐决策、播放授权、媒体请求和客户端消费放进同一条可复算链路。

## 关联链

```text
recommendation request_id
    -> durable decision_id + returned candidate_id
    -> signed playback-decision receipt
    -> playback grant playback_id + decision_id + request_id
    -> CMCD sid=playback_id, cid=candidate_id, vs-rid=request_id
    -> client-consumption interaction_id=playback_id
```

推荐接口只有在学习日志已接收决策后，才返回`X-Playback-Decision-Receipt`。
收据绑定目录指纹、主体摘要、决策标识、推荐请求、实际返回候选列表和短期过期时间。
客户端不能生成或修改收据，播放授权服务校验收据后才回传决策关联字段。
直接播放授权不带决策字段，保持兼容。

## 客户端声明与可信事实

- `playback_id`是服务端随机播放实例，不是用户身份。
- CMCD字段和浏览器帧回调属于客户端观测声明，不是观看证明。
- `WebVideoFrameCallback`只说明浏览器产生了帧回调，不能证明物理屏幕出光。
- XHR正文累计字节只表示浏览器可见的应用层响应正文，不含协议头、TLS、重传或系统缓存。
- 暂停/停止先停止加载，再等待在途请求结束，随后封存消费批次，避免把取消时的尾部字节丢失。
- 首帧、进度、卡顿和字节进入`client-consumption-v1`规范化器；默认实验入口不持久化。
- 2026-11-09新增显式本机合成模式：`VS_LAB_FEEDBACK_CONFIG`可转交原反馈持久化接口，
  仅接受当前服务器登记的播放实例，检查点和尾批可进入固定原始快照与重建。
  该模式不是生产消费JWT入口，详见`playback-consumption-persistence-v1.md`。
- 消费批次仍需可信网关签发的消费JWT才能进入正式反馈入口；浏览器实验的`subject`和来源只用于本机验证。

## 当前实现边界

CMCD复用固定hls.js 1.7.4控制器提供的`sessionId/contentId`结构，
只设置第一方`vs-rid`扩展并继续使用现有Rust `sfv`子集解析。
没有引入CMCD v2事件、逐分片服务端控制、浏览器日志持久化或推荐质量自动回写。
推荐候选的真实性来自服务端决策日志和签名收据，不来自CMCD。

这是成本归因基础，不是三低收益结论。需要同一trace比较无预取、固定窗口和动态窗口，
并同时记录首帧、卡顿、实际消费字节、服务端产出字节、CPU/RSS和推荐覆盖。
