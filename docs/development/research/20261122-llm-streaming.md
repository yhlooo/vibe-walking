# LLM 流式接口调查

原始文档摘录见[模型事件流外部资料](../reference/llm-streaming.md)。

- 三种接口使用 SSE。浏览器以 POST 发起生成请求，用 UTF-8 解码响应流，积累分段的 `data` 行。Go 的 HTTP 响应缓冲需要显式刷新，小事件才能在生成结束前到达浏览器。
- Chat Completions 的文本和函数参数在 `choices[].delta` 中分段出现。工具按序号拼接。请求 `stream_options.include_usage` 可取得 `prompt_tokens`，中断时最后的用量事件可能缺失。官方接口不提供原始思考文本，兼容接口可通过 `reasoning_content` 或 `reasoning` 提供。
- Responses 的文本与推理摘要使用不同的 delta 事件。支持推理摘要的模型可以通过 `reasoning.summary: "auto"` 请求摘要。完整响应给出协议原生输出项和输入 token 用量，可回放加密推理项。
- Anthropic 的消息流包含内容块起止、文本、思考、签名和工具输入增量。完整的签名思考块参与后续工具请求。输入用量可能分为未缓存、缓存读及缓存写。思考强度由 `output_config.effort` 控制，推理展示和支持的档位由具体模型决定。
