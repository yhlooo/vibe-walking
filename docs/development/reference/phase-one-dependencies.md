# 一期外部技术资料

## Go 与 Vite

> After that, each pattern in a //go:embed line must match at least one file or non-empty directory.

[Go `embed`](https://pkg.go.dev/embed)

> Handler returns a handler that applies cross-origin checks before invoking the handler h.

[Go `net/http` — `CrossOriginProtection.Handler`](https://pkg.go.dev/net/http#CrossOriginProtection.Handler)

> Specify the output directory (relative to project root).

[Vite `build.outDir`](https://vite.dev/config/build-options#build-outdir)

## GoReleaser

> Since v2.12.

[GoReleaser Docker (v2)](https://goreleaser.com/customization/package/dockers_v2/)

[GoReleaser Archives](https://goreleaser.com/customization/package/archives/)

## OpenAI Chat Completions

> For tool messages, only type `text` is supported.

[OpenAI API Reference — Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

## OpenAI Responses

> For functions that return images or files, you can pass an array of image or file objects instead of a string.

[OpenAI Function calling — Formatting results](https://developers.openai.com/api/docs/guides/function-calling#formatting-results)

> A fully qualified URL or base64 encoded image in a data URL.

[OpenAI API Reference — Create a model response](https://developers.openai.com/api/reference/resources/responses/methods/create)

> To use `all_turns` with `store: false`, preserve every output item, append the next user message, and replay the complete history:

[OpenAI Reasoning models — Preserve reasoning without stored responses](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)

> Provide API credentials with HTTP Bearer authentication.

[OpenAI API Reference — Authentication](https://developers.openai.com/api/reference/overview/#authentication)

## Anthropic Messages

> These content blocks can use the `text`, `image`, `document`, or `search_result` types.

[Claude Platform Docs — Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)

> When the `tool_choice` type is `auto` (the default), setting `disable_parallel_tool_use: true` means Claude calls at most one tool in each response.

[Claude Platform Docs — Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)

[Claude API Reference — Create a Message](https://platform.claude.com/docs/en/api/http/messages/create)

[Claude Platform Docs — API versions](https://platform.claude.com/docs/en/api/versioning?version=2023-06-01)

## HTML Standard

> Returns a data: URL for the image in the canvas.

[WHATWG HTML Standard — `canvas.toDataURL()`](https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-todataurl)

> Returns the `Storage` object associated with `window`'s origin's local storage area.

[WHATWG HTML Standard — `localStorage`](https://html.spec.whatwg.org/multipage/webstorage.html#dom-localstorage-dev)

## `yaml` 2.x

> Parses a single `Document` from the input `str`; used internally by `parse`.

> `0` disallows all alias nodes.

[yaml 2.x 文档](https://eemeli.org/yaml/)
