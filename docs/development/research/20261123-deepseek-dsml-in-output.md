# DeepSeek 回答中的 DSML 工具调用标记

用户观察到回答中出现带 `calls`、`invoke`、`parameter` 的 DSML 标签，目标函数是 `ExecActionSequence`。带空格的标签名符合 DeepSeek V4.1 的工具调用编码风格。样本中 `DSML` 两侧各有两个全角竖线，官方示例各有一个。[外部资料](../reference/deepseek-tool-calls.md)

README 推荐连接官方 `deepseek-flash` 的 OpenAI Responses 接口。Go 代理转发上游 SSE。Responses 适配器把 `response.output_text.delta` 显示为助手正文，从 `response.completed.response.output` 中提取 `function_call`。Chat Completions 适配器分别处理 `choices[0].delta.content` 和 `choices[0].delta.tool_calls`。如果上游只在文本事件中发送 DSML，这段文本会显示在界面上，其中的动作不会因此执行。若结束事件同时提供结构化调用，则动作仍可能正常执行。[代理](../../../internal/server/proxy.go) · [协议适配器](../../../src/agent/protocols.ts)

公开报告 #1244 描述了 V4 Pro 在声明工具时偶发把调用放进 Chat Completions 正文。#1678 描述了 `deepseek-flash` 在省略 `tools` 且请求仍带有结构化工具历史时出现类似输出。游戏回合的最后一次请求仍声明工具，使用 `tool_choice: "none"`。上下文压缩会省略工具声明，但将历史序列化为一条用户消息，并且不会直接显示压缩响应。两条公开报告都只能作为类似现象的证据。[外部资料](../reference/deepseek-tool-calls.md) · [回合与上下文压缩](../../../src/agent/agent.ts)

用户随后提供了浏览器网络面板中的 `response.output_text.delta` 事件（序号 4415–4426）。这些事件属于同一个 `item_id` 和 `output_index: 1`，依次拼出 `parameter`、`invoke` 和 `calls` 的闭合标签，其中 `｜｜DSML｜｜` 已经出现在 `delta` 中。Go 代理按字节转发 SSE，因此正文事件类型和双竖线均来自上游响应。

随后提供的 `response.completed` 中，`response.status` 为 `completed`，模型为 `deepseek-flash`。`output[1].id` 与流式正文事件的 `item_id` 一致，其 `output_text` 只有完整的 `ExecActionSequence` DSML 块和开头的空行。`output` 只有一个 `reasoning` 项和一个 `message` 项。响应回显的 `tools` 包含 `ReadScreen` 和 `ExecActionSequence`，`tool_choice` 为 `none`，对应项目在第八次游戏请求中禁用工具的收尾路径。此时只应返回供玩家阅读的正文，缺少 `function_call` 符合请求约束。异常是上游把动作意图以 DSML 正文交付，项目没有执行这段文字中的动作。现有事件无法区分模型生成了畸形标记与上游服务解析或转换异常，也无法证明禁用工具是此类泄漏的唯一触发条件。[回合请求](../../../src/agent/agent.ts#L160) · [外部资料](../reference/deepseek-tool-calls.md)
