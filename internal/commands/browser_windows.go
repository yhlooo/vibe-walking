package commands

import (
	"context"

	"golang.org/x/sys/windows"
)

func openBrowser(ctx context.Context, address string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	url, err := windows.UTF16PtrFromString(address)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, nil, url, nil, nil, windows.SW_SHOWNORMAL)
}
