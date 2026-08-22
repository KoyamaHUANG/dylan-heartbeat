# Kelivo Proactive Sync API V1

此协议定义 Dylan Heartbeat 向 Kelivo 同步“已经成功发送到 Bark/ntfy 的主动消息”的服务端接口。它是下一阶段 Kelivo 客户端实现的唯一合约。

## 认证

所有 `/v1/*` 调用使用现有 Gateway API Key，和 Kelivo Provider 相同：

```http
Authorization: Bearer <GATEWAY_API_KEY>
```

也兼容 Gateway 已支持的 `X-Gateway-Api-Key` 或 `X-Api-Key`。生产公网部署需保持现有 `ALLOW_PUBLIC_API=true` 与 `GATEWAY_API_KEY` 配置；不新增第二套密钥。

`/internal/*` 不属于此协议，仍只允许 Gateway 容器 localhost 调用。

## 1. 普通聊天时绑定会话

Kelivo 每次发送真实聊天请求时，继续调用：

```http
POST /v1/chat/completions
X-Kelivo-Conversation-Id: <Kelivo conversation id>
X-Kelivo-Assistant-Id: <optional Kelivo assistant id>
```

`X-Kelivo-Conversation-Id` 最长 128 字符、去除首尾空白且不得含控制字符；`X-Kelivo-Assistant-Id` 可省略或为空。

Heartbeat 只会在该请求的最后一个真实会话消息为 `role: user` 时，持久化这个绑定。没有 Header 的旧版 Kelivo 请求继续正常聊天，也不会清空既有绑定。system、assistant、tool 请求不会切换绑定。

## 2. 拉取主动消息

```http
GET /v1/proactive-events?conversation_id=<required>&after_seq=<optional>&limit=<optional>&assistant_id=<optional>
Authorization: Bearer <GATEWAY_API_KEY>
```

参数：

- `conversation_id`：必填，必须与 Kelivo 当前 conversation id 完全相同。
- `after_seq`：可选，非负整数，默认 `0`。仅返回 `seq > after_seq` 的事件。
- `limit`：可选，默认 `50`，范围 `1..100`。
- `assistant_id`：可选；提供后还必须精确匹配事件的 assistant id。

缺少或非法参数返回 `400`；缺少或错误 Gateway Key 返回当前 Gateway 的 `401`。事件不会跨 conversation 泄漏。

响应：

```json
{
  "object": "proactive_event_list",
  "conversation_id": "conversation-123",
  "data": [
    {
      "event_id": "550e8400-e29b-41d4-a716-446655440000",
      "seq": 12,
      "conversation_id": "conversation-123",
      "assistant_id": "ayan",
      "created_at": "2026-08-22T10:00:00.000Z",
      "role": "assistant",
      "title": "阿言",
      "body": "想你了，在忙吗？",
      "source": "wake",
      "push_provider": "bark"
    }
  ],
  "next_after_seq": 12,
  "oldest_seq": 1,
  "latest_seq": 12,
  "has_more": false
}
```

字段含义：

- `event_id`：永久 UUID；Kelivo 必须使用稳定值（例如 `heartbeat:<event_id>`）作为本地消息去重键。
- `seq`：服务器全局单调递增、永久不变的序号。
- `created_at`：Heartbeat 记录成功主动事件的 UTC ISO-8601 时间。
- `role`：始终为 `assistant`。
- `title`、`body`：真正成功发送到 Bark/ntfy 的显示名和正文；Kelivo 应将 `body` 写为此 conversation 的 assistant 消息。
- `source`：`wake` 或受控测试的 `manual_test`。
- `push_provider`：`bark`、`ntfy` 或 `none`。

## Cursor 与多设备

每个 Kelivo 客户端、每个 conversation 自己保存 `after_seq`。收到数据后，先按 `event_id` 本地去重，再把成功处理的最大 `seq` 保存为下一次的 `after_seq`。

服务器没有 ack、已读标记或读后删除：iPhone 和 Windows 可以分别从相同 cursor 读取同一事件。`oldest_seq` 和 `latest_seq` 用于客户端判断自己的 cursor 是否落在当前保留窗口之外；默认最多保留 5000 条事件（可由 `PROACTIVE_EVENT_MAX_COUNT` 调整）。

重复 GET、网络重试或客户端 cursor 丢失都不会在服务器创建新事件；客户端依靠稳定 `event_id` 避免本地重复。

## 3. 受保护的手工测试事件

默认关闭。仅在 Railway 临时设置：

```env
PROACTIVE_SYNC_TEST_ENABLED=true
```

后可调用：

```http
POST /v1/proactive-events/test
Authorization: Bearer <GATEWAY_API_KEY>
Content-Type: application/json

{
  "conversation_id": "conversation-123",
  "assistant_id": "ayan",
  "title": "阿言",
  "body": "主动消息同步测试"
}
```

`conversation_id` 与 `body` 必填；`assistant_id`、`title` 可选，title 默认当前 `PUSH_DISPLAY_NAME`（未设置则 `阿言`）。`body` 最大 4000 字符，title 最大 100 字符。关闭时返回 `404`。

成功时只创建一个 `source: "manual_test"`、`push_provider: "none"` 的 proactive event。它绝不会调用 Claude/Requesty、发送 Bark/ntfy、改动 `enhanced_messages.json`、最后用户时间或 wake-up 调度。验证完成后应将该变量恢复为 `false`。
