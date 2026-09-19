# New API 完整压测：操作入口

mock 和压测工具是两个独立服务。压测命令不会创建、更新或删除 EC2，
不会自动修改 New API 渠道，也不会触发真实上游付费测试。
但必须由你确认测试渠道及失败回退均指向 mock，脚本无法代替这项确认。

## 第一次准备

先按 [mock 服务说明](../new-api-aws-infra/doc/mock-service.md) 完成部署和 New API 测试渠道配置。以下仅说明本地压测和报告；监控采集仍需本地 AWS Profile。

1. 使用 `infra` 仓库 `mock/connection.local.json` 中 `profile` 指定的 AWS 登录。当前本机已配置 `474632926374_AdministratorAccess`，无需重新找同事建 Profile。临时凭据到期时，从原 AWS 登录入口获取新凭据并更新 `~/.aws/credentials` 中同名 Profile；不要复制到压测 `.env`。
   尚未配置的新电脑可以配置 `new-api-aws-infra` Profile：
   如果公司使用 SSO，同事提供 SSO start URL 和角色后，执行：

   ```bash
   aws configure sso --profile new-api-aws-infra
   aws sso login --profile new-api-aws-infra
   ```

   不使用 SSO 时让同事按公司的方式配置同名 Profile；不要把密钥发到聊天或写入仓库。
   现有生产 GitHub Actions 登录不能直接代替本地登录。

2. 确认 infra 项目的 `mock/connection.local.json` 指向已部署实例。本地启动脚本会生成它；Actions 在远端生成的文件不会自动同步到本机，首次需同事配置对应实例、结果桶、域名和本地 Profile 后再发压。

3. 在本项目目录配置 `.env`：已有文件直接编辑，不覆盖。
   `BASE_URL` 填 **New API 的入口地址**，不是 mock 地址；`API_KEY` 填
   New API 专用测试令牌；`MODELS` 填该账号可用的测试模型名称。
   若已有 `API_KEYS`，它优先于 `API_KEY`，也必须换成测试令牌。
   配置后确保先做 smoke。真实 Key 不会写入报告。

## 每次压测

在 `performance-testing` 目录运行：

```bash
bash run-aws.sh smoke
```

确认 smoke 的协议、模型和路由正确，再逐步升压：

```bash
STRESS_START_VUS=2000 STRESS_MAX_VUS=6000 STRESS_STEP_DURATION=3m WARMUP_DURATION=15s \
  bash run-aws.sh stress
```

当前本机 `.env` 使用 2,000、3,000、4,000、5,000、6,000 VU 五档，每档 1 分钟、升档 10 秒，预热 10 秒；最后用 10 秒降回 2,000 VU，再观察 1 分钟恢复（`STRESS_RECOVERY_DURATION=1m`）。直接 `bash run-aws.sh stress` 使用这组配置。发压约 6 分 50 秒，另有请求排空和监控等待。mixed 使用 `MIXED_VUS=2000` 实际固定并发，持续 1 分钟；longstream 固定 `LONG_VUS=2000`，持续 2 分钟。配置峰值不代表已经验证的服务容量。

复测重点：比较首档和 `recovered_steady` 的成功率、P95、TTFT，以及 PG 连接数和各主机资源是否回落。上一轮 1,200→2,400 VU 时成功吞吐约 162→170 请求/秒，P95 从约 11 秒增加至约 30 秒；PG 连接达到 300，与三台应用配置的每台 100 个连接上限一致，但仅凭该现象无法证明连接池等待。先保留服务端配置，用完整观测复测，再决定是否调整连接池或 SQL。

启动时会打印 `AWS_METRICS=1, STREAM_METER=1`。普通 `run.sh` 也会读取 `.env`；当 AWS 监控开启且未显式设置 `STREAM_METER` 时，自动开启首字及本地资源测量。AWS 登录或 mock 开始快照失败会在发压前停止。出现 `ExpiredToken` 表示需刷新上述 Profile，不是 New API 性能问题。

如需提前停止，按一次 Ctrl+C 后等待报告收尾，不要关闭终端或反复中断。报告会保留未结束请求，并将未跑完的测试标为不能用于容量验收；这些请求不等于服务端失败。首字测量代理使用 Node fetch 到 New API 的连接，不能将其传输表现与 k6 直接连接的 HTTP/2 测试视为完全等价。

请求返回 401/403 时会在保存该请求结果后自动停止，报告显示已识别的脱敏错误原因（例如 `insufficient_user_quota`）；unknown 表示没有可识别原因，不保存原始错误正文。其他失败请求会等待 1 秒后才开始下一次迭代，防止快速拒绝导致错误风暴；因此失败时的实际请求速率包含这段退避。不要将无限额令牌等同于账号钱包或订阅也无限额。

2026-09-18 21:43 这轮已在 CloudWatch 确认大量 `预扣费额度失败`：示例账号余额 `$0.001950`，单请求需要 `$0.008212`。需要在 New API 后台调整测试令牌所属账号的钱包余额；令牌无限额度不会绕过账号余额检查。按该次预扣额，6,000 同时请求仅预扣约 `$49.27`，还应覆盖整轮累计消耗和余量。该值取决于模型和价格配置，不是通用充值金额，也不表示 AWS 费用。只对隔离的 mock 测试账号操作。

网络统计在独立子进程采集，异常会标为数据缺失；CPU/内存等本机数据每 5 秒保存。若测量代理退出，执行器自动停止 k6 并继续生成报告。`*.runner.json` 记录停止原因。启动前的 AWS 权限/占用锁失败仍会阻止发压，保存 `*.aws.json` 错误记录。

报告不会整块读取终端日志。请求事件超过 64 MiB 或首字明细超过 32 MiB 时，自动使用 Python 标准库 SQLite 在临时磁盘关联请求，再以有界内存汇总。计数、分档和吞吐仍精确；大文件模式下分位数为直方图近似上界，误差不超过 `0.1% × (1 + 数值)`，报告会明确标注。需要留出原始数据数倍的临时磁盘空间，数百万请求生成报告可能需要数分钟。原始数据和逐请求明细保留，可事后重新生成。

脚本自动安装固定版本 Node 依赖，申请 mock 测试占用锁、记录 mock 版本和参数，
启动 localhost 流式测量进程，再用 k6 发起请求。每个流式请求的首个非空正文时间
和内容事件停顿按请求 ID 合并，不用 TTFB 冒充 TTFT。

压测结束后，脚本会多等约 **4 分钟**：两分钟恢复观测，加两分钟 CloudWatch
数据入库等待。随后由 mock EC2 上独立采集程序读取生产指标，通过 S3 下载到本地。
无需 SSH、数据库连接或生产 API 密钥。等待结束前不要删 mock 或强制关闭终端。
两分钟不是 AWS 数据完整性保证，晚到或缺失的数据会在报告中标注。

终端最后显示 `HTML report: logs/....html`，双击该文件即可打开。
同目录还保留 Markdown、请求明细、AWS 原始 JSON、mock 前后快照及本地资源数据。
HTML 不加载外部脚本、字体或网络资源，复制文件即可查看。

如果 AWS 采集失败，仍生成压测报告并明确显示缺失，不自动判定通过。
SSM 开始阶段失败则不发压，先修复登录/权限/实例状态。
需要重试采集时，在 mock 仍运行且同一测试锁尚未释放时可执行：

```bash
node tools/aws-monitor.js end logs/实际前缀.meta.json
node lib/report-generator.js logs/实际前缀.log logs/实际前缀.json
```

锁已释放时也可查询历史 CloudWatch 数据，但结束快照可能无法重新取得；
报告会保留该错误，不把后续压测的计数冒充本轮结果。

## 测试结束后

确认报告已经下载、停止全部测试流量后，按 [mock 服务说明](../new-api-aws-infra/doc/mock-service.md) 独立更新或关闭实例。压测结束不会自动删除机器。

## 报告解释

- AWS：各 New API 节点 CPU/内存/磁盘/网络，RDS CPU/内存/连接/IO/延迟，
  Redis CPU/内存/连接/淘汰/命中计数/复制，ALB、NAT，以及 mock 自身资源。
- 分档：请求成功率、延迟、首字时间、吞吐、在途数、错误和各档资源数据。
- 首字：测量位置在本机 localhost 代理，不是浏览器渲染；只统计成功流的延迟分位数，
  失败/未完成流与首字缺失数另外保留。事件可能包含多个 token，事件间隔不是逐 token 延迟。
- 本地：主机 CPU/内存、每个网络接口和测量进程 CPU/RSS/事件循环延迟。
  本地代理可能成为瓶颈，必须结合这些数据解释高并发结果。
- CloudWatch 为分钟级，严格档内统计仅纳入完整落在窗口内的分钟；边界分钟另列参考，不计入档内均值、峰值或 Sum，不跨档相加；缺失不是零。
  ALB 无错误时某些错误指标可能根本不发布，报告仍显示缺失而不臆测零。
- PG 指标不等同 SQL 慢查询或锁等待明细；没有采集 SQL 正文、数据库凭据、真实提示词或响应正文。
- 报告不会仅凭曲线自动宣布“服务器极限”。需结合固定负载复测和恢复验证；mock 结果不代表真实模型容量。

## 权限问题交给同事的信息

日常报告身份仅需对 mock 实例发送 `AWS-RunShellScript`、读取命令状态及
读取 mock 桶 `results/*`。当前默认复用配置的本地 Profile。
Terraform 给 mock 实例 Role 添加区域限制的 CloudWatch/资源发现只读权限，
不授予生产修改或数据库连接权限。部分 AWS 监控读取 API 不支持资源级限制，
因此 IAM 限制区域、采集器限制项目资源；这不构成严格的项目级监控隔离。
