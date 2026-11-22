package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	if err := ctx.Err(); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".settings-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	encoder := json.NewEncoder(tmp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(cfg); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
