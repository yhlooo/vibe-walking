package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/yhlooo/vibe-walking/pkg/config"
)

type modelProxy struct {
	protocol config.ModelAPIProtocol
	suffix   string
}

var modelProxies = []modelProxy{
	{config.OpenAIChatCompletionsAPI, "/chat/completions"},
	{config.OpenAIResponsesAPI, "/responses"},
	{config.AnthropicMessagesAPI, "/messages"},
}

func (s *service) proxy(proxy modelProxy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		model := s.readSettings().Model
		switch {
		case model.Protocol == "":
			writeError(w, http.StatusNotFound, "model_not_configured", "请先配置模型连接")
			return
		case model.Protocol != proxy.protocol:
			writeError(w, http.StatusNotFound, "proxy_not_enabled", "模型协议已切换，请重新加载连接设置")
			return
		case r.Method != http.MethodPost:
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "此接口只接受 POST")
			return
		}

		var body map[string]json.RawMessage
		if err := decodeJSON(http.MaxBytesReader(w, r.Body, 32<<20), &body, false); err != nil || body == nil {
			writeError(w, http.StatusBadRequest, "invalid_proxy_body", "模型请求必须是 32 MiB 以内的 JSON 对象")
			return
		}
		body["model"], _ = json.Marshal(model.Model)
		payload, err := json.Marshal(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_proxy_body", "无法编码模型请求")
			return
		}

		upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, model.BaseURL+proxy.suffix, bytes.NewReader(payload))
		if err != nil {
			writeError(w, http.StatusBadGateway, "upstream_unavailable", "无法请求上游模型接口")
			return
		}
		upstream.Header.Set("Content-Type", "application/json")
		var stream bool
		if json.Unmarshal(body["stream"], &stream) == nil && stream {
			upstream.Header.Set("Accept", "text/event-stream")
		}
		if proxy.protocol == config.AnthropicMessagesAPI {
			upstream.Header.Set("anthropic-version", "2023-06-01")
			if model.APIKey != "" {
				upstream.Header.Set("x-api-key", model.APIKey)
			}
		} else if model.APIKey != "" {
			upstream.Header.Set("Authorization", "Bearer "+model.APIKey)
		}

		start := time.Now()
		response, err := s.client.Do(upstream)
		if err != nil {
			status, code, message := http.StatusBadGateway, "upstream_unavailable", "无法连接上游模型接口"
			if errors.Is(err, context.DeadlineExceeded) {
				status, code, message = http.StatusGatewayTimeout, "upstream_timeout", "上游模型请求超时"
			}
			s.logProxy(proxy, status, start)
			writeError(w, status, code, message)
			return
		}
		defer response.Body.Close()
		defer s.logProxy(proxy, response.StatusCode, start)

		w.Header().Set("Cache-Control", "no-store")
		if contentType := response.Header.Get("Content-Type"); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(response.StatusCode)
		if mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type")); mediaType == "text/event-stream" {
			streamResponse(w, response.Body)
			return
		}
		io.Copy(w, response.Body)
	}
}

func streamResponse(w http.ResponseWriter, body io.Reader) {
	controller := http.NewResponseController(w)
	if controller.Flush() != nil {
		return
	}
	buffer := make([]byte, 16<<10)
	for {
		n, err := body.Read(buffer)
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

func (s *service) logProxy(proxy modelProxy, status int, start time.Time) {
	s.logger.V(1).Info("model proxy", "protocol", proxy.protocol, "status", status, "duration", time.Since(start))
}
