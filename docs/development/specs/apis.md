# HTTP API

- [关卡](#1-关卡)
  - [`GET /api/v1/levels` 列出关卡](#11-列出关卡)
  - [`POST /api/v1/levels` 创建自建关卡](#12-创建自建关卡)
  - [`PUT /api/v1/levels` 设置自建关卡顺序](#13-设置自建关卡顺序)
  - [`GET /api/v1/levels/{id}` 获取关卡](#14-获取关卡)
  - [`PUT /api/v1/levels/{id}` 更新自建关卡](#15-更新自建关卡)
- [游玩进度](#2-游玩进度)
  - [`GET /api/v1/progress` 获取游玩进度](#21-获取游玩进度)
  - [`POST /api/v1/progress` 迁移旧版游玩进度](#22-迁移旧版游玩进度)
  - [`PUT /api/v1/progress/{id}/completions/{attemptID}` 记录一次通关](#23-记录一次通关)
  - [`PUT /api/v1/progress/recent/{id}` 登记最近关卡](#24-登记最近关卡)
- [设置](#3-设置)
  - [`GET /api/v1/settings` 获取设置](#31-获取设置)
  - [`POST /api/v1/settings` 更新设置](#32-更新设置)
- [模型供应商与发现](#4-模型供应商与发现)
  - [`GET /llm/providers` 列出已配置的供应商](#41-列出已配置的供应商)
  - [`GET /llm/providers/{providerID}/models` 列出指定供应商模型](#42-列出指定供应商模型)
  - [`POST /llm/providers/models` 使用指定连接查询模型](#43-使用指定连接查询模型)
- [模型代理](#5-模型代理)
  - [`POST /llm/proxies/openai/v1/chat/completions` OpenAI Chat Completions](#51-openai-chat-completions)
  - [`POST /llm/proxies/openai/v1/responses` OpenAI Responses](#52-openai-responses)
  - [`POST /llm/proxies/anthropic/v1/messages` Anthropic Messages](#53-anthropic-messages)
  - [`POST /llm/proxies/ollama/api/chat` Ollama Chat](#54-ollama-chat)
- [通用错误响应](#6-通用错误响应)

## 0 概述

**公共响应头：**

- `Content-Type` 除非特别说明，否则请求和响应体都使用 JSON 格式。值为 `application/json`
- `X-Request-Id` 请求唯一 ID

## 1 关卡

### 1.1 列出关卡

请求 `GET /api/v1/levels`

响应

- `200` 返回关卡列表。
- `500` 读取关卡数据失败。

正常响应体

- **levels** ([LevelEntry](#levelentry)[]) 关卡列表，内置关卡在前，自建关卡在后。
- **warnings** (string[], optional) 读取关卡时产生的警告。

### 1.2 创建自建关卡

请求 `POST /api/v1/levels`

请求体

- **legacy** ([Level](#level), optional) 要导入的旧版关卡定义。传入空对象时创建默认关卡。

响应

- `201` 返回创建的关卡。旧版关卡已导入时返回已有条目。
- `400` 请求体或关卡定义无效。
- `500` 读取或保存关卡数据失败。

正常响应体为一个 [LevelEntry](#levelentry) 。

### 1.3 设置自建关卡顺序

请求 `PUT /api/v1/levels`

请求体

- **ids** (string[]) 按目标顺序提交全部自建关卡 ID ，每个 ID 恰好出现一次。

响应

- `200` 顺序已保存。
- `400` 请求体或关卡 ID 列表无效。
- `500` 读取或保存关卡顺序失败。

正常响应体为保存后的关卡 ID 数组 (string[])。

### 1.4 获取关卡

请求 `GET /api/v1/levels/{id}`

路径参数

- **id** (string) 关卡 ID 。

响应

- `200` 返回指定关卡。
- `404` 关卡不存在。
- `500` 读取关卡数据失败。

正常响应体为一个 [LevelEntry](#levelentry) 。

### 1.5 更新自建关卡

请求 `PUT /api/v1/levels/{id}`

路径参数

- **id** (string) 自建关卡 ID 。

请求体为完整的 [Level](#level) ，上限 64 KiB 。

响应

- `200` 关卡已更新。
- `400` 关卡定义无效或请求体超限。
- `404` 关卡不存在或为内置关卡。
- `500` 读取或保存关卡数据失败。

正常响应体为更新后的 [LevelEntry](#levelentry) 。

### 1.6 公共结构

#### LevelEntry

- **id** (string) 关卡 ID 。
- **kind** (string) `builtin` 表示内置关卡， `custom` 表示自建关卡。
- **description** (string, optional) 关卡说明。
- **level** ([Level](#level)) 关卡定义。
- **revision** (string) 关卡版本标识，用于提交游玩进度。

#### Level

- **schemaVersion** (integer) 格式版本，固定为 `1`。
- **name** (string) 关卡名称，去掉首尾空白后非空，最多 80 个 UTF-16 码元。
- **tiles** (string[]) 地图行，每行由 `.`（空格）、`#`（墙）、 `B` （按钮）组成，整张地图最多一个按钮。支持的宽×高为 16×9、15×10、30×20、48×32。
- **spawn** (object) 出生点，必须落在空格上。
  - **x** (integer) 从零开始的列号。
  - **y** (integer) 从零开始的行号。
- **gravity** (number, optional) 重力，范围为 −10 到 10，默认 1。响应中始终返回。
- **inertia** (number, optional) 惯性，范围为 0 到 10，默认 0.5。响应中始终返回。
- **disableReadScreen** (boolean, optional) 是否禁用读屏工具，默认 `false` 。
- **systemPrompt** (string, optional) 自定义系统提示词，最多 4096 个 UTF-16 码元。

## 2 游玩进度

### 2.1 获取游玩进度

请求 `GET /api/v1/progress`

响应

- `200` 返回全部游玩进度。
- `500` 读取进度失败。

正常响应体为 [Progress](#progress) 。

### 2.2 迁移旧版游玩进度

请求 `POST /api/v1/progress`

请求体

- **recentBuiltin** (string, optional) 旧版浏览器最近游玩的内置关卡 ID。
- **levels** (map\[string][CompletionSummary](#completionsummary), optional) 以内置关卡 ID 为键的旧版通关汇总。

响应

- `200` 返回合并后的 [Progress](#progress) 。
- `400` 请求体格式无效。
- `500` 读取或保存进度失败。

### 2.3 记录一次通关

请求 `PUT /api/v1/progress/{id}/completions/{attemptID}`

路径参数

- **id** (string) 关卡 ID。
- **attemptID** (string) 本次尝试的 ID，使用 32 个小写十六进制字符。同一关卡下重复提交同一 ID 返回原记录。

请求体

- **revision** (string) 本次通关使用的关卡物理版本。
- **model** (string, optional) 最后执行移动或跳跃动作的模型，格式为 `<providerID>/<modelID>` 。
- **durationMS** (integer, optional) 从发出首条玩家指令到踩下按钮的毫秒数。无计时的通关省略。

响应

- `200` 返回 [Completion](#completion) 。
- `400` 请求体无效或关卡不可游玩。
- `404` 关卡不存在。
- `409` 关卡物理版本已变更。
- `500` 读取或保存进度失败。

### 2.4 登记最近关卡

请求 `PUT /api/v1/progress/recent/{id}` ，其中 **id** 为进入正式游玩的关卡 ID。请求无正文。同一服务上的多个页面共享最近关卡，按服务端处理登记请求的顺序更新。

响应

- `204` 已登记。
- `400` 关卡不可游玩。
- `404` 关卡不存在。
- `500` 读取或保存进度失败。

### 2.5 公共结构

#### Progress

- **recentLevel** (string, optional) 最近进入的可玩关卡 ID，可为内置或自建关卡。
- **levels** (map\[string][LevelProgress](#levelprogress)) 以关卡 ID 为键的通关记录。

#### LevelProgress

包含 [CompletionSummary](#completionsummary) 的全部字段。

- **completions** ([Completion](#completion)[], optional) 逐次通关记录，按服务保存顺序排列。

#### CompletionSummary

- **completedAt** (string) 首次通关时间，RFC 3339 格式。
- **bestDurationMS** (integer, optional) 最短通关用时，单位为毫秒。

#### Completion

包含路径中的 **attemptID** 和请求体中的 **revision**、**model**、**durationMS**。

- **completedAt** (string) 服务端记录本次通关的时间，RFC 3339 格式。

## 3 设置

### 3.1 获取设置

请求 `GET /api/v1/settings`

响应

- `200` 返回当前设置。

正常响应体为 [Settings](#settings) 。

### 3.2 更新设置

请求 `POST /api/v1/settings`

请求体至少包含以下一项。

- **username** (string, optional) 用户名，最多 20 个字符。
- **defaultModel** (string, optional) 默认模型，格式为 `<providerID>/<modelID>` 。替换供应商列表时，省略或传空字符串会选取列表中的首个模型。列表无模型时返回空字符串。
- **modelProviders** ([ProviderUpdate](#providerupdate)[], optional) 用提交的供应商设置完整替换供应商列表。

响应

- `200` 返回更新后的设置。
- `400` 请求体或设置值无效。
- `500` 保存设置失败。

正常响应体为 [Settings](#settings) 。

### 3.3 公共结构

#### Settings

- **username** (string, optional) 用户名。
- **defaultModel** (string) 默认模型，格式为 `<providerID>/<modelID>` ，未设置时为空字符串。
- **modelProviders** ([Provider](#provider)[]) 供应商摘要列表。

#### ProviderUpdate

- **id** (string) 供应商 ID ，匹配 `^[a-z][0-9a-z._-]*$` ，列表内唯一。
- **name** (string, optional) 供应商显示名称。
- **protocol** (string) [模型协议](#45-模型协议与地址)。
- **baseURL** (string) [上游基础地址](#45-模型协议与地址)。
- **previousID** (string, optional) 要复用连接设置的原供应商 ID ，省略时使用 **id**。
- **apiKey** (string, optional) 上游密钥。省略时可复用原供应商的密钥，前提是协议和基础地址匹配。传空字符串会清除密钥。
- **models** ([ModelUpdate](#modelupdate)[], optional) 提交的模型列表。

#### ModelUpdate

- **id** (string) 上游模型 ID ，在供应商内唯一。
- **name** (string, optional) 模型显示名称。
- **maxInputToken** (integer, optional) 最大输入 token 数，省略或为 `0` 时默认为 `1000000`。
- **reasoningEffort** (string, optional) 推理强度设置。
- **vision** (boolean, optional) 是否支持图片输入，默认为 `false` 。

## 4 模型供应商与发现

### 4.1 列出已配置的供应商

请求 `GET /llm/providers`

响应

- `200` 返回当前供应商和默认模型。

正常响应体

- **defaultModel** (string) 默认模型，格式为 `<providerID>/<modelID>` ，未设置时为空字符串。
- **providers** ([Provider](#provider)[]) 供应商摘要列表。

### 4.2 列出指定供应商模型

请求 `GET /llm/providers/{providerID}/models`

路径参数

- **providerID** (string) 已配置的供应商 ID 。使用该供应商保存的连接向上游查询。

响应

- `200` 返回上游可用模型。
- `404` 供应商未配置。
- `502` 获取上游模型列表失败。
- `504` 获取上游模型列表超时。

正常响应体

- **models** (object[]) 模型列表。
  - **id** (string) 上游模型 ID 。

### 4.3 使用指定连接查询模型

请求 `POST /llm/providers/models`

请求体

- **protocol** (string) [模型协议](#45-模型协议与地址)。
- **baseURL** (string) [上游基础地址](#45-模型协议与地址)。
- **providerID** (string, optional) 要复用连接设置的供应商 ID 。
- **apiKey** (string, optional) 上游密钥。省略时可复用指定供应商的密钥，前提是协议和基础地址匹配。传空字符串时使用空密钥。

响应

- `200` 返回上游可用模型。
- `400` 请求体或连接参数无效。
- `502` 获取上游模型列表失败。
- `504` 获取上游模型列表超时。

正常响应体

- **models** (string[]) 上游模型 ID 列表。

### 4.4 公共结构

#### Provider

- **id** (string) 供应商 ID 。
- **name** (string, optional) 供应商显示名称。
- **protocol** (string) [模型协议](#45-模型协议与地址)。
- **baseURL** (string) [上游基础地址](#45-模型协议与地址)。
- **hasAPIKey** (boolean) 是否已配置密钥。
- **models** ([Model](#model)[]) 已配置模型列表。

#### Model

- **id** (string) 上游模型 ID ，在供应商内唯一。
- **name** (string, optional) 模型显示名称。
- **maxInputToken** (integer) 最大输入 token 数。
- **reasoningEffort** (string, optional) 推理强度设置。
- **vision** (boolean) 是否支持图片输入。

### 4.5 模型协议与地址

**protocol** 取值为 `OpenAIChatCompletions` 、 `OpenAIResponses` 、 `AnthropicMessages` 或 `OllamaChat` 。**baseURL** 为无凭据、 Query 和片段的 HTTP(S) URL 。

## 5 模型代理

### 5.1 OpenAI Chat Completions

请求 `POST /llm/proxies/openai/v1/chat/completions`

请求体为 OpenAI Chat Completions 请求对象，须满足[代理请求约定](#55-代理请求与响应约定)。

响应转发上游状态码、 `Content-Type` 和正文。流式响应为 `text/event-stream` 。本地错误见[代理响应约定](#55-代理请求与响应约定)。

### 5.2 OpenAI Responses

请求 `POST /llm/proxies/openai/v1/responses`

请求体为 OpenAI Responses 请求对象，须满足[代理请求约定](#55-代理请求与响应约定)。

响应转发上游状态码、 `Content-Type` 和正文。流式响应为 `text/event-stream` 。本地错误见[代理响应约定](#55-代理请求与响应约定)。

### 5.3 Anthropic Messages

请求 `POST /llm/proxies/anthropic/v1/messages`

请求体为 Anthropic Messages 请求对象，须满足[代理请求约定](#55-代理请求与响应约定)。

响应转发上游状态码、 `Content-Type` 和正文。流式响应为 `text/event-stream` 。本地错误见[代理响应约定](#55-代理请求与响应约定)。

### 5.4 Ollama Chat

请求 `POST /llm/proxies/ollama/api/chat`

请求体为 Ollama Chat 请求对象，须满足[代理请求约定](#55-代理请求与响应约定)。

响应转发上游状态码、 `Content-Type` 和正文。流式响应为 `application/x-ndjson` 。本地错误见[代理响应约定](#55-代理请求与响应约定)。

### 5.5 代理请求与响应约定

请求体为至多 32 MiB 的 JSON 对象。

- **model** (string) 已配置的模型，格式为 `<providerID>/<modelID>` ，供应商协议须与代理 URI 匹配。代理用上游模型 ID 替换该字段，其余字段按上游协议转发。
- **stream** (boolean, optional) 为 `true` 时向上游请求对应的流式媒体类型。

代理本地错误响应

- `400` 请求体无效、超限或模型 ID 格式无效。
- `404` 对应协议下未配置该模型。
- `502` 请求上游失败。
- `504` 请求上游超时。

## 6 通用错误响应

- `403` 请求的来源或主机地址受限。
- `404` 接口不存在。
- `405` 接口拒绝当前 HTTP 方法。

本服务生成的 JSON 错误响应体

- **error** (object) 错误详情。
  - **code** (string) 错误代码。
  - **message** (string) 错误说明。
