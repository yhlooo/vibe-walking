# VIBE WALKING

用自然语言引导 Vibe 踩下红色按钮即可通关（ Vibe 是画面中的白色方块，也是与你对话的角色）

## 快速开始

Linux / MacOS

```bash
```

Windows

```bash

```

## 接入 LLM

该游戏必须依赖一个外部 LLM API ，你需要提前准备好 API 密钥。 **所有 API Key 都在本地存储仅用于调用 LLM API ，不会上传到任何第三方**

目前支持以下三种 LLM API ：

- OpenAI Chat Completions API
- OpenAI Responses API (推荐)
- Anthropic Messages API

要求模型支持视觉理解。

如果你不知道选择什么模型，推荐 DeepSeek V4.1 Flash ，按以下方式配置：

- 协议： `OpenAI Responses`
- Base URL ： `https://api.deepseek.com`
- 模型 ID ： `deepseek-flash`
- 上下文长度： `1000`
- 思考强度： `medium`
- API Key ：在 [DeepSeek 开放平台注册账号并创建](https://platform.deepseek.com/api_keys) ，合法的 API Key 是一个 `sk-` 开头的字符串
