package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"

	"github.com/yhlooo/vibe-walking/internal/jsonfile"
)

type configFile struct {
	Config
	Model                    legacyModel `json:"model,omitzero"`
	LegacyAnthropicProviders []string    `json:"legacyAnthropicProviders,omitempty"`
}

// LoadConfig 加载配置
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &Config{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read settings %q: %w", path, err)
	}
	var cfg *configFile
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse settings %q: %w", path, err)
	}
	if cfg == nil {
		return nil, fmt.Errorf("settings %q must contain a JSON object", path)
	}
	if cfg.ModelProviders == nil && cfg.Model != (legacyModel{}) {
		provider, err := cfg.Model.provider()
		if err != nil {
			return nil, fmt.Errorf("validate settings %q: %w", path, err)
		}
		cfg.ModelProviders = []ModelProvider{provider}
	}
	if err := cfg.NormalizeProviders(); err != nil {
		return nil, fmt.Errorf("validate settings %q: %w", path, err)
	}
	for i := range cfg.ModelProviders {
		provider := &cfg.ModelProviders[i]
		if provider.Protocol == AnthropicMessagesAPI && slices.Contains(cfg.LegacyAnthropicProviders, provider.ID) {
			provider.legacyAnthropicPath = true
		}
	}
	return &cfg.Config, nil
}

// SaveConfig 保存配置
func SaveConfig(ctx context.Context, cfg *Config, path string) error {
	file := configFile{Config: *cfg}
	for _, provider := range cfg.ModelProviders {
		if provider.legacyAnthropicPath {
			file.LegacyAnthropicProviders = append(file.LegacyAnthropicProviders, provider.ID)
		}
	}
	return jsonfile.Write(ctx, path, &file)
}
