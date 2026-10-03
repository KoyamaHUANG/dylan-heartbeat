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

### 实际发布与验证结果

仅五文件提交 `e60227ea8f5841a38183f567835cd942c0614e71`，已推送原仓库 main。WSL Git 首次因无凭据助手失败；仅本次命令通过本机既有 GitHub CLI 的 keyring 凭据助手推送成功，没有复制 token 或修改 Git 配置。未重跑已通过测试。

Railway 自动部署 `25b165cb-a6fa-42f6-9bb2-5035de851363`，实际 Active commit 为上述修复 SHA，状态 SUCCESS、实例 RUNNING；未重复执行 railway up 或手动 redeploy。部署后生产 /healthz 为 `{"status":"ok"}`。只读变量检查仅输出布尔值：AYAN_HISTORY_TOOL_ENABLED=true、ARCHIVE_ENABLED=true，Archive 数据库/API Key 和上游 URL/API Key 均已配置；未保存或输出变量值。

旧 V3.2 部署 `7aac54c9-c6cf-47ce-8aee-74e774d0d249` 已退出 Active，API 仍确认 canRedeploy=true、canRollback=true。未触发回滚，未修改数据库、导入历史或写入 Ombre。

新 Active 部署按 ayan_history_tool 过滤的日志目前为零条，说明尚无可用于本轮验证的真实请求证据；不等于工具失效，不证明注册/模型选择/查询执行已成功。发布源码与开关满足工具接入前提，但真实注册依赖原会话双身份和合法 user_send。需要用户在 iPhone Kelivo 原阿言会话发送一次：

> 请使用 Gateway 内部工具 ayan_search_chat_history，按上海日期 2026-07-06 检索我们保存的原始聊天，先返回 1 条记录，并列出角色、时间、来源和原始消息 ID。请根据工具真实返回回答；如果未调用、执行失败或零命中，请如实说明，不要用 Ombre 记忆或 chat_search 代替，也不要调用记忆写入工具。

收到该请求后，用本次新 Active 日志核验 eligibility、模型 history_call_count、查询开始/完成/失败、结果排队及续传模型；按无调用、执行失败和 total=0 区分结论。当前尚未代发生产聊天。上述部署后结果仅追加本地报告，避免为报告文字再触发一次部署。

## 最终验收与任务关闭（2026-10-03）

### 用户功能验收：PASS

用户确认已在 iPhone Kelivo 原阿言会话实际验收：阿言成功调用历史搜索工具，返回的真实历史信息正确，功能正常。正文准确性依据用户对实际返回信息的核对；本轮没有再次读取私人历史正文，也不把日志计数当作正文准确性的独立证明。

### 独立生产日志核验：PASS

只读平台状态再次确认 Active 仍为修复提交 `e60227ea8f5841a38183f567835cd942c0614e71`，部署 `25b165cb-a6fa-42f6-9bb2-5035de851363`，SUCCESS。该部署近期日志中发现同一请求 `req-9` 的完整九阶段链路，UTC 2026-10-03 13:52:30.288–13:52:40.049（上海 21:52:30–21:52:40）：

| 阶段 | 脱敏证据 |
| --- | --- |
| eligibility | eligible=true，protocol_valid=true，user_send=true，binding_provided=true；工具/归档开启且配置齐全，无同名工具冲突 |
| upstream_request round 0 | history_used=false，开始请求模型 |
| model_response round 0 | tool_call_count=1，history_call_count=1 |
| query_started round 0 | 日期查询，无 keyword、原始 ID、cursor 或时间范围参数 |
| query_completed round 0 | total=32，returned=5，has_next_cursor=true |
| tool_result_queued round 0 | lookup_status=found，returned=5 |
| upstream_request round 1 | history_used=true，带工具结果继续请求模型 |
| model_response round 1 | tool_call_count=0，history_call_count=0，模型结束工具阶段 |
| final_answer | history_used=true，safe_evidence_seen=true |

源码中 history_call_count 仅计入函数名等于 HISTORY_TOOL_NAME（`ayan_search_chat_history`）的调用；本轮总工具调用数也为 1，且后续进入绑定身份的 historyReader.query 与工具结果回传路径。因此可独立确认是 Gateway 内部 ayan_search_chat_history，而不是 Ombre 或客户端其他搜索工具。本次不是工具未调用、执行失败或零命中；日志未见该请求的失败/拒绝阶段。结果仍有下一页，本轮不宣称已读取全部 32 条。

最初按工具名进行 CLI 文本过滤返回空结果；近期窗口实际包含结构化 event 字段，随后按该字段在本地筛选找到上述九条。该差异是日志过滤/呈现问题，不能认定为业务故障。仅输出和记录固定阶段、计数及请求关联；私人正文、查询参数值、绑定身份和凭据未进入报告。

未发现新的历史搜索故障。用户功能验收与生产调用链证据均已取得，本次修复正式结束；不重复测试、不修改业务代码、不再触发部署。验收补记留在本地现有报告，以免纯文档推送再次触发 main 自动部署。

## 再次出现不稳定后的续查与本地修复（2026-10-04）

本节是在用户新增故障证据后继续排查，不撤销上一轮 21:52 的实际成功证据。基线仍为 e60227e；本轮只授权只读诊断、本地修改和测试，未提交、推送或部署。

### 生产链路证据与分类

读取同一生产修复部署的 UTC 2026-10-03 16:55–17:10 日志窗口，即上海 2026-10-04 00:55–01:10。发现 93 条日志。对照上轮已经记录的 req-9（上海 21:52）成功链路，本轮窗口如下：

| 上海时间 / 请求 | 工具注入资格与选择 | 查询与回传 | 结论 |
| --- | --- | --- | --- |
| 10-03 21:52 req-9（上轮证据） | eligible=true；history_call_count=1 | total=32，返回5条；回传工具结果，round 1最终回答 | Gateway真实成功，不能被后续模型口述撤销 |
| 10-04 01:00 req-f | eligible=true；history_call_count=1 | total=32，返回32条，无下一页；回传模型并最终回答；HTTP200 | 本轮额外发现的成功对照 |
| 01:02:14 req-h | eligible=true；history_call_count=1 | 日期查询 total=0，returned=0，HTTP200 | 已调用且执行成功、查询零命中 |
| 01:02:34 req-j | eligible=true；history_call_count=1 | 日期查询 total=0，returned=0，HTTP200 | 同上 |
| 01:02:44 req-l | eligible=true；history_call_count=1 | 日期查询 total=0，returned=0，HTTP200 | 同上 |
| 01:03:10 req-o | eligible=false；binding_provided=false，protocol_valid=false，user_send=false | 走普通上游分支，无Gateway历史查询，HTTP200 | 本次工具未注入，原因是请求身份条件不满足 |

资格为 true 的请求经当前源码会注册 HISTORY_TOOL，且真实模型选择记录进一步证明工具收到。req-o 与该分支不同，不能误写成模型拒绝一个已注册工具。源码无按上下文长度或节点缓存撤销声明的代码。本窗口上游模型标签均为 anthropic/claude-sonnet-4-6；消息约53–54条、正文约14–16千字符，但字符数不是token数。没有观察到上游失败、循环耗尽或查询异常；各已调用查询均在round 0，成功回传后在round 1结束。不能把上下文超长或节点缓存作为已证实原因。

已证实源码缺口：日期/原始ID零命中直接safeAnswer返回固定回复，没有工具结果回传及模型继续阶段；查询异常直接503，也未向模型交付错误状态。req-h/j/l的日志路径与日期零命中分支一致。它们不是结果回传网络失败，而是原代码未进行回传。

模型“从未有工具、之前是编造”的具体措辞仍以用户报告为依据，日志不含私人回复正文，不能声称独立逐字核实。req-o缺少身份的客户端触发原因、具体上游节点/响应缓存、客户端工具能力缓存没有现成证据。生产日志未记录查询日期值，因此将req-h/j/l对应到7月7日依赖用户时间与请求描述及下方只读计数对照，不伪造其原始arguments。未注入、未调用、调用失败、零命中、回传失败和模型错误陈述分开记录；本窗口未见已注入但模型未调用的历史分支，也未见真实执行/网络回传失败。

### Raw Archive 独立只读日期核对

使用既有 /v1/archive/history API 与原阿言 assistant/conversation 双身份，鉴权仅在内存使用。仅记录摘要，不保存正文或公开原始ID。

- 上海2026-07-06：UTC `[2026-07-05T16:00:00Z, 2026-07-06T16:00:00Z)`，可检索32条，user16、assistant16，来源均kelivo_history_import，32个非空且互异原始ID，返回身份均吻合，无下一页。消息UTC范围为2026-07-05T16:08:42.250617Z至2026-07-06T00:49:07.544479Z。
- 上海2026-07-07：UTC `[2026-07-06T16:00:00Z, 2026-07-07T16:00:00Z)`，当前双身份可检索0条；include_revisions=true仍0条。
- 两个自然日查询与对应显式UTC范围查询COUNT分别一致为32和0，未发现日期换算导致的漏查。
- 以上是当前检索视图与身份范围的结果，不等于历史在任何地方都不存在，也不证明未导入/去重排除等更大范围数据状态。没有扩大身份范围、重导入或改档案。

### 本地最小修复

仍仅四个源码/测试文件及本报告：

- history_tool：每次符合条件的请求增加真实、请求级工具可用状态；强调零命中不能撤销此前成功证据。该状态放在最新用户消息之前，保留消息顺序。每次模型调用仍携带历史工具声明，新增history_tool_registered/message_count/request_bytes日志，仅布尔/计数，不输出声明正文、查询值或身份。
- server：历史功能开启但本次不满足身份/配置/客户端工具契约时，普通转发分支加入“本次不可用，不证明从未存在或之前编造”的状态说明。不启用历史工具、不猜身份、不从全局持久绑定回退。无法从Gateway安全修复客户端漏传身份，必须保留此边界。
- history_tool：日期/原始ID终止结果与数据库查询异常向模型回传带tool_call_id的结构化not_found/unavailable/error状态。数据库异常不伪装成total=0，异常文本/凭据不回传；以tool_choice=none继续一轮，让模型收到事实状态，并由Gateway固定真实答复约束用户可见结果。状态回传上游失败时返回503并记录，不伪造成功。
- 保留两次关键词补查、日期范围约束、十次查询预算、分页、身份鉴权和不可信正文保护。终止状态回传不新增数据库查询，但增加一次上游调用及对应延迟。
- 已注册工具分支对明确的工具否认/无证据声称此前检索是编造的有限措辞做保守拦截，结合可用状态提示。该有限措辞检查不是完整语义检测；不宣称能约束所有模型表述，尤其未注入路径仍为普通模型生成，仅有权威状态提示。不能无依据杜撰历史正文或恢复旧调用内容。

### 定向测试、回归及上线前置

本轮重建被WSL重启清理的 /tmp Linux Node.js v22.14.0，用绝对Linux路径执行必要测试，未使用Windows npm、未修改依赖或锁文件。

| 测试 | 通过 | 跳过 |
| --- | ---: | ---: |
| history_tool.test.js：状态区别、错误隐私、零命中回传、上游回传失败、长上下文声明、否认保护及原查询预算/补查 | 28 | 0 |
| history_tool.gateway.integration.test.js：缺身份的安全不注入与真实状态提示、原工具共存/绑定/归档 | 7 | 0 |
| history_query.test.js：日期/游标/身份SQL回归 | 6 | 1 |
| raw_chat_archive.integration.test.js：受影响路由的流式与归档兼容 | 5 | 0 |
| gateway_message_summary.test.js：日志摘要隐私 | 1 | 0 |
| 合计 | 47 | 1 |

48项，47通过，零失败，1项隔离真实PostgreSQL测试按现有未配置条件跳过。不重复V2、导入、主动消息等无关测试。新增内容变更后重跑相应工具单元与Gateway集成；git diff --check通过。

最新只读确认：GitHub/main仍e60227e，生产Active仍25b165cb-a6fa-42f6-9bb2-5035de851363/SUCCESS/e60227e，健康检查正常；该当前基线canRedeploy=true、canRollback=true。正确生产服务仍3e312993-6958-4947-a58a-3ea36020d019，不使用旧Ombre默认关联。未修改配置、数据、Ombre记忆或V2成果。

本地修复候选已完成。申请仅提交/推送上述四文件和本报告至main，由原Railway自动部署并观察一次，不重复部署。真实上线后应分别验收7月6日命中、7月7日零命中回传及原会话身份有效性；不得将请求缺身份误判为节点不支持工具。若客户端继续漏传身份，需要另行定位客户端请求路径，本次不会绕过鉴权。

申请授权提交、推送并部署该最小包。部署后首先核验 healthz、普通聊天和现有客户端工具；历史开关维持用户确认的已开启状态，不修改生产配置或档案数据。由用户在原会话提出一个有已知日期/ID/关键词的历史问题，关联 eligibility → upstream_request → model_response → query_started → query_completed → tool_result_queued → 下一轮模型响应，并核对最终回答的来源信息。若未选工具或查询失败，应按日志据实继续定位，不能宣布已修复。用户真实聊天验收会按现有流程正常归档，本轮不代发该生产消息。
