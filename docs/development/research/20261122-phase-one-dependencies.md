# 一期本地服务与模型接入调查

调查依据见[一期外部技术资料](../reference/phase-one-dependencies.md)，调查日期为 2026-11-22。

## 本地服务与前端构建

- Vite 的 `build.outDir` 相对于前端项目根目录。Go 的嵌入模式要求在编译时匹配文件或非空目录。因此可以保留根目录的 TypeScript 项目，把构建产物输出到 `internal/web/dist`，再由 Go 编译进二进制。开发和发布均须先构建前端。[Vite `build.outDir`](https://vite.dev/config/build-options#build-outdir) [Go `embed`](https://pkg.go.dev/embed)
- 发布配置沿用 `dockers_v2`，它要求 GoReleaser 2.12 或更新版本。归档使用 `archives.formats` 指定 `tar.gz`，文件名与安装脚本一致。[GoReleaser Docker (v2)](https://goreleaser.com/customization/package/dockers_v2/) [GoReleaser Archives](https://goreleaser.com/customization/package/archives/)
- 浏览器从 Go 程序取得页面并请求同源代理，Go 通过 HTTP 客户端访问上游。这使模型接入依赖上游的协议和鉴权能力，同源浏览器请求无需上游提供 CORS 响应。Go 的 `CrossOriginProtection` 可拦截第三方网页发来的跨源写请求。[Go `net/http`](https://pkg.go.dev/net/http#CrossOriginProtection)
- `localStorage` 属于网页来源，所以通过不同域名或端口打开游戏时会看到各自的草稿与进度。模型配置由 Go 程序从文件读取，可供同一进程的页面使用。关卡 YAML 用于在来源间传递关卡。[WHATWG HTML Standard — Web storage](https://html.spec.whatwg.org/multipage/webstorage.html#dom-localstorage-dev)

## 三种模型协议的截图和工具调用

- **OpenAI Chat Completions** 的工具消息以 `tool_call_id` 关联调用，内容只支持文本。其用户消息支持 `image_url`。因此可以在 `tool` 消息写入 `Ok`，下一条消息带图片，在下一次请求内一起发送。[Chat Completions API Reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- **OpenAI Responses** 的 `function_call_output` 支持图片数组，通过 `call_id` 关联调用。PNG Data URL 可以直接作为 `input_image.image_url`。使用 `store: false` 时，客户端可以回送各响应项及工具结果，推理项随原历史保留。[Responses API Reference](https://developers.openai.com/api/reference/resources/responses/methods/create) [OpenAI Reasoning models](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)
- **Anthropic Messages** 用 `tool_use` 和 `tool_result` 表达调用及结果。结果必须紧跟工具调用所在的助手消息，放在下一条 `user` 消息的开头。其内容可放 Base64 图片。用 `disable_parallel_tool_use` 配合 `auto` 可限制每次响应最多一次调用。[Claude Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) [Claude Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) [Claude Messages API Reference](https://platform.claude.com/docs/en/api/http/messages/create)
- 两种 OpenAI 协议共享 Bearer 鉴权，Claude Messages 使用 `x-api-key` 和 API 版本头。设计选择固定 `anthropic-version: 2023-06-01`，采用这一版本的请求契约进行联调。[OpenAI Authentication](https://developers.openai.com/api/reference/overview/#authentication) [Claude Messages API Reference](https://platform.claude.com/docs/en/api/http/messages/create) [Claude API versions](https://platform.claude.com/docs/en/api/versioning?version=2023-06-01)

三个适配器可以共享截图生成和工具执行逻辑。它们各自保留对话历史的协议结构，代理转发相应的 JSON 协议。这些结论来自文档，实际模型与配置的兼容性需以一期的三协议通关联调验证。

## YAML 导入

`yaml` 2.x 的 `parseDocument` 适合单个关卡文件，解析错误可用于生成导入提示。可用 `uniqueKeys` 检查重复键，转换为 JS 时用 `maxAliasCount: 0` 拒绝别名，再由关卡校验器检查方块、坐标和字段。JSON 和 YAML 可以共用这一套关卡校验。[yaml 2.x 文档](https://eemeli.org/yaml/)
