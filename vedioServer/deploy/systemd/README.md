# Linux API最小部署候选

本目录交付单个API角色的预生产模板，不自动安装、启用或连接远程主机。
2026-11-09已在独立O盘Debian13/QEMU来宾实际verify和运行该unit：
DynamicUser生效，两次请求及决策日志、正常停止0和同日志重启通过。
证据见`../../../vedioServerRefer/problem-space/linux-service-deployment-evaluation.json`。
这不是完整平台部署，不解除物理集群、原生终端、真实负载与生产门槛。
以下“本轮未验”段落保留为初始模板交付的历史范围，由这次实测接续。
现有C盘WSL/Docker保持不启动。第一方业务服务仍为Rust，systemd是宿主服务管理器。

## 固定职责

- 使用既有`vs-service`，只启用`api`角色和本地决策日志，不在该进程拼接媒体、画像权威或broker。
- 仅回环HTTP监听，必须置于另行验证的授权/TLS入口之后，不能原样暴露公网。
- `Type=exec`只说明程序exec成功，不说明目录、日志和依赖就绪。
- 就绪须独立请求带内部授权的`/readyz`；服务启动状态不能替代该检查。
- 业务HTTP与提交排空共用30秒预算，超时或HTTP错误返回失败，不只打印警告。
- `TimeoutStopSec=40s`和`KillMode=control-group`提供外部强制退出边界，
  非零退出由`Restart=on-failure`处理；没有`SuccessExitStatus`把失败改写成成功。
- 固定期限是本轮治理默认，不是满足业务SLO或真实磁盘故障恢复的证明。
- 异步期限不能中断同步文件系统、运行时阻塞池或内核不可中断任务；
  强杀也不保证操作系统故障中的立即回收。

## 制品与权限

在明确指定的Linux环境先执行`cargo build --locked --release -p vs-service`，
记录源码提交、Cargo.lock、工具链、目标平台和实际二进制SHA256。
初始模板交付未生成Linux制品；后续已用cargo-zigbuild0.23.4/Zig0.15.2
和Rust1.96目标标准库生成Linux debug制品并实际运行，不是release容量测试。
`../../labs/linux-vm/build-service.ps1`可用已准备的O盘工具离线复建，
不自动下载依赖。不能把Windows产物部署到Linux。
构建、下载和运行存储必须满足用户的非C盘约束。

管理员准备：

| 路径 | 要求 |
| --- | --- |
| `/opt/superserve/releases/<不可变版本>/vs-service` | 已核验Linux制品，root持有、服务用户不可写 |
| `/opt/superserve/current` | 管理员选择的已核验版本链接，服务用户不可切换 |
| `/etc/superserve/catalog.json` | 固定目录快照，服务只读；记录SHA256 |
| `/etc/superserve/api.env` | 从示例填写，root持有、0600；不可使用示例凭据 |
| `/var/lib/superserve-api` | 由StateDirectory创建，仅保存该副本自己的决策日志 |

`DynamicUser`及`StateDirectory`由宿主systemd负责，使用前须确认版本及实际目录权限。
环境文件内含内部令牌，不是秘密管理平台；管理员及进程环境仍可能读取。
不得提交实际环境文件、令牌、用户日志或将其写入命令行和公开诊断。
多个副本必须使用独立日志及唯一`VS_LEARNING_SOURCE_ID`。
当前日志有容量上限，未建立生产滚动/归档策略，达到上限会停止成功服务；
自动重启不会消除该原因，应先导出和治理，不能通过删除日志“修复”。

## 安装前的实际门

1. 核验Linux宿主/文件系统、运行盘位置、制品和目录权限。
2. 在该宿主执行`systemd-analyze verify superserve-api.service`；
   本轮没有运行systemd验证，配置文本不算通过。
3. 使用填写后的配置独立启动，验证授权`/readyz`、推荐请求及真实决策记录。
4. 执行Linux进程用例：

```sh
cargo test --locked -p vs-service --test processes \
  sigterm_drains_committed_journal_exits_zero_and_allows_restart -- --exact
```

5. 在该宿主通过systemd实际停止、重启，核对退出状态、决策日志前缀、端口和进程回收；
   真正提交故障、断电、共享依赖故障仍需另验。

Windows定向测试覆盖排空函数及真实慢HTTP流，但不能代替SIGTERM或systemd实测。
Linux专用测试在当前Windows编译目标不生成，没有声称已经验证。

## 回退边界

不提供自动回退或自动跨版本重放。切换`current`前先停止并核对真实退出，
保留旧制品与日志；候选不能读取当前日志时停止，不以覆盖/截断日志恢复启动。
版本回退还须证明目录/日志协议兼容，不能仅回退可执行文件。
当前模板没有生产负载均衡、水平扩容、容量SLO、备份恢复或跨域推荐质量结论。
