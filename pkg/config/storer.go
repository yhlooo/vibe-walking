package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/yhlooo/vibe-walking/internal/jsonfile"
)

// LoadConfig 加载配置
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &Config{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read settings %q: %w", path, err)
	}
	var cfg *Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse settings %q: %w", path, err)
	}
	if cfg == nil {
		return nil, fmt.Errorf("settings %q must contain a JSON object", path)
	}
	if cfg.Model != (ModelConfig{}) {
		cfg.Model, err = cfg.Model.Normalize()
		if err != nil {
			return nil, fmt.Errorf("validate settings %q: %w", path, err)
		}
	}
	return cfg, nil
}

// SaveConfig 保存配置
func SaveConfig(ctx context.Context, cfg *Config, path string) error {
	return jsonfile.Write(ctx, path, cfg)
}
