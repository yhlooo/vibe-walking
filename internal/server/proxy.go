package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/yhlooo/vibe-walking/pkg/config"
)

// modelProxy 关联前端代理路径、模型协议和上游路径后缀。
type modelProxy struct {
	protocol       config.ModelAPIProtocol
	path           string
	upstreamSuffix string
}

// modelProxies 列出应用支持的生成接口路由。
var modelProxies = []modelProxy{
	{config.OpenAIChatCompletionsAPI, "/openai/v1/chat/completions", "/chat/completions"},
	{config.OpenAIResponsesAPI, "/openai/v1/responses", "/responses"},
	{config.AnthropicMessagesAPI, "/anthropic/v1/messages", "/v1/messages"},
	{config.OllamaChatAPI, "/ollama/api/chat", "/chat"},
}

// proxy 验证模型选择并转发生成请求与上游响应。
func (s *service) proxy(proxy modelProxy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "此接口只接受 POST")
			return
		}

		// 只解析代理需要的字段，其余生成参数保留为原始 JSON 值。
		var body map[string]json.RawMessage
		if err := decodeJSON(http.MaxBytesReader(w, r.Body, 32<<20), &body, false); err != nil || body == nil {
			writeError(w, http.StatusBadRequest, "invalid_proxy_body", "模型请求必须是 32 MiB 以内的 JSON 对象")
			return
		}

		// 用复合 ID 查找相关供应商，并把实际模型 ID 发给上游。
		var id string
		if err := json.Unmarshal(body["model"], &id); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_model", "模型必须使用 供应商ID/模型ID 格式")
			return
		}
		providerID, modelID, found := strings.Cut(id, "/")
		if !found || providerID == "" || modelID == "" {
			writeError(w, http.StatusBadRequest, "invalid_model", "模型必须使用 供应商ID/模型ID 格式")
			return
		}
		provider, model, ok := s.readSettings().FindModel(id)
		if !ok || provider.Protocol != proxy.protocol {
			writeError(w, http.StatusNotFound, "model_not_found", "该协议下未配置此模型")
			return
		}

		body["model"], _ = json.Marshal(model.ID)
		payload, err := json.Marshal(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_proxy_body", "无法编码模型请求")
			return
		}

		// 沿用客户端上下文，使取消对话时的取消信号传递给上游。
		upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, provider.Endpoint(proxy.upstreamSuffix), bytes.NewReader(payload))
		if err != nil {
			writeError(w, http.StatusBadGateway, "upstream_unavailable", "无法请求上游模型接口")
			return
		}

		upstream.Header.Set("Content-Type", "application/json")

		// 流式请求的 Accept 按协议选择 SSE 或 NDJSON。
		var stream bool
		if json.Unmarshal(body["stream"], &stream) == nil && stream {
			mediaType := "text/event-stream"
			if proxy.protocol == config.OllamaChatAPI {
				mediaType = "application/x-ndjson"
			}
			upstream.Header.Set("Accept", mediaType)
		}
		setModelHeaders(upstream, provider.Connection)

		start := time.Now()
		response, err := s.client.Do(upstream)
		if err != nil {
			status, code, message := http.StatusBadGateway, "upstream_unavailable", "无法连接上游模型接口"

			// 将超时和连接失败映射为不同的 HTTP 状态与错误代码。
			if errors.Is(err, context.DeadlineExceeded) {
				status, code, message = http.StatusGatewayTimeout, "upstream_timeout", "上游模型请求超时"
			}
			s.logProxy(proxy, status, start)
			writeError(w, status, code, message)
			return
		}

		defer response.Body.Close()
		defer s.logProxy(proxy, response.StatusCode, start)

		// 保留上游响应格式，流式响应逐块刷新。
		w.Header().Set("Cache-Control", "no-store")
		if contentType := response.Header.Get("Content-Type"); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(response.StatusCode)
		mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if mediaType == "text/event-stream" || mediaType == "application/x-ndjson" {
			streamResponse(w, response.Body)
			return
		}
		io.Copy(w, response.Body)
	}
}

// setModelHeaders 按协议设置凭据与必要的协议头。
func setModelHeaders(request *http.Request, model config.Connection) {
	if model.Protocol == config.AnthropicMessagesAPI {
		request.Header.Set("anthropic-version", "2023-06-01")
		if model.APIKey != "" {
			request.Header.Set("x-api-key", model.APIKey)
		}
	} else if model.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+model.APIKey)
	}
}

// streamResponse 逐块转发模型输出并立即刷新给浏览器。
func streamResponse(w http.ResponseWriter, body io.Reader) {
	// 先刷新响应头，使浏览器可在首块模型输出前开始读取流。
	controller := http.NewResponseController(w)
	if controller.Flush() != nil {
		return
	}
	buffer := make([]byte, 16<<10)
	for {
		n, err := body.Read(buffer)

		// 读取可能同时返回数据与结束状态，先将本次读到的数据发完。
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil || controller.Flush() != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// logProxy 记录代理协议、响应状态和耗时。
func (s *service) logProxy(proxy modelProxy, status int, start time.Time) {
	s.logger.V(1).Info("model proxy", "protocol", proxy.protocol, "status", status, "duration", time.Since(start))
}
