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

func (s *service) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "此接口只接受 POST")
		return
	}
	var body struct {
		API     config.ModelAPIProtocol `json:"api"`
		BaseURL string                  `json:"baseURL"`
		APIKey  *string                 `json:"apiKey"`
	}
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 64<<10), &body, true); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_connection", "模型连接格式错误")
		return
	}
	model := config.ModelConfig{Protocol: body.API, BaseURL: body.BaseURL}
	if body.APIKey != nil {
		model.APIKey = *body.APIKey
	}
	model, err := model.NormalizeConnection()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_connection", err.Error())
		return
	}
	useSavedKey(&model, body.APIKey, s.readSettings().Model)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	models, err := s.listModels(ctx, model)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, "upstream_timeout", "读取模型列表超时")
		} else {
			writeError(w, http.StatusBadGateway, "model_list_failed", err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"models": models})
}

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

func (s *service) listModels(ctx context.Context, model config.ModelConfig) ([]string, error) {
	endpoint := model.BaseURL + "/models"
	if model.Protocol == config.OllamaChatAPI {
		endpoint = model.BaseURL + "/api/tags"
	}
	models := []string{}
	seen := make(map[string]bool)
	add := func(id string) {
		if id != "" && !seen[id] {
			models = append(models, id)
			seen[id] = true
		}
	}
	cursors := make(map[string]bool)
	next := endpoint
	for {
		page, err := s.fetchModelListPage(ctx, model, next)
		if err != nil {
			return nil, err
		}
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
		if page.LastID == "" || cursors[page.LastID] {
			return nil, errors.New("上游模型列表分页游标无效")
		}
		cursors[page.LastID] = true
		next = endpoint + "?after_id=" + url.QueryEscape(page.LastID)
	}
}

func (s *service) fetchModelListPage(ctx context.Context, model config.ModelConfig, endpoint string) (modelListPage, error) {
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
	const maxBytes = 8 << 20
	body := &io.LimitedReader{R: response.Body, N: maxBytes + 1}
	if err := decodeJSON(body, &page, false); err != nil || body.N == 0 {
		return page, errors.New("上游模型列表格式错误或超出 8 MiB")
	}
	return page, nil
}
