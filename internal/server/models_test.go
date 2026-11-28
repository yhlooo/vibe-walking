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
	settings := fmt.Sprintf(`{"modelProviders":[{"id":"claude","protocol":"AnthropicMessages","baseURL":%q,"apiKey":"saved","models":[{"id":"selected"}]}]}`, upstream.URL+"/claude")
	if reply := send(handler, http.MethodPost, "/api/v1/settings", settings); reply.Code != http.StatusOK {
		t.Fatalf("save settings: %s", reply.Body)
	}

	for _, tc := range []struct {
		protocol, path, key, want string
	}{
		{"OpenAIChatCompletions", "/gateway/v1", `,"apiKey":"draft"`, `{"models":["model-a"]}`},
		{"OpenAIResponses", "/gateway/v1/", `,"apiKey":"draft"`, `{"models":["model-a"]}`},
		{"AnthropicMessages", "/claude/", "", `{"models":["first+id","second"]}`},
		{"OllamaChat", "/ollama/api", "", `{"models":["legacy:latest","vision:latest"]}`},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			body := fmt.Sprintf(`{"protocol":%q,"providerID":"claude","baseURL":%q%s}`, tc.protocol, upstream.URL+tc.path, tc.key)
			reply := send(handler, http.MethodPost, "/llm/providers/models", body)
			if reply.Code != http.StatusOK || strings.TrimSpace(reply.Body.String()) != tc.want {
				t.Fatalf("discover models: %d %s", reply.Code, reply.Body)
			}
		})
	}
	body := fmt.Sprintf(`{"protocol":"OpenAIResponses","baseURL":%q}`, upstream.URL+"/unavailable")
	if reply := send(handler, http.MethodPost, "/llm/providers/models", body); reply.Code != http.StatusBadGateway ||
		!strings.Contains(reply.Body.String(), "HTTP 401") || strings.Contains(reply.Body.String(), "private upstream response") {
		t.Fatalf("upstream error: %d %s", reply.Code, reply.Body)
	}
	if reply := send(handler, http.MethodGet, "/api/v1/settings", ""); strings.Contains(reply.Body.String(), `"apiKey"`) ||
		!strings.Contains(reply.Body.String(), `"defaultModel":"claude/selected"`) {
		t.Fatalf("discovery modified or exposed saved settings: %s", reply.Body)
	}
	if reply := send(handler, http.MethodGet, "/llm/providers/claude/models", ""); reply.Code != http.StatusOK ||
		strings.TrimSpace(reply.Body.String()) != `{"models":[{"id":"first+id"},{"id":"second"}]}` {
		t.Fatalf("discover configured provider: %d %s", reply.Code, reply.Body)
	}
	if reply := send(handler, http.MethodGet, "/llm/providers/unknown/models", ""); reply.Code != http.StatusNotFound {
		t.Fatalf("unknown provider: %d %s", reply.Code, reply.Body)
	}
}
