# 模型供应商的上游路径

[外部 API 路径](../reference/model-discovery-and-ollama.md#生成与发现端点)

OpenAI 的生成与发现端点共用 `/v1`，因此配置 Base URL 含该前缀，服务添加 `/chat/completions`、`/responses` 或 `/models`。

Anthropic 配置 Base URL 指向服务根路径，代理添加 `/v1/messages` 或 `/v1/models`。分页沿用模型列表的 `has_more` 和 `last_id`，用 `after_id` 请求下一页。

Ollama 的生成和发现端点共用 `/api`，因此配置 Base URL 包含该前缀，代理分别添加 `/chat` 和 `/tags`。
