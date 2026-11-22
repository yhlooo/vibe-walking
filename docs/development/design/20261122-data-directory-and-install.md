# 本地数据目录与跨平台安装

启动命令使用 `-d` 或 `--data-dir` 指定数据目录。相对路径以启动时的工作目录为基准。未指定时，Linux 和 macOS 使用 `$HOME/.vibewalking`，Windows 使用 `%USERPROFILE%\.vibewalking`。原有默认目录和文件格式可继续使用。

服务以数据目录为根定位以下文件，首次保存时按需创建目录。

| 相对路径 | 内容 |
| --- | --- |
| `settings.json` | 模型设置 |
| `levels/<id>.json` | 自定义关卡和草稿 |
| `progress.json` | 游戏进度、通关记录和未完成尝试 |

GoReleaser 为 Linux、macOS 和 Windows 分别构建 amd64、arm64 可执行文件。Linux 和 macOS 归档使用 `.tar.gz`，Windows 使用 `.zip`，可执行文件位于归档根目录。容器镜像继续使用两个 Linux 架构。

`bash scripts/install.sh [version] [--run]` 和 `.\scripts\install.ps1 [version] [--run]` 默认安装最新版本，可通过位置参数选择发布标签。`--run` 可以放在版本前面或后面，安装成功后在前台启动游戏。两个脚本均接受 `INSTALL_DIR` 环境变量覆盖可执行文件的安装位置。Shell 脚本默认安装到 `~/.local/bin`。Windows 脚本默认安装到 `%LOCALAPPDATA%\Programs\vibe-walking`，并将安装目录加入当前进程及用户的 `PATH`。Windows 游戏进程使用系统默认浏览器打开页面。
