//go:build !windows

package commands

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"
)

// openBrowser 根据系统选择打开默认浏览器的命令。
func openBrowser(ctx context.Context, address string) error {
	// 限制外部启动命令的等待时间，让调用方可以及时报告失败。
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	switch runtime.GOOS {
	case "darwin":
		return exec.CommandContext(ctx, "open", address).Run()
	case "linux":
		return exec.CommandContext(ctx, "xdg-open", address).Run()
	default:
		return fmt.Errorf("automatic browser opening is unavailable on %s", runtime.GOOS)
	}
}
