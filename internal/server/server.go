// Package server 提供本地游戏 API、设置 API 和模型服务代理。
package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/internal/web"
	"github.com/yhlooo/vibe-walking/levels"
	"github.com/yhlooo/vibe-walking/pkg/config"
)

// Serve starts the local application and serves it until ctx is canceled.
func Serve(ctx context.Context, address, dataDir string, onListen func(string)) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid listen address: %w", err)
	}
	if host == "" {
		host = "0.0.0.0"
	}

	// 根据监听地址决定是否限制客户端使用回环主机访问。
	handler, err := newHandler(dataDir, loopbackHost(host), logr.FromContextOrDiscard(ctx))
	if err != nil {
		return err
	}

	// 显式 IPv4 地址使用 IPv4 监听，其余地址交由通用 TCP 监听处理。
	network := "tcp"
	if net.ParseIP(host).To4() != nil {
		network = "tcp4"
	}
	listener, err := net.Listen(network, net.JoinHostPort(host, port))
	if err != nil {
		return err
	}
	defer listener.Close()

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	// 后台监听的结果通过带缓冲通道汇报，便于统一等待退出。
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()

	// 用实际端口生成浏览器地址，通配地址改用本机回环地址。
	bound := listener.Addr().(*net.TCPAddr)
	if bound.IP.IsUnspecified() {
		host = "127.0.0.1"
		if bound.IP.To4() == nil {
			host = "::1"
		}
	}
	if onListen != nil {
		onListen("http://" + net.JoinHostPort(host, fmt.Sprint(bound.Port)) + "/")
	}

	select {
	case err := <-serveDone:
		return err
	case <-ctx.Done():
		// 为优雅关闭单独分配超时时间。
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			server.Close()
			return err
		}
		if err := <-serveDone; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

// newHandler 初始化应用依赖并绑定 API、模型代理和静态资源路由。
func newHandler(dataDir string, localOnly bool, logger logr.Logger) (http.Handler, error) {
	settingsPath := filepath.Join(dataDir, "settings.json")
	cfg, err := config.LoadConfig(settingsPath)
	if err != nil {
		return nil, err
	}

	static, err := web.Handler()
	if err != nil {
		return nil, err
	}

	library, err := levels.NewStore(dataDir)
	if err != nil {
		return nil, err
	}

	// 限制上游响应头等待时间并阻止重定向转发凭据。
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 60 * time.Second
	s := &service{
		levels: library,
		path:   settingsPath, settings: *cfg, logger: logger,
		client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}

	// 为 API 路由统一拦截跨站请求。
	guard := http.NewCrossOriginProtection()
	guard.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusForbidden, "cross_origin", "此请求必须来自游戏页面")
	}))

	mux := http.NewServeMux()
	mux.Handle("/api/v1/settings", guard.Handler(http.HandlerFunc(s.handleSettings)))
	mux.Handle("POST /llm/providers/models", guard.Handler(http.HandlerFunc(s.handleModels)))
	mux.Handle("/api/v1/levels", guard.Handler(http.HandlerFunc(s.handleLevels)))
	mux.Handle("/api/v1/levels/{id}", guard.Handler(http.HandlerFunc(s.handleLevel)))
	mux.Handle("/api/v1/progress", guard.Handler(http.HandlerFunc(s.handleProgress)))
	mux.Handle("/api/v1/progress/{id}", guard.Handler(http.HandlerFunc(s.handleLevelProgress)))
	mux.Handle("GET /llm/providers", guard.Handler(http.HandlerFunc(s.handleProviders)))
	mux.Handle("GET /llm/providers/{providerID}/models", guard.Handler(http.HandlerFunc(s.handleProviderModels)))
	for _, proxy := range modelProxies {
		mux.Handle("/llm/proxies"+proxy.path, guard.Handler(s.proxy(proxy)))
	}

	// 为未知 API 请求返回 JSON 错误，避免落入静态资源路由。
	for _, path := range []string{"/api/v1", "/api/v1/", "/llm/", "/llm"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			writeError(w, http.StatusNotFound, "not_found", "接口不存在")
		})
	}
	mux.Handle("/", static)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if localOnly && !loopbackHost(r.Host) {
			writeError(w, http.StatusForbidden, "invalid_host", "此服务仅接受本地访问地址")
			return
		}
		mux.ServeHTTP(w, r)
	}), nil
}

// loopbackHost 识别可以访问仅本地服务的回环主机名或地址。
func loopbackHost(host string) bool {
	// 分别兼容带端口的 Host、localhost 名称和 IP 地址。
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	ip, err := netip.ParseAddr(strings.Trim(host, "[]"))
	return err == nil && ip.Unmap().IsLoopback()
}
