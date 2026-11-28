package config

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadLegacyModel(t *testing.T) {
	for _, tc := range []struct {
		protocol     ModelAPIProtocol
		baseURL      string
		wantURL      string
		suffix       string
		wantEndpoint string
	}{
		{OpenAIResponsesAPI, "https://example.com/v1/", "https://example.com/v1", "/responses", "https://example.com/v1/responses"},
		{AnthropicMessagesAPI, "https://example.com/gateway/v1/", "https://example.com/gateway", "/v1/messages", "https://example.com/gateway/v1/messages"},
		{AnthropicMessagesAPI, "https://example.com/legacy/", "https://example.com/legacy", "/v1/messages", "https://example.com/legacy/messages"},
		{OllamaChatAPI, "http://localhost:11434/gateway/", "http://localhost:11434/gateway/api", "/chat", "http://localhost:11434/gateway/api/chat"},
	} {
		t.Run(string(tc.protocol), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "settings.json")
			raw := fmt.Sprintf(`{"username":"玩家","model":{"api":%q,"baseURL":%q,"apiKey":"key","model":"vendor/model","maxInputToken":32768,"reasoningEffort":"high"}}`, tc.protocol, tc.baseURL)
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := LoadConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			provider, model, ok := cfg.FindModel(cfg.DefaultModel)
			if !ok || cfg.DefaultModel != "default/vendor/model" || cfg.Username != "玩家" ||
				provider.ID != "default" || provider.Name != "Default" || provider.Protocol != tc.protocol ||
				provider.BaseURL != tc.wantURL || provider.Endpoint(tc.suffix) != tc.wantEndpoint || provider.APIKey != "key" ||
				model.ID != "vendor/model" || model.MaxInputToken != 32768 || model.ReasoningEffort != "high" || !model.Vision {
				t.Fatalf("unexpected migrated configuration: %#v", cfg)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(after) != raw {
				t.Fatalf("load changed the file: %q, %v", after, err)
			}
			if err := SaveConfig(context.Background(), cfg, path); err != nil {
				t.Fatal(err)
			}
			reloaded, err := LoadConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			provider, _, ok = reloaded.FindModel(reloaded.DefaultModel)
			if !ok || provider.Endpoint(tc.suffix) != tc.wantEndpoint {
				t.Fatalf("endpoint changed after save and reload: %q", provider.Endpoint(tc.suffix))
			}
		})
	}
}
