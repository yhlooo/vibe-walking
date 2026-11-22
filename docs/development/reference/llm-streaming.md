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

## Anthropic

> For thinking content, a special `signature_delta` event is sent just before the `content_block_stop` event.

[Claude Platform Docs — Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)

> Effort is set at `output_config.effort`, not inside the `thinking` object

[Claude Platform Docs — Steering thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)

> When you return tool results, you must pass the thinking blocks from the assistant message back to the API, complete and unmodified.

[Claude Platform Docs — Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
