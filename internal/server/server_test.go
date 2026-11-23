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
	"testing"
	"time"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/pkg/config"
)

func TestSettingsAndModelProxies(t *testing.T) {
	type received struct {
		path, model, auth, key, version, cookie string
	}
	requests := make(chan received, 1)
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
	if got := send(handler, http.MethodGet, "/api/v1/settings", ""); got.Body.String() != "{\"model\":null}\n" {
		t.Fatalf("unconfigured settings: %s", got.Body)
	}
	if got := send(handler, http.MethodPost, "/llmproxies/responses", `{}`); got.Code != http.StatusNotFound {
		t.Fatalf("unconfigured proxy status: %d", got.Code)
	}

	for _, proxy := range modelProxies {
		body, _ := json.Marshal(config.Config{Model: config.ModelConfig{
			Protocol: proxy.protocol, BaseURL: upstream.URL + "/gateway/v1/", Model: "configured-model", APIKey: "test-secret",
		}})
		result := send(handler, http.MethodPost, "/api/v1/settings", string(body))
		if result.Code != http.StatusOK || strings.Contains(result.Body.String(), "test-secret") ||
			!strings.Contains(result.Body.String(), `"hasAPIKey":true`) {
			t.Fatalf("save settings: %d %s", result.Code, result.Body)
		}
		for _, candidate := range modelProxies {
			if candidate != proxy {
				result := send(handler, http.MethodPost, "/llmproxies"+candidate.suffix, `{}`)
				if result.Code != http.StatusNotFound || !strings.Contains(result.Body.String(), "proxy_not_enabled") {
					t.Fatalf("inactive proxy: %d %s", result.Code, result.Body)
				}
			}
		}
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/llmproxies"+proxy.suffix, strings.NewReader(`{"model":"ignored"}`))
		request.Header.Set("Authorization", "Bearer ignored")
		request.Header.Set("Cookie", "not-for-upstream=1")
		reply := httptest.NewRecorder()
		handler.ServeHTTP(reply, request)
		if reply.Code != http.StatusTooManyRequests || reply.Header().Get("Content-Type") != "application/json" ||
			!strings.Contains(reply.Body.String(), "fixture rate limit") {
			t.Fatalf("proxy response: %d %s", reply.Code, reply.Body)
		}
		got := <-requests
		want := received{path: "/gateway/v1" + proxy.suffix, model: "configured-model", auth: "Bearer test-secret"}
		if proxy.protocol == config.AnthropicMessagesAPI {
			want.auth, want.key, want.version = "", "test-secret", "2023-06-01"
		}
		if got != want {
			t.Errorf("unexpected upstream request for %s", proxy.protocol)
		}
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
	if !strings.Contains(got.Body.String(), `"api":"OllamaChat"`) {
		t.Fatalf("configuration after restart: %s", got.Body)
	}
	sameEndpoint := `{"model":{"api":"OllamaChat","baseURL":"` + upstream.URL + `/gateway/v1/","model":"new-model"}}`
	if got := send(restarted, http.MethodPost, "/api/v1/settings", sameEndpoint); !strings.Contains(got.Body.String(), `"hasAPIKey":true`) {
		t.Fatalf("same endpoint should retain the old API key: %s", got.Body)
	}
	differentEndpoint := strings.Replace(sameEndpoint, "/gateway/v1/", "/other/v1", 1)
	if got := send(restarted, http.MethodPost, "/api/v1/settings", differentEndpoint); !strings.Contains(got.Body.String(), `"hasAPIKey":false`) {
		t.Fatalf("different endpoint should drop the old API key: %s", got.Body)
	}
	if got := send(restarted, http.MethodPost, "/api/v1/settings", `{"model":null}`); got.Body.String() != "{\"model\":null}\n" {
		t.Fatalf("clear settings: %d %s", got.Code, got.Body)
	}
}

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
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/v1/settings", strings.NewReader(`{"model":null}`))
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

func TestSaveFailureKeepsTheActiveConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	handler, err := newHandler(dir, true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	previous := `{"model":{"api":"OpenAIResponses","baseURL":"http://127.0.0.1/v1","model":"previous"}}`
	if got := send(handler, http.MethodPost, "/api/v1/settings", previous); got.Code != http.StatusOK {
		t.Fatal(got.Code)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := send(handler, http.MethodPost, "/api/v1/settings", `{"model":null}`); got.Code != http.StatusInternalServerError {
		t.Fatalf("failed save should return 500, got %d", got.Code)
	}
	if got := send(handler, http.MethodGet, "/api/v1/settings", ""); !strings.Contains(got.Body.String(), `"model":"previous"`) {
		t.Fatalf("failed save changed active config: %s", got.Body)
	}
}

func send(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

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
	model := `{"model":{"api":"OpenAIResponses","baseURL":"https://example.com/v1","model":"mock"}}`
	if got := send(handler, http.MethodPost, "/api/v1/settings", model); !strings.Contains(got.Body.String(), `"maxInputToken":1000000`) {
		t.Fatalf("default context length: %s", got.Body)
	}
	model = strings.Replace(model, `"model":"mock"`, `"model":"mock","maxInputToken":32768,"reasoningEffort":"custom"`, 1)
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
		saved.Model == nil || saved.Model.MaxInputToken != 32768 || saved.Model.ReasoningEffort != "custom" {
		t.Fatalf("settings after restart: %s", got.Body)
	}
	got = send(restarted, http.MethodPost, "/api/v1/settings", `{"model":null}`)
	if err := json.Unmarshal(got.Body.Bytes(), &saved); err != nil || saved.Username != name || saved.Model != nil {
		t.Fatalf("clear model: %s", got.Body)
	}
}

func TestProxyFlushesEventsAndCancelsUpstream(t *testing.T) {
	t.Run("SSE", func(t *testing.T) {
		testProxyStream(t, config.OpenAIResponsesAPI, "/responses", "text/event-stream", "data: first\n")
	})
	t.Run("NDJSON", func(t *testing.T) {
		testProxyStream(t, config.OllamaChatAPI, "/api/chat", "application/x-ndjson", "{\"done\":false}\n")
	})
}

func testProxyStream(t *testing.T, protocol config.ModelAPIProtocol, path, mediaType, firstLine string) {
	t.Helper()
	stopped := make(chan struct{})
	unblock := make(chan struct{})
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
	settings := fmt.Sprintf(`{"model":{"api":%q,"baseURL":%q,"model":"fixture"}}`, protocol, upstream.URL)
	if reply := send(handler, http.MethodPost, "/api/v1/settings", settings); reply.Code != http.StatusOK {
		t.Fatalf("save model: %s", reply.Body)
	}
	proxy := httptest.NewServer(handler)
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, proxy.URL+"/llmproxies"+path, strings.NewReader(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	response, err := proxy.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
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
