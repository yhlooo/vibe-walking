# 多工具调用外部资料

## OpenAI

> Since model responses can include zero, one, or multiple calls, it is best practice to assume there are several.

[OpenAI API — Handling function calls](https://developers.openai.com/api/docs/guides/function-calling#handling-function-calls)

> In Responses, tool calls and their outputs are two distinct types of Items that are correlated using a `call_id`.

[OpenAI API — Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses#follow-function-calling-best-practices)

> The ID of the output item that the function-call arguments delta is added to.

[OpenAI API Reference — Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events#response-function-call-arguments-delta)

## Anthropic

> return one `tool_result` for each `tool_use` block, all together in the next user message.

[Claude Platform Docs — Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use#execution-semantics)

## Ollama

> Request multiple tool calls in parallel, then send all tool responses back to the model.

[Ollama — Parallel tool calling](https://docs.ollama.com/capabilities/tool-calling#parallel-tool-calling)
