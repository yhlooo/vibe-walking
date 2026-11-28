// Package config 定义应用设置及其持久化格式。
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
	// 默认模型的复合 ID，格式为供应商 ID、斜杠和上游模型 ID。
	DefaultModel   string          `json:"defaultModel,omitempty"`
	ModelProviders []ModelProvider `json:"modelProviders,omitempty"`
	Username       string          `json:"username,omitempty"`
}

// DefaultMaxInputToken 是模型未设置输入上限时使用的默认值。
const DefaultMaxInputToken = 1_000_000

// Connection 保存模型生成和模型发现共同使用的连接设置。
type Connection struct {
	Protocol ModelAPIProtocol `json:"protocol"`
	BaseURL  string           `json:"baseURL"`
	APIKey   string           `json:"apiKey,omitempty"`
	// 旧版 Anthropic 网关的接口路径省略 /v1。
	legacyAnthropicPath bool
}

// ModelProvider 将同一连接下维护的模型归在一个供应商中。
type ModelProvider struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	Connection
	Models []Model `json:"models"`
}

// Model 保存一个上游模型的标识和可用能力。
type Model struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	// 模型输入的 Token 上限，用作对话压缩阈值。
	MaxInputToken int64 `json:"maxInputToken"`
	// 供应商协议使用的思考强度选项。
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	// 标记模型能否接收截图。
	Vision bool `json:"vision"`
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
	// OpenAIChatCompletionsAPI 使用 OpenAI Chat Completions 消息格式。
	OpenAIChatCompletionsAPI ModelAPIProtocol = "OpenAIChatCompletions"
	// OpenAIResponsesAPI 使用 OpenAI Responses 输入和输出项格式。
	OpenAIResponsesAPI ModelAPIProtocol = "OpenAIResponses"
	// AnthropicMessagesAPI 使用 Anthropic Messages 内容块格式。
	AnthropicMessagesAPI ModelAPIProtocol = "AnthropicMessages"
	// OllamaChatAPI 使用 Ollama 聊天消息和 NDJSON 流。
	OllamaChatAPI ModelAPIProtocol = "OllamaChat"
)

// Normalize 清理并校验模型服务连接设置。
func (m Connection) Normalize() (Connection, error) {
	switch m.Protocol {
	case OpenAIChatCompletionsAPI, OpenAIResponsesAPI, AnthropicMessagesAPI, OllamaChatAPI:
	default:
		return Connection{}, errors.New("请选择受支持的模型协议")
	}

	// 服务地址用作拼接接口的基址，因此需限制协议并拒绝嵌入的凭据和查询。
	endpoint := strings.TrimSpace(m.BaseURL)
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
		parsed.User != nil || strings.ContainsAny(endpoint, "?#") {
		return Connection{}, errors.New("Base URL 必须是 HTTP(S) 地址，且不能包含凭据、查询参数或片段")
	}

	// 整理基址并限制密钥为单行，以便构造协议请求头。
	m.BaseURL = strings.TrimRight(parsed.String(), "/")
	m.APIKey = strings.TrimSpace(m.APIKey)
	if strings.ContainsAny(m.APIKey, "\r\n") {
		return Connection{}, errors.New("API Key 必须在同一行")
	}
	return m, nil
}

// Normalize 清理模型标识和名称，并为缺省的输入上限填入默认值。
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

// providerIDPattern 定义供应商 ID 的合法字符和首字符。
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

		// 模型 ID 在供应商内去重，并记录按目录顺序遇到的首个模型。
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

	// 缺省时选用首个模型，显式默认项必须能在新目录中解析。
	if c.DefaultModel == "" {
		c.DefaultModel = firstModel
	} else if _, _, ok := c.FindModel(c.DefaultModel); !ok {
		return fmt.Errorf("默认模型 %q 未配置", c.DefaultModel)
	}
	return nil
}

// FindProvider 根据供应商 ID 取得连接和模型列表。
func (c Config) FindProvider(id string) (ModelProvider, bool) {
	for _, provider := range c.ModelProviders {
		if provider.ID == id {
			return provider, true
		}
	}
	return ModelProvider{}, false
}

// FindModel 根据供应商和模型组成的复合 ID 查找模型。
func (c Config) FindModel(id string) (ModelProvider, Model, bool) {
	// 只在首个斜杠切分，上游模型 ID 本身也可能包含斜杠。
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
		// 端点行为和凭据均只在协议、地址完全匹配时可沿用。
		c.legacyAnthropicPath = saved.legacyAnthropicPath
		if preserveKey {
			c.APIKey = saved.APIKey
		}
	}
	return c
}

// provider 将旧版单模型设置转换为默认供应商。
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
