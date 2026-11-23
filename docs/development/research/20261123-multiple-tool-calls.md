# 同一响应中的多个工具调用

- OpenAI Chat Completions 通过 `tool_calls` 返回调用列表，流式增量用 `index` 标明调用位置。后续请求保留助手消息并以 `tool_call_id` 逐项提交工具消息。Responses 从 `output` 读取 `function_call`，再通过 `call_id` 提交对应的 `function_call_output`。`parallel_tool_calls: false` 将支持该参数的接口限制为每次响应至多一个调用。[OpenAI 官方资料](../reference/multiple-tool-calls.md#openai)
- Anthropic Messages 在一个助手消息中返回多个 `tool_use` 内容块。应用可以依次执行，所有 `tool_result` 必须一同放在紧接该助手消息的一个用户消息中，用 `tool_use_id` 关联调用。[Anthropic 官方资料](../reference/multiple-tool-calls.md#anthropic)
- Ollama Chat 的流式请求汇集各块返回的 `tool_calls`。官方示例保留整个助手消息，随后按调用顺序添加带 `tool_name` 的工具消息。[Ollama 官方资料](../reference/multiple-tool-calls.md#ollama)

Chat Completions 和 Ollama Chat 的截图沿用用户消息承载，放在本批所有工具消息之后，使完整的工具结果紧跟助手调用。Responses 和 Anthropic Messages 的截图直接放在相应的工具结果中。

## Kimi Responses 的缺失调用标识

用户提供的 `kimi-k3.1-pro` 样本在 `response.completed` 中包含两个 `function_call`。`output[2]` 的名称为 `ReadScreen`，有 `call_id`，参数为 `"{"`。`output[4]` 使用另一个 `fc_…` 输出项 ID，缺少 `call_id` 和 `name`，参数为 `"}"`。后者的参数增量、参数结束和输出项结束事件都标记 `output_index: 4`，并指向同一个输出项。样本只提供了末尾事件，无法判断此前是否有可用于补全的事件，也无法确认上游产生这两个条目的原因。

`item_id` 将参数增量关联到输出项，`call_id` 将工具结果关联到调用。原适配器从最终 `output` 读取调用，并在执行前校验整批 `call_id`。修复前回放 `response.completed` 可复现「模型返回的工具调用缺少 ID」。两个参数片段恰好能拼成 `{}`，但属于不同输出项，样本无法确认上游拆分的原因。[OpenAI 官方资料](../reference/multiple-tool-calls.md#openai)

随后提供的事件流有 68 条事件。序号 7 的 `response.output_item.added` 为 `output[1]` 提供 `ExecActionSequence` 及其 `call_id`。最终响应把参数分到了 `output[1]`、`output[3]`、`output[5]`，分别是左花括号、完整的 `actions` 字段、右花括号。后两项从创建到完成均无 `name`、`call_id`，夹在调用项之间的消息只有空白输出。三个片段按原序拼接后是一个合法的参数对象。仅兼容 `ReadScreen` 的版本回放这份事件流仍会报错。

适配器从具备名称和 `call_id` 的已完成调用项开始，收集其后的连续匿名参数片段，允许略过空白助手消息。整组合并为合法 JSON 对象时，保留首项的名称、`call_id` 和顺序，使用拼接后的参数执行并回传。含有效内容的输出项或带独立标识的调用会隔开片段，无法重组的缺失 `call_id` 仍会报错。动作执行继续由已有的参数校验约束。回归测试覆盖 `ReadScreen`、三段式 `ExecActionSequence` 与其后的独立调用，以及无法重组的片段。[协议适配器](../../../src/agent/protocols.ts) · [回归测试](../../../tests/agent.test.mjs)
