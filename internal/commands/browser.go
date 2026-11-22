//go:build !windows

package commands

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"
)

func openBrowser(ctx context.Context, address string) error {
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
