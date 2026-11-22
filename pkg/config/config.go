package config

// Config 配置
type Config struct {
	Model ModelConfig `json:"model"`
	// TODO: 其他配置
}

// ModelConfig 模型配置
type ModelConfig struct {
	// API 协议
	Protocol ModelAPIProtocol `json:"api"`
	//
	BaseURL string `json:"baseURL"`
	// API 密钥
	APIKey string `json:"apiKey,omitempty"`
	// 模型名
	Model string `json:"model"`
}

// ModelAPIProtocol 模型 API 协议
type ModelAPIProtocol string

const (
	OpenAIChatCompletionsAPI ModelAPIProtocol = "OpenAIChatCompletions"
	OpenAIResponsesAPI       ModelAPIProtocol = "OpenAIResponses"
	AnthropicMessagesAPI     ModelAPIProtocol = "AnthropicMessages"
)
