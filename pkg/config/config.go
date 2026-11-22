package config

import (
	"errors"
	"net/url"
	"strings"
)

// Config 配置
type Config struct {
	Model    ModelConfig `json:"model"`
	Username string      `json:"username,omitempty"`
}

const DefaultMaxInputToken = 1_000_000

// ModelConfig 模型配置
type ModelConfig struct {
	// API 协议
	Protocol ModelAPIProtocol `json:"api"`
	// 上游 API 地址，可包含路径前缀
	BaseURL string `json:"baseURL"`
	// API 密钥
	APIKey string `json:"apiKey,omitempty"`
	// 模型名
	Model           string `json:"model"`
	MaxInputToken   int64  `json:"maxInputToken,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// ModelAPIProtocol 模型 API 协议
type ModelAPIProtocol string

const (
	OpenAIChatCompletionsAPI ModelAPIProtocol = "OpenAIChatCompletions"
	OpenAIResponsesAPI       ModelAPIProtocol = "OpenAIResponses"
	AnthropicMessagesAPI     ModelAPIProtocol = "AnthropicMessages"
)

// Normalize validates a configured model and canonicalizes its endpoint.
func (m ModelConfig) Normalize() (ModelConfig, error) {
	switch m.Protocol {
	case OpenAIChatCompletionsAPI, OpenAIResponsesAPI, AnthropicMessagesAPI:
	default:
		return ModelConfig{}, errors.New("请选择受支持的模型协议")
	}
	endpoint := strings.TrimSpace(m.BaseURL)
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
		parsed.User != nil || strings.ContainsAny(endpoint, "?#") {
		return ModelConfig{}, errors.New("Base URL 必须是 HTTP(S) 地址，且不能包含凭据、查询参数或片段")
	}
	m.BaseURL = strings.TrimRight(parsed.String(), "/")
	m.Model = strings.TrimSpace(m.Model)
	if m.Model == "" {
		return ModelConfig{}, errors.New("请输入模型 ID")
	}
	if m.MaxInputToken < 0 || m.MaxInputToken > 1<<53-1 {
		return ModelConfig{}, errors.New("上下文长度超出范围")
	}
	if m.MaxInputToken == 0 {
		m.MaxInputToken = DefaultMaxInputToken
	}
	m.ReasoningEffort = strings.TrimSpace(m.ReasoningEffort)
	m.APIKey = strings.TrimSpace(m.APIKey)
	if strings.ContainsAny(m.APIKey, "\r\n") {
		return ModelConfig{}, errors.New("API Key 必须在同一行")
	}
	return m, nil
}
