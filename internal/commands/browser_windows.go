package commands

import (
	"context"

	"golang.org/x/sys/windows"
)

// openBrowser 使用 Windows 的 URL 处理器打开默认浏览器。
func openBrowser(ctx context.Context, address string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	// 将地址转换为 Windows Shell 接口要求的 UTF-16 字符串。
	url, err := windows.UTF16PtrFromString(address)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, nil, url, nil, nil, windows.SW_SHOWNORMAL)
}
