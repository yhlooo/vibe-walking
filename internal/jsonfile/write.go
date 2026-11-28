// Package jsonfile writes local JSON data atomically.
package jsonfile

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
)

// Write replaces path only after its complete contents have been written.
func Write(ctx context.Context, path string, value any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	// 在目标目录创建临时文件，以便在同一文件系统中替换目标。
	tmp, err := os.CreateTemp(dir, ".write-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	encoder := json.NewEncoder(tmp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return err
	}

	// 写入并关闭临时文件后，再检查取消状态并发布。
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
