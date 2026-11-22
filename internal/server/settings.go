package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/levels"
	"github.com/yhlooo/vibe-walking/pkg/config"
)

type service struct {
	path   string
	logger logr.Logger
	client *http.Client
	levels *levels.Store

	mu    sync.RWMutex
	model config.ModelConfig
}

type modelSummary struct {
	API       config.ModelAPIProtocol `json:"api"`
	BaseURL   string                  `json:"baseURL"`
	Model     string                  `json:"model"`
	HasAPIKey bool                    `json:"hasAPIKey"`
}

type settingsSummary struct {
	Model *modelSummary `json:"model"`
}

func summarize(model config.ModelConfig) settingsSummary {
	if model.Protocol == "" {
		return settingsSummary{}
	}
	return settingsSummary{Model: &modelSummary{
		API: model.Protocol, BaseURL: model.BaseURL, Model: model.Model, HasAPIKey: model.APIKey != "",
	}}
}

func (s *service) readModel() config.ModelConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.model
}

type modelUpdate struct {
	API     config.ModelAPIProtocol `json:"api"`
	BaseURL string                  `json:"baseURL"`
	Model   string                  `json:"model"`
	APIKey  *string                 `json:"apiKey"`
}

func (s *service) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, summarize(s.readModel()))
	case http.MethodPost:
		s.updateSettings(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "此接口只接受 GET 或 POST")
	}
}

func (s *service) updateSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model json.RawMessage `json:"model"`
	}
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 64<<10), &body, true); err != nil || body.Model == nil {
		writeError(w, http.StatusBadRequest, "invalid_settings", "请提交包含 model 字段的 JSON 对象")
		return
	}
	var update *modelUpdate
	if err := decodeJSON(bytes.NewReader(body.Model), &update, true); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_settings", "模型设置格式错误")
		return
	}
	var model config.ModelConfig
	if update != nil {
		model = config.ModelConfig{Protocol: update.API, BaseURL: update.BaseURL, Model: update.Model}
		if update.APIKey != nil {
			model.APIKey = *update.APIKey
		}
		var err error
		model, err = model.Normalize()
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_settings", err.Error())
			return
		}
	}

	s.mu.Lock()
	if update != nil && update.APIKey == nil && model.Protocol == s.model.Protocol && model.BaseURL == s.model.BaseURL {
		model.APIKey = s.model.APIKey
	}
	err := config.SaveConfig(r.Context(), &config.Config{Model: model}, s.path)
	if err == nil {
		s.model = model
	}
	s.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "settings_write_failed", "无法保存模型设置")
		return
	}
	writeJSON(w, http.StatusOK, summarize(model))
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
