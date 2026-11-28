package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/pkg/config"
)

// TestSettingsAndModelProxies 验证设置接口及模型代理的请求和响应。
func TestSettingsAndModelProxies(t *testing.T) {
	type received struct {
		path, model, auth, key, version, cookie string
	}
	requests := make(chan received, len(modelProxies))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Model string }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode upstream request: %v", err)
		}
		requests <- received{r.URL.Path, body.Model, r.Header.Get("Authorization"), r.Header.Get("x-api-key"),
			r.Header.Get("anthropic-version"), r.Header.Get("Cookie")}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"fixture rate limit"}}`))
	}))
	defer upstream.Close()

	dir := filepath.Join(t.TempDir(), ".vibewalking")
	path := filepath.Join(dir, "settings.json")
	handler, err := newHandler(dir, true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	if got := send(handler, http.MethodGet, "/api/v1/settings", ""); got.Body.String() != "{\"defaultModel\":\"\",\"modelProviders\":[]}\n" {
		t.Fatalf("unconfigured settings: %s", got.Body)
	}
	if got := send(handler, http.MethodPost, "/llm/proxies/openai/v1/responses", `{"model":"fixture/missing"}`); got.Code != http.StatusNotFound {
		t.Fatalf("unconfigured proxy status: %d", got.Code)
	}
	providers := make([]config.ModelProvider, 0, len(modelProxies))
	for i, proxy := range modelProxies {
		providers = append(providers, config.ModelProvider{
			ID: fmt.Sprintf("fixture-%d", i),
			Connection: config.Connection{Protocol: proxy.protocol,
				BaseURL: fmt.Sprintf("%s/gateway/%d/", upstream.URL, i), APIKey: fmt.Sprintf("test-secret-%d", i)},
			Models: []config.Model{{ID: "vendor/configured-model", Vision: true}},
		})
	}
	body, _ := json.Marshal(config.Config{DefaultModel: "fixture-1/vendor/configured-model", ModelProviders: providers})
	result := send(handler, http.MethodPost, "/api/v1/settings", string(body))
	if result.Code != http.StatusOK || strings.Contains(result.Body.String(), "test-secret") ||
		!strings.Contains(result.Body.String(), `"hasAPIKey":true`) {
		t.Fatalf("save settings: %d %s", result.Code, result.Body)
	}
	if got := send(handler, http.MethodPost, "/llm/proxies/openai/v1/responses", `{"model":"fixture-0/vendor/configured-model"}`); got.Code != http.StatusNotFound {
		t.Fatalf("wrong protocol status: %d %s", got.Code, got.Body)
	}
	if got := send(handler, http.MethodPost, "/llm/proxies/openai/v1/responses", `{"model":"unqualified"}`); got.Code != http.StatusBadRequest {
		t.Fatalf("unqualified model status: %d %s", got.Code, got.Body)
	}
	var pending sync.WaitGroup
	for i, proxy := range modelProxies {
		pending.Go(func() {
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/llm/proxies"+proxy.path,
				strings.NewReader(fmt.Sprintf(`{"model":%q}`, providers[i].ID+"/vendor/configured-model")))
			request.Header.Set("Authorization", "Bearer ignored")
			request.Header.Set("Cookie", "not-for-upstream=1")
			reply := httptest.NewRecorder()
			handler.ServeHTTP(reply, request)
			if reply.Code != http.StatusTooManyRequests || reply.Header().Get("Content-Type") != "application/json" ||
				!strings.Contains(reply.Body.String(), "fixture rate limit") {
				t.Errorf("proxy response: %d %s", reply.Code, reply.Body)
			}
		})
	}
	pending.Wait()
	close(requests)
	gotRequests := make(map[string]received)
	for got := range requests {
		gotRequests[got.path] = got
	}
	for i, proxy := range modelProxies {
		key := providers[i].APIKey
		want := received{path: fmt.Sprintf("/gateway/%d", i) + proxy.upstreamSuffix, model: "vendor/configured-model", auth: "Bearer " + key}
		if proxy.protocol == config.AnthropicMessagesAPI {
			want.auth, want.key, want.version = "", key, "2023-06-01"
		}
		if got := gotRequests[want.path]; got != want {
			t.Errorf("unexpected upstream request for %s: %#v", proxy.protocol, got)
		}
	}

	catalog := send(handler, http.MethodGet, "/llm/providers", "")
	if catalog.Code != http.StatusOK || strings.Contains(catalog.Body.String(), "test-secret") ||
		!strings.Contains(catalog.Body.String(), `"defaultModel":"fixture-1/vendor/configured-model"`) ||
		!strings.Contains(catalog.Body.String(), `"providers":[`) {
		t.Fatalf("provider catalog: %d %s", catalog.Code, catalog.Body)
	}

	info, err := os.Stat(path)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("settings file permissions: %v %v", info, err)
	}
	restarted, err := newHandler(dir, true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	got := send(restarted, http.MethodGet, "/api/v1/settings", "")
	if !strings.Contains(got.Body.String(), `"protocol":"OllamaChat"`) {
		t.Fatalf("configuration after restart: %s", got.Body)
	}
	sameEndpoint := fmt.Sprintf(`{"modelProviders":[{"id":"renamed","previousID":"fixture-3","protocol":"OllamaChat","baseURL":%q,"models":[{"id":"new-model"}]}]}`, upstream.URL+"/gateway/3/")
	if got := send(restarted, http.MethodPost, "/api/v1/settings", sameEndpoint); !strings.Contains(got.Body.String(), `"hasAPIKey":true`) {
		t.Fatalf("same endpoint should retain the old API key: %s", got.Body)
	}
	differentEndpoint := strings.Replace(strings.Replace(sameEndpoint, "fixture-3", "renamed", 1), "/gateway/3/", "/other/api", 1)
	if got := send(restarted, http.MethodPost, "/api/v1/settings", differentEndpoint); !strings.Contains(got.Body.String(), `"hasAPIKey":false`) {
		t.Fatalf("different endpoint should drop the old API key: %s", got.Body)
	}
	if got := send(restarted, http.MethodPost, "/api/v1/settings", `{"modelProviders":[]}`); got.Body.String() != "{\"defaultModel\":\"\",\"modelProviders\":[]}\n" {
		t.Fatalf("clear settings: %d %s", got.Code, got.Body)
	}
}

// TestStaticAssetsAndOriginGuard 验证静态页面和跨域请求拦截。
func TestStaticAssetsAndOriginGuard(t *testing.T) {
	handler, err := newHandler(t.TempDir(), true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	if got := send(handler, http.MethodGet, "/", ""); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "Vibe Walking") {
		t.Fatalf("embedded page: %d %s", got.Code, got.Body)
	}
	if got := send(handler, http.MethodGet, "/api/v1/unknown", ""); got.Code != http.StatusNotFound {
		t.Fatalf("unknown API status: %d", got.Code)
	}
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/v1/settings", strings.NewReader(`{"modelProviders":[]}`))
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	reply := httptest.NewRecorder()
	handler.ServeHTTP(reply, request)
	if reply.Code != http.StatusForbidden {
		t.Fatalf("cross-origin write status: %d", reply.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "http://example.test/", nil)
	reply = httptest.NewRecorder()
	handler.ServeHTTP(reply, request)
	if reply.Code != http.StatusForbidden {
		t.Fatalf("non-loopback Host status: %d", reply.Code)
	}
}

// TestSaveFailureKeepsTheActiveConfig 验证配置写入失败时服务继续使用已发布的配置。
func TestSaveFailureKeepsTheActiveConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	handler, err := newHandler(dir, true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	previous := `{"modelProviders":[{"id":"default","protocol":"OpenAIResponses","baseURL":"http://127.0.0.1/v1","models":[{"id":"previous"}]}]}`
	if got := send(handler, http.MethodPost, "/api/v1/settings", previous); got.Code != http.StatusOK {
		t.Fatal(got.Code)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := send(handler, http.MethodPost, "/api/v1/settings", `{"modelProviders":[]}`); got.Code != http.StatusInternalServerError {
		t.Fatalf("failed save should return 500, got %d", got.Code)
	}
	if got := send(handler, http.MethodGet, "/api/v1/settings", ""); !strings.Contains(got.Body.String(), `"defaultModel":"default/previous"`) {
		t.Fatalf("failed save changed active config: %s", got.Body)
	}
}

// send 构造本地 HTTP 请求并捕获处理结果。
func send(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// TestUsernameAndModelOptionsAreSavedIndependently 验证用户名和模型设置可独立更新。
func TestUsernameAndModelOptionsAreSavedIndependently(t *testing.T) {
	dir := t.TempDir()
	handler, err := newHandler(dir, true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	name := " " + strings.Repeat("🙂", 18) + " "
	settings, _ := json.Marshal(map[string]string{"username": name})
	if got := send(handler, http.MethodPost, "/api/v1/settings", string(settings)); got.Code != http.StatusOK {
		t.Fatalf("save username: %d %s", got.Code, got.Body)
	}
	settings, _ = json.Marshal(map[string]string{"username": name + "界"})
	if got := send(handler, http.MethodPost, "/api/v1/settings", string(settings)); got.Code != http.StatusBadRequest {
		t.Fatalf("overlength username: %d %s", got.Code, got.Body)
	}
	model := `{"modelProviders":[{"id":"default","protocol":"OpenAIResponses","baseURL":"https://example.com/v1","models":[{"id":"mock"}]}]}`
	if got := send(handler, http.MethodPost, "/api/v1/settings", model); !strings.Contains(got.Body.String(), `"maxInputToken":1000000`) {
		t.Fatalf("default context length: %s", got.Body)
	}
	model = strings.Replace(model, `"id":"mock"`, `"id":"mock","maxInputToken":32768,"reasoningEffort":"custom"`, 1)
	if got := send(handler, http.MethodPost, "/api/v1/settings", model); got.Code != http.StatusOK {
		t.Fatalf("save model options: %d %s", got.Code, got.Body)
	}
	restarted, err := newHandler(dir, true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	got := send(restarted, http.MethodGet, "/api/v1/settings", "")
	var saved settingsSummary
	if err := json.Unmarshal(got.Body.Bytes(), &saved); err != nil || saved.Username != name ||
		len(saved.ModelProviders) != 1 || len(saved.ModelProviders[0].Models) != 1 ||
		saved.ModelProviders[0].Models[0].MaxInputToken != 32768 || saved.ModelProviders[0].Models[0].ReasoningEffort != "custom" {
		t.Fatalf("settings after restart: %s", got.Body)
	}
	got = send(restarted, http.MethodPost, "/api/v1/settings", `{"modelProviders":[]}`)
	if err := json.Unmarshal(got.Body.Bytes(), &saved); err != nil || saved.Username != name || len(saved.ModelProviders) != 0 {
		t.Fatalf("clear model: %s", got.Body)
	}
}

// TestProxyFlushesEventsAndCancelsUpstream 验证代理实时返回流式数据并向上游传递取消。
func TestProxyFlushesEventsAndCancelsUpstream(t *testing.T) {
	t.Run("SSE", func(t *testing.T) {
		testProxyStream(t, config.OpenAIResponsesAPI, "/openai/v1/responses", "text/event-stream", "data: first\n")
	})
	t.Run("NDJSON", func(t *testing.T) {
		testProxyStream(t, config.OllamaChatAPI, "/ollama/api/chat", "application/x-ndjson", "{\"done\":false}\n")
	})
}

// testProxyStream 用可控制的上游验证指定协议的传输与取消。
func testProxyStream(t *testing.T, protocol config.ModelAPIProtocol, path, mediaType, firstLine string) {
	t.Helper()
	stopped := make(chan struct{})
	unblock := make(chan struct{})

	// 上游发出首行后主动保持连接，测试因此能区分流式转发和一次性响应。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if accept := r.Header.Get("Accept"); accept != mediaType {
			t.Errorf("upstream Accept = %q", accept)
		}
		w.Header().Set("Content-Type", mediaType)
		fmt.Fprint(w, firstLine)
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("flush upstream: %v", err)
		}
		select {
		case <-r.Context().Done():
			close(stopped)
		case <-unblock:
		}
	}))
	defer upstream.Close()
	defer close(unblock)

	handler, err := newHandler(t.TempDir(), true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	settings := fmt.Sprintf(`{"modelProviders":[{"id":"default","protocol":%q,"baseURL":%q,"models":[{"id":"fixture"}]}]}`, protocol, upstream.URL)
	if reply := send(handler, http.MethodPost, "/api/v1/settings", settings); reply.Code != http.StatusOK {
		t.Fatalf("save model: %s", reply.Body)
	}
	proxy := httptest.NewServer(handler)
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, proxy.URL+"/llm/proxies"+path, strings.NewReader(`{"stream":true,"model":"default/fixture"}`))
	if err != nil {
		t.Fatal(err)
	}
	response, err := proxy.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	// 上游仍在等待时读取首行，再取消浏览器请求并等待上游观察到取消。
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != firstLine {
		t.Fatalf("first event before upstream ends: %q, %v", line, err)
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("browser cancellation did not reach upstream")
	}
}
