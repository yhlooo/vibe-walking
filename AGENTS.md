# AGENTS.md

> NOTE: 该文件的修改必须经过用户确认。除非用户要求，否则不应直接修改。

## 项目结构

```text
cmd/
└── vibe-walking/   Go 程序入口
internal/
├── commands/      命令行子命令与应用启动
├── server/        本地 HTTP 服务、关卡与设置 API、模型请求代理
└── web/           前端静态资源嵌入
pkg/
└── config/        应用配置及其本地存储
levels/            内置关卡、用户自建关卡和游玩进度管理
src/               TypeScript 前端
├── agent/         模型协议、流式响应、对话上下文与工具调用
├── editor/        关卡编辑器
├── game/          游戏规则、动作处理与运行状态
├── level/         前端关卡定义、校验与导入导出
├── render/        游戏场景绘制与截图
├── storage/       关卡和游玩进度的 API 客户端
└── ui/            首页、关卡列表、游玩界面与模型设置
tests/             前端测试及测试数据
```

## 构建前端静态资源

前端项目以仓库根目录为根，需要 Node.js 22.12 或更高版本。从仓库根目录运行以下命令。

```sh
npm ci
npm run build
```

`npm ci` 根据 `package-lock.json` 安装依赖。`npm run build` 先做 TypeScript 类型检查，再由 Vite 将 `index.html` 和打包后的资源输出到 `internal/web/dist/`。依赖已安装且锁文件未变更时，重新构建只需运行 `npm run build`。

`internal/web/dist/` 由 Git 忽略。Go 编译时通过 `go:embed` 将该目录嵌入二进制。首次检出后，应先构建前端再运行 `go build`、`go run` 或 `go test ./...`。修改前端后，重新构建前端和 Go 程序即可更新嵌入的资源。

## 开发文档

开发过程中的调查、设计方案、参考的外部资料必须落地文档。它们用于帮助你和其它刚接触该项目的开发者快速了解这个项目。

```
docs/development/
├── design/
│   ├── 20250902-apis.deprecated.md
│   ├── 20250904-apis.draft1.md
│   ├── 20250904-apis.preview.md
│   └── 20260905-xxx.md
├── reference/
│   ├── local-data-and-windows-release.md
│   └── llm/
│       ├── multiple-tool-calls.md
│       └── llm-streaming.md
├── research/
│   └── 20250905-xxx.md
└── specs/
    ├── apis.md
    └── cli-usages.md
```

- `docs/development/discuss` 中存放关于这个项目的一些关键讨论，它帮助你了解关于这个项目的一些背景信息，一般来说你不需要记录任何内容到其中，除非用户要求你把这次的对话记录下来。它通常是由用户自己维护的。
- `docs/development/reference` 中存放用于参考的外部技术规格说明、接口文档等，应该是直接引用、完全不经主观加工的。无固定的结构要求，可以按照合理方式组织。
- `docs/development/research` 每个调查主题一份文档，用于存放调查结论。文件名 `{YYYYMMDD}-{topic}.md`
- `docs/development/design` 每个设计方案一份文档。文件名 `{YYYYMMDD}-{topic}.md`

  文件名后缀：

    - `.draft{n}` 后缀表示设计草案，比如 `20250904-apis.draft1.md` 表示是第一版草案。草案可以用于讨论，但不能用于实际开发。
    - `.deprecated` 后缀表示废案，比如 `20250902-apis.deprecated.md` 。废案可以是从草案未实现就放弃的，也可以是从生效文档废弃的（重构修改了设计），总之废案是不能准确表示该项目当前设计的文档。
    - `.preview` 后缀表示预览版，比如 `20250904-apis.preview.md` 。预览版文档是已经采纳但是还未实现的设计文档（不久的将来会实现的）。

- `docs/development/specs` 定义文档，每个主题一份。一般是从 design 中提取，关于这个项目当前机制、表现的定义。需要跟随实现变更同步调整。这些文档的更新应该慎重，与用户讨论后确定。

> 注意：开发过程中一般只应修改 docs/development 中的开发文档， docs/usage 、 README.md 中的文档是面向最终用户的，除非用户要求，否则不应直接修改。

### 没有调查就没有发言权

“你对于某个问题没有调查，就停止你对于某个问题的发言权。”一位伟人曾经这样说。当你接触一个新的领域的时候你首先需要对这个领域进行调查，调查的目的是获取思考工作所需的信息。

调查应该是顺着思路进行的，而不是盲目的。调查是针对外部的，而不是本项目（你应该了解自己工作的项目，而不是调查它），比如本项目涉及的外部系统接口、技术规范、引用的外部组件库等。

调查的成果必须通过文档落地：

- `docs/development/reference` 中存放用于参考的外部技术规格说明、接口文档等，应该是直接引用、完全不经主观加工的。调查过程中收集的外部资料应该放在这里。
- `docs/development/research` 每个调查主题一份文档，用于存放调查结论，涉及外部系统接口、技术规范的关键结论需要有 reference 中的参考文档支撑（不能通过猜测得出结论）。

## 如何做一个好 Agent

作为协助用户的智能助手（ Agent ），你具有以下优良品质：

- **正直善良** ：坚守道德底线，遵守规范要求，不偷奸耍滑，不恶意绕过安全限制，不向用户隐瞒过错。
- **耐心细致** ：做事的时候不急躁冒进，遇到困难仔细分析。不要急于说“这次好了，你再试一下”，自己先想想真的好了吗，我是否真的解决了用户问题。
- **实事求是** ：古代一位智者所说：“知之为知之，不知为不知，是知也”，伟人也曾说过“主动权来自实事求是”。你的言行应该基于你所掌握的事实，只有这样你才能赢得用户的信任。

## 关注架构设计

架构设计需要尤为慎重，坏的架构将导致可修改性破坏，脆弱的逻辑往往诞生于不合理的架构中。不要急于确定一个模块的架构设计，从多个不同角度推敲，自然地推导出合理的设计。

每当设计一个功能模块尝试考虑这样几个问题：

1. 这个模块的功能是什么，边界如何定义？
2. 这个模块与其它关联模块通过什么方式交互？
3. 这个模块具有什么样的接口？

抛开具体的问题，从更高的视角单独审视上述问题的回答，这些回答是否合理（合理指它们清爽、优雅、易于理解）？如果不合理应该如何修改？重复这些思考直到自己觉得满意。

## 注释风格

适当的注释有助于你和其它开发者快速理解代码逻辑。

- 一般应在每一小段逻辑单元前加一个简单的注释说明这几行代码实现什么功能。但是注释也不应过于密集。
- 遵循语言规范在包、方法、类型、结构体字段上添加简短的说明

示例：

```go
package main

import (
  "context"
  "fmt"
  "io"
  "log"
  "net/http"
)

func main() {
  ctx := context.Background()

  // 发送请求
  content, err := sendRequest(ctx, "https://example.com")
  if err != nil {
    log.Fatal(err)
  }

  // 输出结果
  fmt.Println(content)
}

// sendRequest 发送请求
func sendRequest(ctx context.Context, url string) ([]byte, error) {
  // 构造请求
  req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
  if err != nil {
    return nil, fmt.Errorf("make request error: %w", err)
  }

  // 发送请求
  resp, err := http.DefaultClient.Do(req)
  if err != nil {
    return nil, fmt.Errorf("send request error: %w", err)
  }
  defer func() { _ = resp.Body.Close() }()
  
  // 处理响应
  if resp.StatusCode != http.StatusOK {
    raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
    return nil, fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(raw))
  }
  
  // 读取响应
  raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
  if err != nil {
	  return nil, fmt.Errorf("read response body error: %w", err)
  }
  
  return raw,nil
}
```
