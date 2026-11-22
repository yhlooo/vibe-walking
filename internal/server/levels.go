package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/yhlooo/vibe-walking/levels"
)

func (s *service) handleLevels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		catalog, err := s.levels.List()
		s.writeGameData(w, http.StatusOK, catalog, err)
	case http.MethodPost:
		var body struct {
			Legacy json.RawMessage `json:"legacy"`
		}
		if err := decodeJSON(http.MaxBytesReader(w, r.Body, 2*levels.MaxDefinitionBytes), &body, true); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_level", "创建请求格式无效")
			return
		}
		var legacy *levels.Definition
		if body.Legacy != nil {
			level, err := levels.Decode(body.Legacy)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_level", err.Error())
				return
			}
			legacy = &level
		}
		entry, err := s.levels.Create(r.Context(), legacy)
		s.writeGameData(w, http.StatusCreated, entry, err)
	default:
		allowGameMethods(w, "GET, POST")
	}
}

func (s *service) handleLevel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	switch r.Method {
	case http.MethodGet:
		entry, err := s.levels.Get(id)
		s.writeGameData(w, http.StatusOK, entry, err)
	case http.MethodPut:
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, levels.MaxDefinitionBytes))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_level", "关卡应为不超过 64 KiB 的 JSON")
			return
		}
		level, err := levels.Decode(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_level", err.Error())
			return
		}
		entry, err := s.levels.Update(r.Context(), id, level)
		s.writeGameData(w, http.StatusOK, entry, err)
	default:
		allowGameMethods(w, "GET, PUT")
	}
}

func (s *service) handleProgress(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		progress, err := s.levels.ReadProgress()
		s.writeGameData(w, http.StatusOK, progress, err)
	case http.MethodPost:
		var old levels.LegacyProgress
		if err := decodeJSON(http.MaxBytesReader(w, r.Body, 64<<10), &old, true); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_progress", "旧进度格式无效")
			return
		}
		progress, err := s.levels.MigrateProgress(r.Context(), old)
		s.writeGameData(w, http.StatusOK, progress, err)
	default:
		allowGameMethods(w, "GET, POST")
	}
}

func (s *service) handleLevelProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		allowGameMethods(w, "PUT")
		return
	}
	var update levels.ProgressUpdate
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 16<<10), &update, true); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_progress", "游玩进度格式无效")
		return
	}
	progress, err := s.levels.UpdateProgress(r.Context(), r.PathValue("id"), update)
	s.writeGameData(w, http.StatusOK, progress, err)
}

func allowGameMethods(w http.ResponseWriter, methods string) {
	w.Header().Set("Allow", methods)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "此接口不接受当前请求方法")
}

func (s *service) writeGameData(w http.ResponseWriter, status int, data any, err error) {
	switch {
	case err == nil:
		writeJSON(w, status, data)
	case errors.Is(err, levels.ErrNotFound):
		writeError(w, http.StatusNotFound, "level_not_found", err.Error())
	case errors.Is(err, levels.ErrInvalidProgress):
		writeError(w, http.StatusBadRequest, "invalid_progress", err.Error())
	case errors.Is(err, levels.ErrLevelChanged):
		writeError(w, http.StatusConflict, "level_changed", err.Error())
	default:
		s.logger.Error(err, "read or write game data")
		writeError(w, http.StatusInternalServerError, "game_data_failed", "无法读取或保存本地游戏数据")
	}
}
