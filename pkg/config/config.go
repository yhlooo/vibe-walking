package config

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Config 配置
type Config struct {
	DefaultModel   string          `json:"defaultModel,omitempty"`
	ModelProviders []ModelProvider `json:"modelProviders,omitempty"`
	Username       string          `json:"username,omitempty"`
}

const DefaultMaxInputToken = 1_000_000

type Connection struct {
	Protocol            ModelAPIProtocol `json:"protocol"`
	BaseURL             string           `json:"baseURL"`
	APIKey              string           `json:"apiKey,omitempty"`
	legacyAnthropicPath bool
}

type ModelProvider struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	Connection
	Models []Model `json:"models"`
}

type Model struct {
	ID              string `json:"id"`
	Name            string `json:"name,omitempty"`
	MaxInputToken   int64  `json:"maxInputToken"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	Vision          bool   `json:"vision"`
}

// legacyModel is the single-model format used by earlier settings files.
type legacyModel struct {
	Protocol        ModelAPIProtocol `json:"api"`
	BaseURL         string           `json:"baseURL"`
	APIKey          string           `json:"apiKey,omitempty"`
	Model           string           `json:"model"`
	MaxInputToken   int64            `json:"maxInputToken,omitempty"`
	ReasoningEffort string           `json:"reasoningEffort,omitempty"`
}

// ModelAPIProtocol 模型 API 协议
type ModelAPIProtocol string

const (
	OpenAIChatCompletionsAPI ModelAPIProtocol = "OpenAIChatCompletions"
	OpenAIResponsesAPI       ModelAPIProtocol = "OpenAIResponses"
	AnthropicMessagesAPI     ModelAPIProtocol = "AnthropicMessages"
	OllamaChatAPI            ModelAPIProtocol = "OllamaChat"
)

// NormalizeConnection validates the settings shared by generation and model discovery.
func (m Connection) Normalize() (Connection, error) {
	switch m.Protocol {
	case OpenAIChatCompletionsAPI, OpenAIResponsesAPI, AnthropicMessagesAPI, OllamaChatAPI:
	default:
		return Connection{}, errors.New("请选择受支持的模型协议")
	}
	endpoint := strings.TrimSpace(m.BaseURL)
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
		parsed.User != nil || strings.ContainsAny(endpoint, "?#") {
		return Connection{}, errors.New("Base URL 必须是 HTTP(S) 地址，且不能包含凭据、查询参数或片段")
	}
	m.BaseURL = strings.TrimRight(parsed.String(), "/")
	m.APIKey = strings.TrimSpace(m.APIKey)
	if strings.ContainsAny(m.APIKey, "\r\n") {
		return Connection{}, errors.New("API Key 必须在同一行")
	}
	return m, nil
}

func (m Model) Normalize() (Model, error) {
	m.ID = strings.TrimSpace(m.ID)
	if m.ID == "" {
		return Model{}, errors.New("请输入模型 ID")
	}
	if m.MaxInputToken < 0 || m.MaxInputToken > 1<<53-1 {
		return Model{}, errors.New("上下文长度超出范围")
	}
	if m.MaxInputToken == 0 {
		m.MaxInputToken = DefaultMaxInputToken
	}
	m.Name = strings.TrimSpace(m.Name)
	m.ReasoningEffort = strings.TrimSpace(m.ReasoningEffort)
	return m, nil
}

var providerIDPattern = regexp.MustCompile("^[a-z][0-9a-z._-]*$")

// NormalizeProviders validates and normalizes the provider catalog before it is published.
func (c *Config) NormalizeProviders() error {
	providers := make(map[string]bool, len(c.ModelProviders))
	firstModel := ""
	for i := range c.ModelProviders {
		provider := &c.ModelProviders[i]
		if !providerIDPattern.MatchString(provider.ID) || providers[provider.ID] {
			return fmt.Errorf("供应商 ID %q 无效或重复", provider.ID)
		}
		providers[provider.ID] = true
		provider.Name = strings.TrimSpace(provider.Name)
		connection, err := provider.Connection.Normalize()
		if err != nil {
			return fmt.Errorf("供应商 %s：%w", provider.ID, err)
		}
		provider.Connection = connection
		models := make(map[string]bool, len(provider.Models))
		for j, model := range provider.Models {
			normalized, err := model.Normalize()
			if err != nil {
				return fmt.Errorf("供应商 %s：%w", provider.ID, err)
			}
			if models[normalized.ID] {
				return fmt.Errorf("供应商 %s 的模型 ID %q 重复", provider.ID, normalized.ID)
			}
			models[normalized.ID] = true
			provider.Models[j] = normalized
			if firstModel == "" {
				firstModel = provider.ID + "/" + normalized.ID
			}
		}
	}
	if c.DefaultModel == "" {
		c.DefaultModel = firstModel
	} else if _, _, ok := c.FindModel(c.DefaultModel); !ok {
		return fmt.Errorf("默认模型 %q 未配置", c.DefaultModel)
	}
	return nil
}

func (c Config) FindProvider(id string) (ModelProvider, bool) {
	for _, provider := range c.ModelProviders {
		if provider.ID == id {
			return provider, true
		}
	}
	return ModelProvider{}, false
}

func (c Config) FindModel(id string) (ModelProvider, Model, bool) {
	providerID, modelID, found := strings.Cut(id, "/")
	if found {
		if provider, ok := c.FindProvider(providerID); ok {
			for _, model := range provider.Models {
				if model.ID == modelID {
					return provider, model, true
				}
			}
		}
	}
	return ModelProvider{}, Model{}, false
}

// Endpoint resolves an API suffix against the configured service.
func (c Connection) Endpoint(suffix string) string {
	if c.legacyAnthropicPath {
		suffix = strings.TrimPrefix(suffix, "/v1")
	}
	return c.BaseURL + suffix
}

// WithSavedSettings retains endpoint behavior and credentials for the same connection.
func (c Connection) WithSavedSettings(saved Connection, preserveKey bool) Connection {
	if c.Protocol == saved.Protocol && c.BaseURL == saved.BaseURL {
		c.legacyAnthropicPath = saved.legacyAnthropicPath
		if preserveKey {
			c.APIKey = saved.APIKey
		}
	}
	return c
}

func (m legacyModel) provider() (ModelProvider, error) {
	connection, err := (Connection{Protocol: m.Protocol, BaseURL: m.BaseURL, APIKey: m.APIKey}).Normalize()
	if err != nil {
		return ModelProvider{}, err
	}
	switch connection.Protocol {
	case AnthropicMessagesAPI:
		endpoint, _ := url.Parse(connection.BaseURL)
		if strings.HasSuffix(endpoint.EscapedPath(), "/v1") {
			connection.BaseURL = strings.TrimSuffix(connection.BaseURL, "/v1")
		} else {
			// Older settings allowed a Base URL for gateways serving /messages without /v1.
			connection.legacyAnthropicPath = true
		}
	case OllamaChatAPI:
		connection.BaseURL += "/api"
	}
	return ModelProvider{
		ID: "default", Name: "Default", Connection: connection,
		Models: []Model{{ID: m.Model, MaxInputToken: m.MaxInputToken, ReasoningEffort: m.ReasoningEffort, Vision: true}},
	}, nil
}
