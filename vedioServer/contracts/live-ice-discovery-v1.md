# 终端ICE配置发现契约

日期：2026-11-08。受控私网实验，Web、Android和iOS共用HTTP语义；
本轮只验证Rust HTTP客户端与Chrome，不代表原生SDK或真机已经接入。

## 配置

仅在显式`VS_LIVE_SIGNALING_TLS_CONFIG`中增加可选`client_ice`。
省略时保持原行为；不把配置挂载到回环诊断入口，也不启动新的管理服务。
原HTTPS入口仍要求JWT、RoomControl、明确证书及来源边界。

```json
{
  "client_ice": {
    "expires_unix_seconds": 0,
    "servers": [
      {
        "url": "turn:10.0.0.5:3478?transport=udp",
        "username": "replace-at-launch",
        "credential": "replace-with-random-secret-at-launch"
      }
    ]
  }
}
```

这是待合并到原配置的结构片段，0刻意不能直接运行。
必须使用当次受信启动器生成的未来至多300秒期限，且与实际TURN服务授权相符。
配置总读取上限仍为16KiB，1至4个唯一地址，必须是明确IPv4私网/回环UDP TURN、
1024至65535端口；无DNS、自动跳转、公网、TCP/TLS、IPv6或任意URL参数。
用户名1至64、密码32至128可见ASCII，反斜杠与双引号按quoted-string转义。
配置不逐请求访问外部提供者，不是生产签发服务。

## 共同流程

1. 终端已有正确用途的`vs-live+jwt`，按发布或观看角色选择`/whip`、`/whep`。
2. 支持后置ICE配置时可读取成功POST的`Link`；不支持时，可在首次ICE收集前发
   带Authorization的`OPTIONS`。本轮浏览器显式选后一兼容路径。
3. 将多个`Link`头按HTTP语义处理，解析`rel="ice-server"`、`username`、
   `credential`和`credential-type="password"`，交给原生WebRTC的ICE配置。
   不能按逗号或分号直接切分引号内密码。
4. 兼容路径须在`setLocalDescription`或原生等价操作之前完成配置。
   失败即中止该次创建，不匿名回退、不自动重发POST。
5. 后续SDP、Location、ETag、PATCH、DELETE仍按原契约；Location是不透明随机资源，
   不编码主体，也不允许从它推导权限。

响应例子中的凭据只用于说明字段：

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Accept-Post: application/sdp
Link: <turn:10.0.0.5:3478?transport=udp>; rel="ice-server"; username="user"; credential="example-only-password-not-for-use"; credential-type="password"
X-VS-ICE-Expires: 0
```

`X-VS-ICE-Expires`是本项目客户端使用期限提示，取JWT与配置期限较小者。
单调期限与墙钟到期任一成立，后续发现拒绝；不以墙钟回退续长配置。
该提示不能缩短TURN服务中共享密码的实际寿命，也不能替代密码轮换或撤销。

## 身份与返回边界

| 请求 | 是否返回TURN配置 |
| --- | --- |
| 有效角色JWT的端点OPTIONS，非预检 | 媒体线程检查分配版本、撤权与到期后返回 |
| 有效JWT成功创建POST | 再核对返回Location的同来源、房间前缀、角色及实际资源主体后返回 |
| 匿名、错角色、旧版本或已撤权 | 拒绝，无Link |
| CORS预检，即使带Authorization | 只返回方法/请求头许可，无Link和期限 |
| GET/HEAD、资源OPTIONS/GET/DELETE、失败响应 | 不返回TURN配置 |

发现不创建媒体会话、不占发布者槽位；现有4条媒体命令队列预算仍生效。
响应前的再检查以原媒体队列为授权顺序，不新建第二套撤权数据库。
发现开启期间，创建成功后资源消失或撤权会拒绝凭据交付；已创建但未交付的资源
仍由原租期/撤权/房间回收处理，不能因错误响应自动重发。

浏览器只向明确HTTPS信令根发送已有JWT，预检不含共享凭据。
精确允许来源才可读取`Link`及期限，响应`no-store`；
服务端Link值标记为敏感，不把凭据写入状态摘要、命令行或浏览器夹具。
已授权终端获得密码是协议本意，不能声称它看不到密码。

## 限制与复测

RFC9725第4.6节允许OPTIONS兼容分支，但不推荐可后置配置的客户端无条件增加往返。
本轮每连接增加一次发现及可能的预检，不宣称降低首帧时延。
默认直连不启用发现，不增加请求。当前有限JavaScript解析器只承诺本配置输出子集，
不是通用RFC8288解析器。

短寿命共享TURN密码独立于用户JWT，已交付的密码可能仍可分配至TURN授权到期。
JWT撤权仍阻止媒体及新发现，不能据此声称TURN即时按用户撤权。
生产还需独立签发、主体配额、轮换/撤销和服务端真实到期联动。
公网、TCP/TLS、IPv6、切网ICE重启、Android/iOS真机及物理多机仍待验。

固定参考为MediaMTX `ef25331963fb31e3db368e191c573f60d26b1a73`的Link处理与预检分离，
转写Rust和有限JavaScript，不引入Go/Pion服务；完整许可和范围见`../LICENSES/mediamtx-NOTICE.txt`。
脚本`labs/webrtc/run-signaling-browser.ps1 -Relay`现用受保护发现而非夹具注入密码，
验证实际relay和解码；不加Relay验证旧默认直连。
独立进程、TLS、私网和原身份约束见既有对应契约。
