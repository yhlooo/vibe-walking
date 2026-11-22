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
	handler, err := newHandler(dataDir, loopbackHost(host), logr.FromContextOrDiscard(ctx))
	if err != nil {
		return err
	}
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
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
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
	s := &service{
		levels: library,
		path:   settingsPath, model: cfg.Model, logger: logger,
		client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
	guard := http.NewCrossOriginProtection()
	guard.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusForbidden, "cross_origin", "此请求必须来自游戏页面")
	}))
	mux := http.NewServeMux()
	mux.Handle("/api/v1/settings", guard.Handler(http.HandlerFunc(s.handleSettings)))
	mux.Handle("/api/v1/levels", guard.Handler(http.HandlerFunc(s.handleLevels)))
	mux.Handle("/api/v1/levels/{id}", guard.Handler(http.HandlerFunc(s.handleLevel)))
	mux.Handle("/api/v1/progress", guard.Handler(http.HandlerFunc(s.handleProgress)))
	mux.Handle("/api/v1/progress/{id}", guard.Handler(http.HandlerFunc(s.handleLevelProgress)))
	for _, proxy := range modelProxies {
		mux.Handle("/llmproxies"+proxy.suffix, guard.Handler(http.HandlerFunc(s.proxy(proxy))))
	}
	for _, path := range []string{"/api/v1", "/api/v1/", "/llmproxies", "/llmproxies/"} {
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

func loopbackHost(host string) bool {
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	ip, err := netip.ParseAddr(strings.Trim(host, "[]"))
	return err == nil && ip.Unmap().IsLoopback()
}
