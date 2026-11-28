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

type service struct {
	path   string
	logger logr.Logger
	client *http.Client
	levels *levels.Store

	mu       sync.RWMutex
	settings config.Config
}

type providerSummary struct {
	ID        string                  `json:"id"`
	Name      string                  `json:"name,omitempty"`
	Protocol  config.ModelAPIProtocol `json:"protocol"`
	BaseURL   string                  `json:"baseURL"`
	HasAPIKey bool                    `json:"hasAPIKey"`
	Models    []config.Model          `json:"models"`
}

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

type settingsSummary struct {
	Username       string            `json:"username,omitempty"`
	DefaultModel   string            `json:"defaultModel"`
	ModelProviders []providerSummary `json:"modelProviders"`
}

func summarize(settings config.Config) settingsSummary {
	return settingsSummary{settings.Username, settings.DefaultModel, summarizeProviders(settings)}
}

func (s *service) readSettings() config.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

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

type providerUpdate struct {
	config.ModelProvider
	APIKey     *string `json:"apiKey"`
	PreviousID string  `json:"previousID"`
}

func (s *service) updateSettings(w http.ResponseWriter, r *http.Request) {
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

	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.settings
	if body.Username != nil {
		next.Username = *body.Username
	}
	if body.ModelProviders != nil {
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
		for i, update := range *body.ModelProviders {
			provider := &next.ModelProviders[i]
			id := provider.ID
			if update.PreviousID != "" {
				id = update.PreviousID
			}
			if saved, ok := s.settings.FindProvider(id); ok {
				provider.Connection = provider.Connection.WithSavedSettings(saved.Connection, update.APIKey == nil)
			}
		}
	}
	if err := config.SaveConfig(r.Context(), &next, s.path); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_write_failed", "无法保存模型设置")
		return
	}
	s.settings = next
	writeJSON(w, http.StatusOK, summarize(next))
}

func decodeJSON(r io.Reader, dst any, strict bool) error {
	decoder := json.NewDecoder(r)
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return errors.New("expected one JSON value")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, content any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(content)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
