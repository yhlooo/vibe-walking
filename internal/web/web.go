// Package web 将前端构建产物嵌入 Go 程序并通过 HTTP 提供。
package web

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed dist
var assets embed.FS

// Handler serves the embedded frontend build.
func Handler() (http.Handler, error) {
	// 把 dist 作为 HTTP 文件根目录，使访问路径直接对应构建资源。
	static, err := fs.Sub(assets, "dist")
	if err != nil {
		return nil, err
	}
	return http.FileServerFS(static), nil
}
