# 命令行参数

## 通用参数

| 参数 | 作用 |
| --- | --- |
| `-v, --verbose <0\|1\|2>` | 设置日志级别。`0` 为 Info（默认），`1` 为 Debug，`2` 为 Trace。 |
| `-h, --help` | 显示当前命令的帮助。也可用 `vibe-walking help [命令]` 查看指定命令的帮助。 |

## `vibe-walking`

| 参数 | 作用 |
| --- | --- |
| `-l, --listen <地址:端口>` | 设置 HTTP 监听地址，默认 `127.0.0.1:2333`。 |
| `-d, --data-dir <目录>` | 设置配置、关卡和游玩进度的本地存储目录，默认 `~/.vibewalking`。 |
| `--open-browser[=true\|false]` | 启动后自动打开浏览器，默认为 `true`，用 `--open-browser=false` 关闭。 |
| `--version` | 显示版本号并退出。 |
