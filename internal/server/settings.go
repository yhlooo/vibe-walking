package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"unicode/utf8"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/levels"
	"github.com/yhlooo/vibe-walking/pkg/config"
)

// service 持有本地服务共享的存储、模型客户端和当前设置。
type service struct {
	path   string
	logger logr.Logger
	client *http.Client
	levels *levels.Store

	// 保护当前设置快照及写入、发布过程。
	mu       sync.RWMutex
	settings config.Config
}

// providerSummary 返回供应商的公开配置及凭据存在状态。
type providerSummary struct {
	ID        string                  `json:"id"`
	Name      string                  `json:"name,omitempty"`
	Protocol  config.ModelAPIProtocol `json:"protocol"`
	BaseURL   string                  `json:"baseURL"`
	HasAPIKey bool                    `json:"hasAPIKey"`
	Models    []config.Model          `json:"models"`
}

// summarizeProviders 从配置生成可返回给浏览器的供应商列表。
func summarizeProviders(settings config.Config) []providerSummary {
	providers := make([]providerSummary, 0, len(settings.ModelProviders))
	for _, provider := range settings.ModelProviders {
		models := provider.Models
		if models == nil {
			models = []config.Model{}
		}
		providers = append(providers, providerSummary{
			ID: provider.ID, Name: provider.Name, Protocol: provider.Protocol, BaseURL: provider.BaseURL,
			HasAPIKey: provider.APIKey != "", Models: models,
		})
	}
	return providers
}

// settingsSummary 是设置接口返回给浏览器的配置。
type settingsSummary struct {
	Username       string            `json:"username,omitempty"`
	DefaultModel   string            `json:"defaultModel"`
	ModelProviders []providerSummary `json:"modelProviders"`
}

// summarize 生成设置响应并隐藏供应商密钥。
func summarize(settings config.Config) settingsSummary {
	return settingsSummary{settings.Username, settings.DefaultModel, summarizeProviders(settings)}
}

// readSettings 在读锁保护下取得当前发布的设置快照。
func (s *service) readSettings() config.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

// handleSettings 分派设置读取和部分更新请求。
func (s *service) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, summarize(s.readSettings()))
	case http.MethodPost:
		s.updateSettings(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "此接口只接受 GET 或 POST")
	}
}

// providerUpdate 携带供应商配置、可选密钥和改名前的 ID。
type providerUpdate struct {
	config.ModelProvider
	APIKey     *string `json:"apiKey"`
	PreviousID string  `json:"previousID"`
}

// updateSettings 合并并校验设置，写入成功后发布新快照。
func (s *service) updateSettings(w http.ResponseWriter, r *http.Request) {
	// 用指针区分省略的设置与显式提交的空值。
	var body struct {
		Username       *string           `json:"username"`
		DefaultModel   *string           `json:"defaultModel"`
		ModelProviders *[]providerUpdate `json:"modelProviders"`
	}
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 1<<20), &body, true); err != nil ||
		(body.Username == nil && body.DefaultModel == nil && body.ModelProviders == nil) {
		writeError(w, http.StatusBadRequest, "invalid_settings", "请提交有效的模型或用户名设置")
		return
	}
	if body.Username != nil && utf8.RuneCountInString(*body.Username) > 20 {
		writeError(w, http.StatusBadRequest, "invalid_settings", "用户名最多 20 个字符")
		return
	}

	// 串行处理设置合并和持久化，确保读取方看到完整快照。
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.settings
	if body.Username != nil {
		next.Username = *body.Username
	}

	if body.ModelProviders != nil {
		// 供应商列表按请求整体替换，由随附默认项或归一化逻辑重新确定默认模型。
		next.ModelProviders = make([]config.ModelProvider, 0, len(*body.ModelProviders))
		next.DefaultModel = ""
		for _, update := range *body.ModelProviders {
			provider := update.ModelProvider
			if update.APIKey != nil {
				provider.APIKey = *update.APIKey
			}
			next.ModelProviders = append(next.ModelProviders, provider)
		}
	}
	if body.DefaultModel != nil {
		next.DefaultModel = *body.DefaultModel
	}

	// A default-only or username-only update can reuse the immutable catalog.
	if body.ModelProviders != nil {
		if err := next.NormalizeProviders(); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_settings", err.Error())
			return
		}
	} else if body.DefaultModel != nil {
		if _, _, ok := next.FindModel(next.DefaultModel); !ok {
			writeError(w, http.StatusBadRequest, "invalid_settings", "默认模型未配置")
			return
		}
	}

	if body.ModelProviders != nil {
		// 在校验后为地址和协议匹配的供应商保留旧连接设置。
		for i, update := range *body.ModelProviders {
			provider := &next.ModelProviders[i]
			id := provider.ID

			// 供应商改名时先用旧 ID 找到原连接，再判断能否沿用密钥。
			if update.PreviousID != "" {
				id = update.PreviousID
			}
			if saved, ok := s.settings.FindProvider(id); ok {
				provider.Connection = provider.Connection.WithSavedSettings(saved.Connection, update.APIKey == nil)
			}
		}
	}

	// 磁盘写入成功后才发布内存快照，失败时服务继续使用原设置。
	if err := config.SaveConfig(r.Context(), &next, s.path); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_write_failed", "无法保存模型设置")
		return
	}

	s.settings = next
	writeJSON(w, http.StatusOK, summarize(next))
}

// decodeJSON 解析唯一的 JSON 值，并按需拒绝未知字段。
func decodeJSON(r io.Reader, dst any, strict bool) error {
	decoder := json.NewDecoder(r)
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(dst); err != nil {
		return err
	}

	// 第二次解码应直接到达输入结尾，用来拒绝其他 JSON 值。
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return errors.New("expected one JSON value")
	}
	return nil
}

// writeJSON 写入不可缓存的 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, content any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(content)
}

// writeError 以统一的接口格式返回错误代码和提示。
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
