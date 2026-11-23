# 模型列表与 Ollama Chat 接口调查

上游规格见[模型列表与 Ollama Chat 外部资料](../reference/model-discovery-and-ollama.md)。

- OpenAI 的 Chat Completions 和 Responses 共享 `GET /v1/models`，认证使用 Bearer Token，模型 ID 位于 `data[].id`。
- Anthropic 使用 `GET /v1/models`，模型 ID 同样位于 `data[].id`。当 `has_more` 为真时，将 `last_id` 传入下一页的 `after_id`。项目现有的 `2023-06-01` 版本头和 `x-api-key` 认证适用于该接口。
- Ollama 原生接口通过 `GET /api/tags` 列出模型，`models[]` 条目提供 `model` 和 `name`。本地接口允许无认证，直接访问 Ollama Cloud 则使用 Bearer Token。
- Ollama 对话使用 `POST /api/chat`。流式响应由逐行 JSON 对象构成，`done` 标记结束，`prompt_eval_count` 提供输入 token 数。思考和正文分别位于 `message.thinking` 和 `message.content`。
- Ollama 工具参数是 JSON 对象。工具结果使用 `role: "tool"` 和 `tool_name`。截图按视觉接口要求放在用户消息的 `images` 数组里，发送 Base64 图片内容。思考值支持布尔开关或模型定义的级别，省略时采用模型默认值。
