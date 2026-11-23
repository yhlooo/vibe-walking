package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/levels"
)

func TestLocalGameDataSurvivesRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".vibewalking")
	start := func() http.Handler {
		t.Helper()
		handler, err := newHandler(dir, true, logr.Discard())
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
	builtInIDs := []string{"walk-to-red-button", "slippery-floor", "weightlessness", "midair-jump", "all-roads-lead-to-rome", "trust"}
	builtInNames := []string{"01 走到红色按钮", "02 小心地滑", "03 失重", "04 悬空起跳", "05 条条大路通罗马", "06 信任"}
	if len(catalog.Levels) != len(builtInIDs) {
		t.Fatalf("unexpected built-in order: %+v", catalog)
	}
	for index, entry := range catalog.Levels {
		if entry.Kind != "builtin" || entry.ID != builtInIDs[index] || entry.Level.Name != builtInNames[index] {
			t.Fatalf("unexpected built-in level at index %d: %+v", index, entry)
		}
	}
	request("GET", "levels/0001", nil, 404)
	request("GET", "levels/0002", nil, 404)
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
	assertOrder := func(ids ...string) {
		t.Helper()
		catalog := gameResponse[levels.Catalog](t, request("GET", "levels", nil, 200))
		var actual []string
		for _, entry := range catalog.Levels {
			actual = append(actual, entry.ID)
		}
		if !slices.Equal(actual, append(slices.Clone(builtInIDs), ids...)) {
			t.Fatalf("unexpected catalog order: %v", actual)
		}
	}
	assertOrder(custom.ID, legacy.ID)
	for _, invalid := range [][]string{{legacy.ID}, {legacy.ID, legacy.ID}, {builtin.ID, custom.ID}, {"missing", custom.ID}} {
		request("PUT", "levels", map[string][]string{"ids": invalid}, 400)
	}
	assertOrder(custom.ID, legacy.ID)
	request("PUT", "levels", map[string][]string{"ids": {legacy.ID, custom.ID}}, 200)
	assertOrder(legacy.ID, custom.ID)

	var run levels.Run
	run.World.Player.X, run.World.Player.Y, run.World.Player.Facing = 7.25, 8, 1
	elapsed := int64(1000)
	run.ElapsedMS = &elapsed
	update := levels.ProgressUpdate{Revision: builtin.Revision, SavedAt: 10, Recent: true, Run: &run}
	request("PUT", "progress/"+builtin.ID, update, 200)
	customRun := run
	moveDistance := 0.2
	customRun.World.MoveDistance = &moveDistance
	request("PUT", "progress/"+custom.ID, levels.ProgressUpdate{Revision: saved.Revision, SavedAt: 11, Recent: true, Run: &customRun}, 200)

	handler = start()
	assertOrder(legacy.ID, custom.ID)
	if err := os.WriteFile(filepath.Join(dir, "levels", "manual.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	assertOrder(legacy.ID, custom.ID, "manual")
	additional := gameResponse[levels.Entry](t, request("POST", "levels", struct{}{}, 201))
	assertOrder(legacy.ID, custom.ID, "manual", additional.ID)
	savedProgress := gameResponse[levels.Progress](t, request("GET", "progress", nil, 200))
	if entry := savedProgress.Levels[builtin.ID]; savedProgress.RecentBuiltin != builtin.ID ||
		entry.Run == nil || entry.Run.World.Player.X != 7.25 || *entry.Run.ElapsedMS != elapsed {
		t.Fatalf("active built-in checkpoint not restored: %+v", savedProgress)
	}
	if entry := savedProgress.Levels[custom.ID]; entry.Run == nil || entry.Run.World.MoveDistance == nil ||
		*entry.Run.World.MoveDistance != moveDistance {
		t.Fatalf("acceleration progress not restored: %+v", entry.Run)
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
