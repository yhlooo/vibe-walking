package server

import (
	"bytes"
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

type modelSummary struct {
	API             config.ModelAPIProtocol `json:"api"`
	BaseURL         string                  `json:"baseURL"`
	Model           string                  `json:"model"`
	HasAPIKey       bool                    `json:"hasAPIKey"`
	MaxInputToken   int64                   `json:"maxInputToken"`
	ReasoningEffort string                  `json:"reasoningEffort"`
}

type settingsSummary struct {
	Model    *modelSummary `json:"model"`
	Username string        `json:"username,omitempty"`
}

func summarize(settings config.Config) settingsSummary {
	model := settings.Model
	if model.Protocol == "" {
		return settingsSummary{Username: settings.Username}
	}
	return settingsSummary{Username: settings.Username, Model: &modelSummary{
		API: model.Protocol, BaseURL: model.BaseURL, Model: model.Model, HasAPIKey: model.APIKey != "",
		MaxInputToken: model.MaxInputToken, ReasoningEffort: model.ReasoningEffort,
	}}
}

func (s *service) readSettings() config.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

type modelUpdate struct {
	API             config.ModelAPIProtocol `json:"api"`
	BaseURL         string                  `json:"baseURL"`
	Model           string                  `json:"model"`
	APIKey          *string                 `json:"apiKey"`
	MaxInputToken   *int64                  `json:"maxInputToken"`
	ReasoningEffort *string                 `json:"reasoningEffort"`
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

func (s *service) updateSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model    json.RawMessage `json:"model"`
		Username *string         `json:"username"`
	}
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 64<<10), &body, true); err != nil ||
		(body.Model == nil && body.Username == nil) {
		writeError(w, http.StatusBadRequest, "invalid_settings", "请提交模型或用户名设置")
		return
	}
	if body.Username != nil && utf8.RuneCountInString(*body.Username) > 20 {
		writeError(w, http.StatusBadRequest, "invalid_settings", "用户名最多 20 个字符")
		return
	}
	var update *modelUpdate
	if body.Model != nil && decodeJSON(bytes.NewReader(body.Model), &update, true) != nil {
		writeError(w, http.StatusBadRequest, "invalid_settings", "模型设置格式错误")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.settings
	if body.Username != nil {
		next.Username = *body.Username
	}
	if body.Model != nil {
		next.Model = config.ModelConfig{}
	}
	if update != nil {
		model := config.ModelConfig{Protocol: update.API, BaseURL: update.BaseURL, Model: update.Model}
		if update.APIKey != nil {
			model.APIKey = *update.APIKey
		}
		model.MaxInputToken = s.settings.Model.MaxInputToken
		model.ReasoningEffort = s.settings.Model.ReasoningEffort
		if update.MaxInputToken != nil {
			if *update.MaxInputToken <= 0 {
				writeError(w, http.StatusBadRequest, "invalid_settings", "上下文长度必须大于 0")
				return
			}
			model.MaxInputToken = *update.MaxInputToken
		}
		if update.ReasoningEffort != nil {
			model.ReasoningEffort = *update.ReasoningEffort
		}
		var err error
		model, err = model.Normalize()
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_settings", err.Error())
			return
		}
		if update.APIKey == nil && model.Protocol == s.settings.Model.Protocol && model.BaseURL == s.settings.Model.BaseURL {
			model.APIKey = s.settings.Model.APIKey
		}
		next.Model = model
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
