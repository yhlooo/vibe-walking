package server

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/yhlooo/vibe-walking/pkg/config"
)

// handleModels 用表单提交的临时连接发现模型，并按连接匹配情况复用已保存的凭据。
func (s *service) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "此接口只接受 POST")
		return
	}
	var body struct {
		Protocol   config.ModelAPIProtocol `json:"protocol"`
		ProviderID string                  `json:"providerID"`
		BaseURL    string                  `json:"baseURL"`
		APIKey     *string                 `json:"apiKey"`
	}
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 64<<10), &body, true); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_connection", "模型连接格式错误")
		return
	}

	// 先构造并验证表单连接，再根据已保存供应商补齐可复用的设置。
	connection := config.Connection{Protocol: body.Protocol, BaseURL: body.BaseURL}
	if body.APIKey != nil {
		connection.APIKey = *body.APIKey
	}
	connection, err := connection.Normalize()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_connection", err.Error())
		return
	}

	// 根据提交的供应商 ID 补齐同一连接的已保存设置。
	settings := s.readSettings()
	if saved, ok := settings.FindProvider(body.ProviderID); ok {
		connection = connection.WithSavedSettings(saved.Connection, body.APIKey == nil)
	}

	if models, ok := s.discoverModels(w, r, connection); ok {
		writeJSON(w, http.StatusOK, map[string][]string{"models": models})
	}
}

// handleProviders 返回已配置的供应商目录与默认模型。
func (s *service) handleProviders(w http.ResponseWriter, r *http.Request) {
	settings := s.readSettings()
	writeJSON(w, http.StatusOK, struct {
		DefaultModel string            `json:"defaultModel"`
		Providers    []providerSummary `json:"providers"`
	}{settings.DefaultModel, summarizeProviders(settings)})
}

// handleProviderModels 查询指定供应商当前可用的上游模型。
func (s *service) handleProviderModels(w http.ResponseWriter, r *http.Request) {
	provider, ok := s.readSettings().FindProvider(r.PathValue("providerID"))
	if !ok {
		writeError(w, http.StatusNotFound, "provider_not_found", "供应商未配置")
		return
	}
	models, ok := s.discoverModels(w, r, provider.Connection)
	if !ok {
		return
	}
	type discoveredModel struct {
		ID string `json:"id"`
	}
	result := make([]discoveredModel, 0, len(models))
	for _, id := range models {
		result = append(result, discoveredModel{ID: id})
	}
	writeJSON(w, http.StatusOK, map[string][]discoveredModel{"models": result})
}

// discoverModels 限制发现请求的总时长并转换上游错误。
func (s *service) discoverModels(w http.ResponseWriter, r *http.Request, connection config.Connection) ([]string, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	models, err := s.listModels(ctx, connection)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, "upstream_timeout", "读取模型列表超时")
		} else {
			writeError(w, http.StatusBadGateway, "model_list_failed", err.Error())
		}
		return nil, false
	}
	return models, true
}

// modelListPage 承载供应商返回的模型条目及分页信息。
type modelListPage struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
	Models []struct {
		Name  string `json:"name"`
		Model string `json:"model"`
	} `json:"models"`
	HasMore bool   `json:"has_more"`
	LastID  string `json:"last_id"`
}

// listModels 按协议读取并去重上游模型 ID。
func (s *service) listModels(ctx context.Context, model config.Connection) ([]string, error) {
	suffix := "/models"
	switch model.Protocol {
	case config.AnthropicMessagesAPI:
		suffix = "/v1/models"
	case config.OllamaChatAPI:
		suffix = "/tags"
	}
	endpoint := model.Endpoint(suffix)
	models := []string{}
	seen := make(map[string]bool)

	// 在不同响应页中按首次出现顺序保留非空模型 ID。
	add := func(id string) {
		if id != "" && !seen[id] {
			models = append(models, id)
			seen[id] = true
		}
	}

	// 记录已访问的 Anthropic 分页游标，防止重复翻页。
	cursors := make(map[string]bool)
	next := endpoint
	for {
		page, err := s.fetchModelListPage(ctx, model, next)
		if err != nil {
			return nil, err
		}

		// Ollama 返回独立的 models 数组，安装名优先取 model 字段。
		if model.Protocol == config.OllamaChatAPI {
			if page.Models == nil {
				return nil, errors.New("上游模型列表格式错误")
			}
			for _, entry := range page.Models {
				add(cmp.Or(entry.Model, entry.Name))
			}
			return models, nil
		}
		if page.Data == nil {
			return nil, errors.New("上游模型列表格式错误")
		}
		for _, entry := range page.Data {
			add(entry.ID)
		}
		if model.Protocol != config.AnthropicMessagesAPI || !page.HasMore {
			return models, nil
		}

		// 游标必须推进，否则提前结束请求以避免重复翻页。
		if page.LastID == "" || cursors[page.LastID] {
			return nil, errors.New("上游模型列表分页游标无效")
		}
		cursors[page.LastID] = true
		next = endpoint + "?after_id=" + url.QueryEscape(page.LastID)
	}
}

// fetchModelListPage 请求并解析大小受限的单页模型列表。
func (s *service) fetchModelListPage(ctx context.Context, model config.Connection, endpoint string) (modelListPage, error) {
	var page modelListPage
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return page, errors.New("无法请求上游模型列表")
	}
	request.Header.Set("Accept", "application/json")
	setModelHeaders(request, model)
	response, err := s.client.Do(request)
	if err != nil {
		return page, errors.New("无法连接上游模型列表接口")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return page, fmt.Errorf("上游模型列表请求失败（HTTP %d）", response.StatusCode)
	}

	// 额外读取一个字节，以区分正好达到上限和超出上限。
	const maxBytes = 8 << 20
	body := &io.LimitedReader{R: response.Body, N: maxBytes + 1}
	if err := decodeJSON(body, &page, false); err != nil || body.N == 0 {
		return page, errors.New("上游模型列表格式错误或超出 8 MiB")
	}
	return page, nil
}
