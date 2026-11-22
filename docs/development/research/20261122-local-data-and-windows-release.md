# 本地数据目录与 Windows 发布调查

- Go 的 `os.UserHomeDir()` 在 Linux 和 macOS 上读取 `HOME`，在 Windows 上读取 `USERPROFILE`。配合 `filepath.Join` 可在三平台用同一个目录名。显式指定 `-d` 时可以跳过主目录解析。[Go 标准库](../reference/local-data-and-windows-release.md)
- GoReleaser 的 `format_overrides` 可按操作系统选用不同的归档格式，因此可以沿用 `tar.gz`，同时为 Windows 生成 PowerShell 能直接解压的 ZIP。Docker 配置通过 `platforms` 继续选择 Linux 构建产物。[GoReleaser 与 PowerShell 文档](../reference/local-data-and-windows-release.md)
- PowerShell 脚本可通过 `$args` 读取 `--run`。WOW64 提供 `PROCESSOR_ARCHITEW6432` 指示原生架构，原生进程使用 `PROCESSOR_ARCHITECTURE`。Windows URL 通过 `ShellExecuteW` 调用系统注册的处理程序。[PowerShell 与 Windows 文档](../reference/local-data-and-windows-release.md)
