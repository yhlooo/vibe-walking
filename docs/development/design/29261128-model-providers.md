# LLM 供应商

## 概述

当前配置文件 ~/.vibe-walking/settings.json 中通过 `.model` 属性配置代理连接的模型。如果用户需要来回切换多个不同的模型非常麻烦，而且由于代理服务只有一份配置因此不能同一时间在多个不同页面中使用不同的模型。

因此本方案将其调整为模型供应商配置的模式。

调整涉及 3 个主要方面

- 供应商配置
- LLM API 代理
- 模型配置 Web UI

## 供应商配置

首先配置文件中关于模型配置调整为如下结构：

```json
{
  "defaultModel": "deepseek/deepseek-flash",
  "modelProviders": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "protocol": "OpenAIChatCompletions",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek V4.1 Flash",
          "maxInputToken": 1000000,
          "reasoningEffort": "high",
          "vision": true
        },
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro",
          "maxInputToken": 1000000,
          "reasoningEffort": "max",
          "vision": false
        }
      ]
    }
  ]
}
```

其中 `modelProviders` 每一项结构如下：

- **id** (string) 调用 API 时使用的供应商 ID ，在所有 Provider 中唯一，必须匹配正则 `[a-z][0-9a-z._-]*`
- **name** (string, optional) 在 UI 上展示的供应商名，为空时显示 id
- **protocol** (string) API 协议，支持 `OpenAIChatCompletions`、`OpenAIResponses`、`AnthropicMessages` 和 `OllamaChat`
- **baseURL** (string) 接口 Base URL

  实际 URL 是在 Base URL 基础上对于不同协议添加不同的后缀：

  - OpenAIChatCompletions: `/chat/completions`
  - OpenAIResponses: `/responses`
  - AnthropicMessages: `/v1/messages`
  - OllamaChat `/chat`
  
  该后缀添加规则符合各 API 协议约定，应可以直接传入对应的 SDK

- **apiKey** (string, optional) API 密钥
- **models** (\[]Model) 模型列表
  - **id** (string) 调用 API 时使用的模型 ID （在 Provider 中唯一）
  - **name** (string, optional) 在 UI 上展示的模型名，为空时显示 id
  - **maxInputToken** (int) 模型支持的最大输入 Token 长度
  - **reasoningEffort** (string, optional) 使用该模型的默认思考强度
  - **vision** (bool) 该模型是否支持视觉理解（暂时无用，记录下来留待后续扩展非视觉的降级方案）

`defaultModel` 是默认使用的模型，开始游戏时默认提供给用户，但是用户可以选择其他。

### 兼容性要求

对于原有通过 `model` 字段配置的模型，可以被理解为一个 ID 为 `default` 名为 `Default` 的供应商中的一个模型。是否支持视觉为 `true` 。

不需要对已有配置进行迁移，只需在加载配置时内存中自动转换为新的配置格式。

## LLM API 代理

本地模型代理提供以下 3 个 API 端口：

- `/llm/proxies/openai/v1` OpenAI API 代理（作为 Web UI 中 OpenAI API 的 Base URL ）
  - `POST /llm/proxies/openai/v1/chat/completions` OpenAI Chat Completions API
  - `POST /llm/proxies/openai/v1/responses` OpenAI Responses API
- `/llm/proxies/anthropic` Anthropic API 代理（作为 Web UI 中 Anthropic API 的 Base URL ）
  - `POST /llm/proxies/anthropic/v1/messages` Anthropic Messages API
- `/llm/proxies/ollama/api` Ollama API 代理（作为 Web UI 中 Ollama API 的 Base URL ）
  - `POST /llm/proxies/ollama/api/chat` Ollama Chat API

在这些接口中所有的模型字段使用 `{provider}/{model}` 的格式。比如 `deepseek/deepseek-flash` 表示代理到 `deepseek` Provider 的 `deepseek-flash` 模型。

另外再提供一些列出列出接口用于辅助 Web UI 实现：

- `GET /llm/providers/{providerID}/models` 列出该供应商的全部模型（调用供应商接口获取，而非返回已配置的模型列表）

  ```json
  {
    "models": [
      {
        "id": "deepseek-flash"
      }
    ]
  }
  ```

  用于 Web UI 中辅助用户配置

- `GET /llm/providers` 列出所有配置的供应商和可用模型列表，返回形如：

  ```json
  {
    "defaultModel": "deepseek/deepseek-flash",
    "providers": [
      {
        "id": "...",
        "models": [
          ...
        ]
      }
    ]
  }
  ```

  整体结构和配置一致，但是不返回 API Key

## 游玩 UI

在对话框中可以选择使用的供应商和模型和部分参数，采用三级菜单的形式，先选择供应商，然后选择模型，然后设置思考强度、上下文长度。配置中的思考强度和上下文长度只是默认值，在 Web UI 上选择模型时还可以修改。

选择完成后显示模型名、思考强度、上下文长度，比如 `DeepSeek V4.1 Flash [xhigh, 1m]` ，上下文长度如果可以被 1000000 整除则显示单位 `m` ，如果可以被 1000 整除则显示单位 `k`

## 模型配置 UI

在没有配置模型的首次游玩时配置界面使用一个单默认供应商单模型的简化配置，只需保持跟现在几乎一样的配置：

- 协议
- Base URL
- API Key
- 模型 ID
- 思考强度
- 上下文长度
- 支持视觉理解（新增配置项）

保存后注册为一个 ID `default` 名 `Default` 的供应商中的单个模型。

在设置界面提供完整的供应商和模型配置功能：

- 供应商列表默认折叠供应商详细配置，点击展开详情可以修改单个供应商配置，可以拖动修改供应商顺序。列表下方“添加供应商”按钮。
- 单个供应商配置中模型列表默认折叠模型详情，点击展开详情可以修改单个模型配置，可以拖动修改模型顺序。列表下方“添加模型”按钮。

## 配置读取与保存

Go 服务启动时读取 `settings.json`。旧版 `model` 在内存中转换成 `default` 供应商及默认模型，继承思考强度、上下文长度和密钥，并启用视觉标记。Anthropic 的旧 Base URL 去掉末尾的 `/v1`，Ollama 的旧 Base URL 加上 `/api`。旧版 Anthropic 自定义网关在路径中省略 `/v1` 时，保留原先的上游路径，并在后续保存时记录该供应商的兼容信息。服务启动时保持磁盘上的原始文件，用户保存设置时写入新结构。

供应商及其模型按配置顺序保存。通过 `POST /api/v1/settings` 提交 `modelProviders` 可替换供应商列表。允许供应商暂时没有模型。没有指定默认模型时按配置顺序选取第一个模型。如果没有任何模型，默认模型为空。模型 ID 可以包含斜线，代理用第一个斜线区分供应商和上游模型 ID。

浏览器读取的配置只包含 `hasAPIKey`。保存时省略 `apiKey` 可保留同一协议和 Base URL 的已保存密钥，空字符串清除密钥。供应商改名时可用 `previousID` 引用原来的供应商，按同样的条件保留密钥。

## 浏览器与代理

聊天代理统一挂在 `/llm/proxies`。协议适配器发送由供应商 ID 和模型 ID 构成的请求模型名，代理根据当前配置找到供应商并恢复上游模型 ID。协议需要与入口匹配，SSE 和 NDJSON 继续流式转发。

`GET /llm/providers/{providerID}/models` 查询已保存供应商的上游模型。`POST /llm/providers/models` 可以用尚未保存的连接查询候选模型，供首次配置和编辑时使用。生成和发现使用同一套上游 Base URL 规则。

每个游玩或编辑页面独立使用默认模型或玩家当前选择的模型。覆盖思考强度和上下文长度只影响当前游玩页面。切换模型连接时，用对话文本重建上下文，避免把依赖上游的推理项或工具调用记录发给另一个模型。视觉标记保存在供应商配置中，供后续降级方案使用。
