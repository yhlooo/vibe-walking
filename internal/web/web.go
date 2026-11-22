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
	static, err := fs.Sub(assets, "dist")
	if err != nil {
		return nil, err
	}
	return http.FileServerFS(static), nil
}
