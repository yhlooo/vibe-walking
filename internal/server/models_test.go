package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-logr/logr"
)

func TestModelDiscoveryWithDraftConnection(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("list request method: %s", r.Method)
		}
		switch r.URL.Path {
		case "/gateway/v1/models":
			if r.Header.Get("Authorization") != "Bearer draft" {
				t.Error("OpenAI discovery must send the draft key")
			}
			fmt.Fprint(w, `{"data":[{"id":"model-a"},{"id":"model-a"}]}`)
		case "/claude/v1/models":
			if r.Header.Get("x-api-key") != "saved" || r.Header.Get("anthropic-version") != "2023-06-01" {
				t.Error("Anthropic discovery must use the saved key and set the API version")
			}
			if r.URL.Query().Get("after_id") == "first+id" {
				fmt.Fprint(w, `{"data":[{"id":"second"}],"has_more":false}`)
			} else {
				fmt.Fprint(w, `{"data":[{"id":"first+id"}],"has_more":true,"last_id":"first+id"}`)
			}
		case "/ollama/api/tags":
			if r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != "" {
				t.Error("local Ollama should have no credentials")
			}
			fmt.Fprint(w, `{"models":[{"name":"legacy:latest"},{"model":"vision:latest","name":"ignored"}]}`)
		case "/unavailable/models":
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, "private upstream response")
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()
	handler, err := newHandler(t.TempDir(), true, logr.Discard())
	if err != nil {
		t.Fatal(err)
	}
	settings := fmt.Sprintf(`{"model":{"api":"AnthropicMessages","baseURL":%q,"apiKey":"saved","model":"selected"}}`, upstream.URL+"/claude/v1")
	if reply := send(handler, http.MethodPost, "/api/v1/settings", settings); reply.Code != http.StatusOK {
		t.Fatalf("save settings: %s", reply.Body)
	}

	for _, tc := range []struct {
		protocol, path, key, want string
	}{
		{"OpenAIChatCompletions", "/gateway/v1", `,"apiKey":"draft"`, `{"models":["model-a"]}`},
		{"OpenAIResponses", "/gateway/v1/", `,"apiKey":"draft"`, `{"models":["model-a"]}`},
		{"AnthropicMessages", "/claude/v1/", "", `{"models":["first+id","second"]}`},
		{"OllamaChat", "/ollama", "", `{"models":["legacy:latest","vision:latest"]}`},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			body := fmt.Sprintf(`{"api":%q,"baseURL":%q%s}`, tc.protocol, upstream.URL+tc.path, tc.key)
			reply := send(handler, http.MethodPost, "/api/v1/models", body)
			if reply.Code != http.StatusOK || strings.TrimSpace(reply.Body.String()) != tc.want {
				t.Fatalf("discover models: %d %s", reply.Code, reply.Body)
			}
		})
	}
	body := fmt.Sprintf(`{"api":"OpenAIResponses","baseURL":%q}`, upstream.URL+"/unavailable")
	if reply := send(handler, http.MethodPost, "/api/v1/models", body); reply.Code != http.StatusBadGateway ||
		!strings.Contains(reply.Body.String(), "HTTP 401") || strings.Contains(reply.Body.String(), "private upstream response") {
		t.Fatalf("upstream error: %d %s", reply.Code, reply.Body)
	}
	if reply := send(handler, http.MethodGet, "/api/v1/settings", ""); strings.Contains(reply.Body.String(), `"apiKey"`) ||
		!strings.Contains(reply.Body.String(), `"model":"selected"`) {
		t.Fatalf("discovery modified or exposed saved settings: %s", reply.Body)
	}
}
