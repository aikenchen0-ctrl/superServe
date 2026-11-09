# 媒体到协调面的只读mTLS

日期：2026-11-08。仅扩展媒体进程核验分配的出站读取，
不开放媒体HTTP、SDP信令、UDP或自动排空连接器。
Web、Android和iOS终端不能持有此服务证书或内部Bearer。

## 身份与权限

各协调节点的`tls`可增加：

```json
{
  "media_reader_sha256": {
    "media-a": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

字段默认空，最多64个逻辑媒体node_id到leaf DER SHA256的映射；
ID须合法、指纹唯一，且不能与协调节点或运维角色混用。
材料由部署人员提供，示例指纹不能用于实际连接。
所有配置端点应分发一致的只读身份名册；遇到403不会绕过权限去猜测其他身份。
读取身份配置仍不进入房间数据库策略锁；空映射不改变原身份摘要的序列化内容。
身份从真实TLS证书获得，不接受HTTP头自报角色。

该角色只允许`GET /v1/room-assignments/{tenant}/{room}`，
仍须原内部Bearer与准确Host；不允许Raft、管理、metrics、原始房间或名册读取，
也不允许POST、HEAD等其他方法。
服务先确认线性一致性，再读取记录；只有当前owner.node_id与证书绑定逻辑节点一致才返回，
无归属、归属他人或不存在时403，不返回其他节点的分配正文。
非领导者或失去多数派时仍按原权威读规则失败，不能用本地metrics替代。

证书绑定的是逻辑node_id，不是一次媒体启动代次。
媒体端仍逐项匹配cluster、tenant、room、完整target/incarnation及revision；
本地排空下界不因TLS成功而重置。

## 媒体配置

`VS_LIVE_ROOM_CONTROL_CONFIG`原结构增加可选`coordination_tls`，
见[占位配置](media-authority-mtls-v1.example.json)。
原回环HTTP配置无需新增字段。
启用TLS时，`coordination_endpoints`使用`https://SocketAddr`形式的固定根地址，
不接受域名、路径、尾斜杠、用户信息、查询或片段；
实际服务名称由`coordination_tls.server_names`逐地址映射，一一对应且唯一。
只允许明确回环、RFC1918或ULA，不能因配置TLS就开放公网。

客户端复用独立`vs-tls`的材料和固定目标构造，
同一实现在运维CLI和协调网络中使用，不依赖OpenRaft、redb或媒体运行时。
按配置CA和DNS名称验证服务端、固定解析到SocketAddr，TLS 1.3/HTTP/1.1，
不额外信任系统CA，不代理、不重定向、不自动HTTP重试或降级明文。
本地验证ClientAuth、有效期、leaf摘要和明确私钥匹配，
每文件最多64KiB、证书链1至4张。

沿用原4个在途验证、2秒总期限、连接200ms/单请求500ms、8KiB应答预算，
不按本机成功反推生产SLO。该链路只在控制验证时读取，不增加逐帧共识请求。
配置材料不是终端登录或用户JWT，缺少权限时不能拿运维证书替代。

## 保留的安全边界

mTLS保护身份与传输，不把权威读取和本地激活变为分布式原子事务。
原“媒体排空确认后才释放归属”和本地版本下界继续必需；
本轮未修改`MediaRelease`，其出站排空仍仅回环HTTP。
主节点切换不是自动房间抢占，失去多数派只拒绝新的激活核验，
不宣称自动终止所有已存在媒体会话；原凭据期限与执行状态继续生效。

生产签发、撤销、热轮换、物理分区、媒体反向控制TLS、原生客户端和总体三低均未验收。
后续跨机媒体监听必须另行界定信令、内部控制和UDP目的地范围，
不能直接取消现有回环判断。

## 复测

```powershell
& 'O:/CodexWorkspaces/superServe-video-b4be/vedioServer/labs/media-authority/run-mtls.ps1' `
  -CoordinationIp 172.18.16.1 -SkipBuild
```

省略`SkipBuild`会先离线构建三个相关包的所有目标，
构建前检查O盘容量并加载既有D/O盘工具环境，不回退C盘。
`SkipBuild`仅跳过独立程序构建，Cargo仍会校验或增量编译测试目标。
指定地址必须实际属于本机且在允许范围；默认使用127.0.0.1。
脚本要求唯一结构化回执，避免过滤器匹配零测试却误判成功。

实验为3个协调进程和1个真实媒体进程、同一台机器；
验证只读身份、新版本激活、杀主、排空后显式释放再分配、
旧版本409、失去多数派503及进程/UDP资源回收。
没有建立RTC会话或播放视频，不是三台物理机、自动排空或性能实验。
跨包用例默认标记为需独立二进制的实验，由脚本显式执行，
普通回归中的ignored记录与独立执行结果分别保留。
