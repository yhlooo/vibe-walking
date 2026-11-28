# 流式模型调用的统计字段

| 协议 | 输入 | 缓存命中 | 输出 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `prompt_tokens` | `prompt_tokens_details.cached_tokens`，兼容 DeepSeek 的 `prompt_cache_hit_tokens` | `completion_tokens` |
| OpenAI Responses | `input_tokens` | `input_tokens_details.cached_tokens` | `output_tokens` |
| Anthropic Messages | `input_tokens`、`cache_read_input_tokens` 和 `cache_creation_input_tokens` 之和 | `cache_read_input_tokens` | `output_tokens` |
| Ollama Chat | `prompt_eval_count` | `prompt_eval_cached_count` | `eval_count` |

Chat Completions 请求已通过 `stream_options.include_usage` 获取流末尾的用量。Responses 从 `response.completed` 读取。Anthropic 在 `message_start` 和 `message_delta` 提供用量，后者是累计值，因此每个字段取最近一次报告值。Ollama 在最终块报告用量，另有以纳秒计的 `eval_duration` 可用于计算生成速率。

字段定义与事件规则见[模型事件流外部资料](../reference/llm-streaming.md)。
