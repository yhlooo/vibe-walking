# 模型事件流外部资料

## SSE 和 Go HTTP

> Event streams are always decoded as UTF-8.

[WHATWG HTML Standard — Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)

> Flush flushes buffered data to the client.

[Go `net/http.ResponseController.Flush`](https://pkg.go.dev/net/http#ResponseController.Flush)

## OpenAI

> If the stream is interrupted or cancelled, you may not receive the final usage chunk which contains the total token usage for the request.

[OpenAI API Reference — Chat Completions streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)

> Emitted when a reasoning summary text delta is added.

[OpenAI API Reference — Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)

> To access the most detailed summarizer available for a model, set the value of this parameter to `auto`.

[OpenAI — Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)

> Currently supported values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

[OpenAI API Reference — Create a model response](https://developers.openai.com/api/reference/resources/responses/methods/create)

> prompt_tokens_details: optional object { audio_tokens, cache_write_tokens, cached_tokens, 2 more }

[OpenAI API Reference — List Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/list)

> usage: optional ResponseUsage { input_tokens, input_tokens_details, output_tokens, 2 more } or null

[OpenAI API Reference — Get a model response](https://developers.openai.com/api/reference/resources/responses/methods/retrieve)

## Anthropic

> For thinking content, a special `signature_delta` event is sent just before the `content_block_stop` event.

[Claude Platform Docs — Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)

> Effort is set at `output_config.effort`, not inside the `thinking` object

[Claude Platform Docs — Steering thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)

> When you return tool results, you must pass the thinking blocks from the assistant message back to the API, complete and unmodified.

[Claude Platform Docs — Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)

> The token counts shown in the `usage` field of the `message_delta` event are cumulative.

[Claude Platform Docs — Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)

> total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens

[Claude Platform Docs — Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

## DeepSeek

> Number of tokens in the prompt that hit the context cache. Same as `prompt_cache_hit_tokens`.

[DeepSeek API Docs — Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)

## Ollama

> All timing values are measured in nanoseconds.

> For endpoints that return streaming responses, usage fields are included as part of the final chunk, where `done` is `true`.

[Ollama API — Usage](https://github.com/ollama/ollama/blob/main/docs/api/usage.mdx)
