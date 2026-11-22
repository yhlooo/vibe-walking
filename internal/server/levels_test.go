package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/levels"
)

func TestLocalGameDataSurvivesRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".vibewalking")
	path := filepath.Join(dir, "settings.json")
	start := func() http.Handler {
		t.Helper()
		handler, err := newHandler(path, true, logr.Discard())
		if err != nil {
			t.Fatal(err)
		}
		return handler
	}
	handler := start()
	request := func(method, path string, body any, status int) *httptest.ResponseRecorder {
		t.Helper()
		var input []byte
		var err error
		if body != nil {
			if raw, ok := body.(json.RawMessage); ok {
				input = raw
			} else if input, err = json.Marshal(body); err != nil {
				t.Fatal(err)
			}
		}
		reply := send(handler, method, "/api/v1/"+path, string(input))
		if reply.Code != status {
			t.Fatalf("%s %s: expected %d, got %d %s", method, path, status, reply.Code, reply.Body)
		}
		return reply
	}
	catalog := gameResponse[levels.Catalog](t, request("GET", "levels", nil, 200))
	if len(catalog.Levels) < 2 || catalog.Levels[0].Kind != "builtin" || catalog.Levels[1].ID != "0002" {
		t.Fatalf("unexpected built-in order: %+v", catalog)
	}
	builtin := catalog.Levels[0]
	request("PUT", "levels/"+builtin.ID, builtin.Level, 404)

	custom := gameResponse[levels.Entry](t, request("POST", "levels", struct{}{}, 201))
	levelPath := "levels/" + custom.ID
	custom.Level.Name = "自定义关卡"
	empty := ""
	custom.Level.SystemPrompt = &empty
	saved := gameResponse[levels.Entry](t, request("PUT", levelPath, custom.Level, 200))
	if saved.Revision != custom.Revision || saved.Level.SystemPrompt == nil || *saved.Level.SystemPrompt != "" {
		t.Fatalf("editing the prompt should preserve the physics revision and the explicit override: %+v", saved)
	}
	request("PUT", levelPath, json.RawMessage(`{"name":"broken"}`), 400)
	custom.Level.SystemPrompt = nil
	request("PUT", levelPath, custom.Level, 200)
	raw, err := os.ReadFile(filepath.Join(dir, levelPath+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "systemPrompt") || strings.Contains(string(raw), "revision") {
		t.Fatalf("expected a plain level definition with no prompt override: %s", raw)
	}
	legacyBody := map[string]levels.Definition{"legacy": custom.Level}
	legacy := gameResponse[levels.Entry](t, request("POST", "levels", legacyBody, 201))
	if again := gameResponse[levels.Entry](t, request("POST", "levels", legacyBody, 201)); again.ID != legacy.ID {
		t.Fatalf("migration created a duplicate: %s and %s", legacy.ID, again.ID)
	}

	var run levels.Run
	run.World.Player.X, run.World.Player.Y, run.World.Player.Facing = 7.25, 8, 1
	elapsed := int64(1000)
	run.ElapsedMS = &elapsed
	update := levels.ProgressUpdate{Revision: builtin.Revision, SavedAt: 10, Recent: true, Run: &run}
	request("PUT", "progress/"+builtin.ID, update, 200)
	request("PUT", "progress/"+custom.ID, levels.ProgressUpdate{Revision: saved.Revision, SavedAt: 11, Recent: true, Run: &run}, 200)

	handler = start()
	catalog = gameResponse[levels.Catalog](t, request("GET", "levels", nil, 200))
	if len(catalog.Levels) != 4 {
		t.Fatalf("local definitions not available after restart: %+v", catalog)
	}
	savedProgress := gameResponse[levels.Progress](t, request("GET", "progress", nil, 200))
	if entry := savedProgress.Levels[builtin.ID]; savedProgress.RecentBuiltin != builtin.ID ||
		entry.Run == nil || entry.Run.World.Player.X != 7.25 || *entry.Run.ElapsedMS != elapsed {
		t.Fatalf("active built-in checkpoint not restored: %+v", savedProgress)
	}

	duration := int64(3600)
	result := levels.ProgressUpdate{Revision: builtin.Revision, SavedAt: 12, Won: true, DurationMS: &duration}
	first := gameResponse[levels.LevelProgress](t, request("PUT", "progress/"+builtin.ID, result, 200))
	request("PUT", "progress/"+builtin.ID, update, 200)
	longer := int64(5900)
	result.SavedAt, result.DurationMS = 13, &longer
	request("PUT", "progress/"+builtin.ID, result, 200)
	faster := int64(2700)
	result.SavedAt, result.DurationMS = 14, &faster
	best := gameResponse[levels.LevelProgress](t, request("PUT", "progress/"+builtin.ID, result, 200))
	if best.Run != nil || best.Completion == nil || *best.BestDurationMS != faster || !best.CompletedAt.Equal(first.CompletedAt) {
		t.Fatalf("completion did not keep earliest time and fastest duration: %+v", best)
	}
	if _, err := os.Stat(filepath.Join(dir, "progress.json")); err != nil {
		t.Fatal(err)
	}

	custom.Level.Gravity = 2
	changed := gameResponse[levels.Entry](t, request("PUT", levelPath, custom.Level, 200))
	if changed.Revision == saved.Revision {
		t.Fatal("physics edits must invalidate old checkpoints")
	}
	request("PUT", "progress/"+custom.ID, levels.ProgressUpdate{Revision: saved.Revision, SavedAt: 15, Run: &run}, 409)
}

func gameResponse[T any](t *testing.T, reply *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(reply.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}
