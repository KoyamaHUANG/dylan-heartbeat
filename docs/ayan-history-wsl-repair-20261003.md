# 阿言历史搜索 WSL 本地修复 — 2026-10-03

## 状态与边界

基线 HEAD：`5aec81af0c1b7bf28e6b1d16f195cd4310948459`（V3.2）。沿用用户已确认的生产开关、聊天及身份绑定正常事实；本轮没有访问生产，根因仍未确定。

已使用 apply_patch 在工作区创建、修改、回读并删除 `.wsl-edit-probe.tmp`，全部成功，没有编辑权限拒绝。保留原有 V1/V2/V3 工作成果及所有既有工作区改动；大量跟踪文件的原始差异是行尾差异，忽略行尾后既有内容差异集中于 .gitignore、package.json、package-lock.json。未重置或统一行尾。

没有执行历史导入、迁移、生产写入、提交、推送或部署。

## 本轮变更范围

- `archive/history_tool.js`：明确工具是直接可用的 Gateway 内部只读原始聊天检索，包括导入的 Kelivo 历史；历史核实/引用先查证，不把 Ombre 或客户端 chat_search 当成该工具结果。保留身份绑定、现有客户端工具契约、分页、两次关键词补查、十次整轮预算及不可信历史正文保护。
- `server.js`：记录资格判定的各项布尔条件，并用 Fastify 服务端 request_id 关联整个历史工具执行链。
- `archive/history_tool.js`：记录上游请求/失败、模型工具选择计数、参数拒绝、查询开始/失败/完成、结果排队继续模型、最终答复及异常拒绝阶段。日志不包含原始参数、查询词、聊天正文、历史消息 ID、绑定身份值、密钥或异常文本。工具模块日志回调失败不影响回答。
- `test/history_tool.test.js`：补充声明/提示、阶段日志、敏感内容不泄露、查询失败阶段测试。
- `test/history_tool.gateway.integration.test.js`：补充真实 Gateway 路由内的阶段顺序、request_id 关联和日志脱敏验证。

提示增强属于最小修复候选，不保证真实模型一定选择工具；日志用于区分未注入、模型未选工具、上游失败、参数拒绝、查询失败、无命中、返回后继续回答等路径。不能把本地 mock 通过视为生产故障已解决。

## Linux 运行环境与验证

WSL 原本没有 node，npm 指向 Windows Program Files。下载官方 Linux x64 Node.js v22.14.0 到 `/tmp/ayan-linux-node` 并用官方 SHASUMS256.txt 校验成功。使用绝对路径 `/tmp/ayan-linux-node/node-v22.14.0-linux-x64/bin/node` 测试，没有调用 Windows npm，也没有修改项目依赖或锁文件。

| 测试文件 | 总数 | 通过 | 跳过 |
| --- | ---: | ---: | ---: |
| test/history_tool.test.js | 25 | 25 | 0 |
| test/history_tool.gateway.integration.test.js | 6 | 6 | 0 |
| test/history_query.test.js | 7 | 6 | 1 |
| test/raw_chat_archive.integration.test.js | 5 | 5 | 0 |
| test/raw_chat_archive.test.js | 11 | 11 | 0 |
| test/proactive_sync.integration.test.js | 1 | 1 | 0 |
| test/upstream_response.test.js | 2 | 2 | 0 |
| scripts/kelivo_history_backfill.test.js | 9 | 8 | 1 |
| 合计 | 66 | 64 | 2 |

零失败。两个跳过项为现有真实 PostgreSQL 兼容测试，未配置其隔离测试数据库。八文件组合 node --test 运行通过；逐文件直接运行复核了上述用例统计。原始日志在 `/tmp/ayan-linux-node/*.test.js.log`，组合日志在 `/tmp/ayan-linux-node/regression.log`。本轮修改文件 git diff --check 通过。

## 待授权上线与验收

建议仅提交上述四个源码/测试文件及本报告，不纳入既有依赖改动、V2 工作文件或未跟踪迁移。

## 上线授权后的预检结果（2026-10-03）

用户已授权仅本次五文件提交、推送、Railway 部署与验证，并要求部署目标无法确认时停止后续变更。本轮再次完整复核四文件 diff、报告及原始测试统计；新增日志字段仅固定阶段、布尔条件、计数、HTTP 状态和服务端请求关联 ID，不输出聊天正文、API Key 或绑定身份。git diff --check 通过，暂存区为空。

通过只读 git ls-remote 独立确认 GitHub `KoyamaHUANG/dylan-heartbeat` 的 main 仍为 `5aec81af0c1b7bf28e6b1d16f195cd4310948459`，本地分支为 main。

WSL 没有 Railway CLI 或 Railway 连接器。发现本机 Windows Railway 既有登录及对应工作区的生产服务关联：project `b295b1a7-7391-46ce-8688-f6496ae6bbe6`、environment `811fba7a-0a0f-4f58-9fff-f1b5f05f5803`（production）、service `ec1ea1f2-b581-48b7-b27c-d3bc5e43f0fd`。凭据未输出、未复制到项目。使用既有 accessToken 向 Railway 官方 GraphQL API 发出只读 service/serviceInstance/deployments 查询；网络授权后返回 HTTP 403。不能据此断言凭据失效或生产异常，仅说明当前平台读取未成功。

因此尚未独立确认 Active SHA、连接的部署源/分支、健康域名以及历史部署可回滚性。按用户第 7 条要求停止发布：未暂存、未提交、未推送、未触发自动或手动部署，未访问生产数据库。回滚源码候选仍为 V3.2 基线 5aec81a 及此前稳定父提交 a47b2a9，但平台恢复可用性未证实。

继续条件：恢复可用的 Railway 平台只读/部署访问（例如本机 Railway 重新登录），之后重新执行上述平台预检再推送；现有授权仍有效，不需要逐步骤重新申请。当前不要求用户发送 iPhone 测试消息，因为新补丁尚未上线。

## Ubuntu Linux CLI 安装与认证（2026-10-03）

按 Railway 官方 CLI 文档下载并检查 `https://railway.com/install.sh`，选用用户 PATH 已有的 `/home/HRY/.local/bin`，未使用 Windows npm，也未启用安装器的额外 agent/MCP 配置。官方安装器选定 v5.63.1 x86_64-unknown-linux-musl 发布；首次下载网络中断（curl 56），续传同一官方包完成，tar 完整读取并解压成功。`file` 确认 ELF 64-bit Linux 原生静态可执行文件，`railway --version` 为 5.63.1。

WSL 独立认证状态 `railway whoami`：Unauthorized，要求 railway login。这与先前 Windows 既有登录 API 请求返回 403 是不同检查，不能把 403 确诊为项目权限不足或工具访问限制。已启动官方 `railway login --browserless`，等待用户在浏览器用原项目有权账号确认；配对链接/码不写入仓库。尚未取得新的账号身份或项目访问结果，因此未提交、推送或部署。已有测试与差异审查不重复执行。

### 登录成功后的平台预检

browserless 登录已成功，whoami 与项目列表读取成功，production 环境 canAccess=true；未再出现 403。因此已排除当前新登录账号无法读取原项目的情况；旧 Windows token 请求 403 的具体原因仍无充分证据，不宣称是账号权限或网络封锁。

更正旧本机默认关联：`ec1ea1f2-b581-48b7-b27c-d3bc5e43f0fd` 实际为 Ombre-Brain，不能用于本次发布。真实目标为原项目 strong-tenderness（project ID 不变）、production（environment ID 不变）的 `dylan-heartbeat`，service ID `3e312993-6958-4947-a58a-3ea36020d019`。全部平台操作显式指定正确服务，不修改 Ombre。

当前 Active 部署 `7aac54c9-c6cf-47ce-8aee-74e774d0d249`：SUCCESS，实例 RUNNING，commit `5aec81af0c1b7bf28e6b1d16f195cd4310948459`，repo `KoyamaHUANG/dylan-heartbeat`，branch main。实际域名 `dylan-heartbeat-production-0e18.up.railway.app` 的 /healthz 返回 `{"status":"ok"}`。API 独立确认当前部署 canRedeploy=true、canRollback=true；旧稳定 a47b2a9 部署 `165bd9fa-a9f6-4919-8392-c7e7a42fb7f0` 同样两项 true。只核验资格，没有执行回滚。

预检已满足版本、目标、健康及可用代码恢复依据；沿用用户授权仅提交本报告和四个源码/测试文件，推送 main 后先观察自动部署。生产登录凭据、平台原始元数据及临时安装文件均不进入提交。

申请授权提交、推送并部署该最小包。部署后首先核验 healthz、普通聊天和现有客户端工具；历史开关维持用户确认的已开启状态，不修改生产配置或档案数据。由用户在原会话提出一个有已知日期/ID/关键词的历史问题，关联 eligibility → upstream_request → model_response → query_started → query_completed → tool_result_queued → 下一轮模型响应，并核对最终回答的来源信息。若未选工具或查询失败，应按日志据实继续定位，不能宣布已修复。用户真实聊天验收会按现有流程正常归档，本轮不代发该生产消息。
