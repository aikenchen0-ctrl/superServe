# 隔离Linux实验

复用便携QEMU、Debian官方云镜像与NoCloud；第一方业务仍为Rust。
这些工具不属于线上服务依赖，不在宿主安装服务，不改WSL/Docker。
工具、镜像、虚拟磁盘、临时密钥及输出必须留在O盘。

已经实际验证：

- 固定Iggy0.9正常停止与强杀后重启、权限/持久确认和快照一致。
- 当前`vs-service`交叉Linux制品的2项进程测试。
- 原API systemd unit的verify、DynamicUser、两轮请求/日志/零退出及端口回收。

评估见`../../../vedioServerRefer/problem-space/linux-service-deployment-evaluation.json`。
TCG软件仿真、单宿主、单虚拟磁盘不作为吞吐/P99/CPU/带宽、断电或物理集群证据。

## 固定工具（不在脚本中自动安装）

- QEMU11.1.0便携提取，Debian13 `20261103-2651` qcow2；
  原始SHA512和来源见`linux-vm-iggy-evaluation.json`。
- cargo-zigbuild0.23.4 Windows制品、Zig0.15.2、Rust1.96 Linux标准库；
  独立sysroot、链接器缓存和目标目录在`O:\CodexVideoBuild\linux-cross`。
- `build-service.ps1`按现有锁文件离线构建，失败不会自动取最新版本。

## 实验入口

1. `start.ps1`新建guest，`resume.ps1 -LaunchFile ...`复用已清理的guest。
   固定回环18080/18022/18090，端口占用即拒绝，不能同时运行两个实例。
2. 来宾脚本通过显式SCP传输，核对`artifacts.sha256`后再执行；
   Shell输入需去CRLF或使用Linux行尾。宿主不共享目录。
3. `guest-service.sh <新/root/video-service-*目录>`实际执行Linux进程测试和systemd。
   单元及`/etc/superserve`/`/opt/superserve`已存在时拒绝重装；
   不删除现有日志/单元来绕过保护，失败保留目录另行诊断。
4. `run-broker-contract.ps1`使用已有Rust探针。
   `-ResumeSeed`仅接续明确通过的seed，不重发写结果未知的消息。
5. 完成后确认服务主PID为0，取回非凭据收据，执行
   `stop.ps1 -LaunchFile <当前启动收据>`回收VM和种子进程，再核对回环端口可重绑。

脚本不自动连接远程、不配置物理网络或防火墙。来宾内apt依赖安装仅属实验guest。
密钥、口令及环境文件可能仍保留在guest磁盘和运行目录，不纳入公开发布/报告；
该环境没有生产密钥轮换、删除治理或用户授权体系。
VM清理目前为显式宿主终止，不宣称来宾内核已优雅关机。

后续物理多数派故障实验至少需要3投票节点及足够独立宿主；
两个宿主可验证跨宿主协议，但并非2节点单故障容错。
没有独立资源时停止复制guest，不再扩本机控制脚本冒充集群进度。
