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

对话输入栏分别显示模型名称和参数按钮。点击模型名称后显示以“模型”为标题的供应商列表，悬停、点击或用键盘聚焦供应商可在右侧展开模型列表。每次选择模型都从目录读取默认参数。

参数按钮展示思考强度与上下文长度，例如 `XHIGH 1M`。上下文长度能被 1000000 整除时显示 `M`，否则能被 1000 整除时显示 `K`。点击参数按钮在其上方打开编辑菜单，有效输入直接更新页面内的临时模型参数。模型选择与参数更新只保存在当前页面内存中。单次生成回合使用开始时的模型及参数，途中编辑的值从下一回合生效。两个按钮悬停时显示圆角底色。再次点击相应按钮、点击菜单外部或按 Esc 可收起菜单。

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

设置界面的“模型”区块包含默认模型和“模型供应商”列表。展开供应商可编辑连接信息及其“模型”列表，展开模型可编辑模型参数。两级列表默认折叠，通过拖动标题栏的把手排序，点击标题栏右侧的删除图标删除该行。列表标题右侧的加号用于添加对应的供应商或模型。

聚焦模型 ID 时自动查询当前供应商支持的模型 ID。输入按不区分大小写的子串筛选候选项，也可直接保存手动输入的 ID。同一连接在编辑期间复用查询结果，协议、地址或凭据变化时重新查询。思考强度可以手动输入或选择固定候选项，候选项始终完整显示。

已保存的 API Key 以六个星号显示。聚焦字段可直接输入新密钥，留空并离开字段会恢复掩码。点击输入框右侧的叉号可清除密钥，随表单一起保存。

## 配置读取与保存

Go 服务启动时读取 `settings.json`。旧版 `model` 在内存中转换成 `default` 供应商及默认模型，继承思考强度、上下文长度和密钥，并启用视觉标记。Anthropic 的旧 Base URL 去掉末尾的 `/v1`，Ollama 的旧 Base URL 加上 `/api`。旧版 Anthropic 自定义网关在路径中省略 `/v1` 时，保留原先的上游路径，并在后续保存时记录该供应商的兼容信息。服务启动时保持磁盘上的原始文件，用户保存设置时写入新结构。

供应商及其模型按配置顺序保存。通过 `POST /api/v1/settings` 提交 `modelProviders` 可替换供应商列表。允许供应商暂时没有模型。没有指定默认模型时按配置顺序选取第一个模型。如果没有任何模型，默认模型为空。模型 ID 可以包含斜线，代理用第一个斜线区分供应商和上游模型 ID。

浏览器读取的配置只包含 `hasAPIKey`。保存时省略 `apiKey` 可保留同一协议和 Base URL 的已保存密钥，空字符串清除密钥。供应商改名时可用 `previousID` 引用原来的供应商，按同样的条件保留密钥。

## 浏览器与代理

聊天代理统一挂在 `/llm/proxies`。协议适配器发送由供应商 ID 和模型 ID 构成的请求模型名，代理根据当前配置找到供应商并恢复上游模型 ID。协议需要与入口匹配，SSE 和 NDJSON 继续流式转发。

`GET /llm/providers/{providerID}/models` 查询已保存供应商的上游模型。`POST /llm/providers/models` 可以用尚未保存的连接查询候选模型，供首次配置和编辑时使用。生成和发现使用同一套上游 Base URL 规则。

每个游玩或编辑页面独立使用默认模型或玩家当前选择的模型。覆盖思考强度和上下文长度只影响当前游玩页面。切换模型连接时，用对话文本重建上下文，避免把依赖上游的推理项或工具调用记录发给另一个模型。视觉标记保存在供应商配置中，供后续降级方案使用。
