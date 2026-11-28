# 模型列表与 Ollama Chat 外部资料

## OpenAI

> The model identifier, which can be referenced in the API endpoints.

[OpenAI API Reference — List models](https://developers.openai.com/api/reference/resources/models/methods/list)

## Anthropic

> Last ID in the `data` list. Can be used as the `after_id` for the next page.

[Claude API Reference — List Models](https://platform.claude.com/docs/en/api/models/list)

> `curl https://api.anthropic.com/v1/models \
>     -H 'anthropic-version: 2023-06-01' \
>     -H "X-Api-Key: $ANTHROPIC_API_KEY"`

[Claude API Reference — Modelle auflisten](https://platform.claude.com/docs/de/api/models-list)

> Earlier SDK and CLI versions sent `anthropic-version: 2023-06-01` with every request.

[Claude Platform Docs — Migrating to API version 2026-10-21](https://platform.claude.com/docs/en/api/migration-2026-10-21)

## Ollama

> Fetch a list of models and their details

[Ollama API Reference — List models](https://docs.ollama.com/api/tags)

> Number of tokens in the prompt

[Ollama API Reference — Generate a chat message](https://docs.ollama.com/api/chat)

> The local API at `http://localhost:11434` does not require authentication.

> Use the API key in the `Authorization: Bearer` header.

[Ollama API Reference — Authentication](https://docs.ollama.com/api/authentication)

> These responses are provided in the newline-delimited JSON format (i.e. the `application/x-ndjson` content type).

[Ollama API Reference — Streaming](https://docs.ollama.com/api/streaming)

> When streaming, gather every chunk of `thinking`, `content`, and `tool_calls`, then return those fields together with any tool results in the follow-up request.

[Ollama — Tool calling](https://docs.ollama.com/capabilities/tool-calling#tool-calling-with-streaming)

> The reasoning output and answer use separate fields. Chat returns `message.thinking` and `message.content`.

[Ollama — Thinking](https://docs.ollama.com/capabilities/thinking)

> SDKs accept file paths, URLs or raw bytes while the REST API expects base64-encoded image data.

[Ollama — Vision](https://docs.ollama.com/capabilities/vision)

## 生成与发现端点

> Start by updating your generation endpoints from `post /v1/chat/completions` to `post /v1/responses`.

[OpenAI — Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)

> `GET /models`

[OpenAI API Reference — List models](https://developers.openai.com/api/reference/resources/models/methods/list)

> `POST /v1/messages`

[Claude API Reference — Create a Message](https://platform.claude.com/docs/en/api/messages/create)

> `GET /v1/models`

[Claude API Reference — List Models](https://platform.claude.com/docs/en/api/models/list)

> `POST /api/chat`

[Ollama API Reference — Generate a chat message](https://docs.ollama.com/api/chat)

> `GET /api/tags`

[Ollama API Reference — List models](https://docs.ollama.com/api/tags)
