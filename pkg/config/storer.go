package config

import "context"

// LoadConfig 加载配置
func LoadConfig(path string) (*Config, error) {
	panic("implement me")
}

// SaveConfig 保存配置
func SaveConfig(ctx context.Context, cfg *Config, path string) error {
	panic("implement me")
}
