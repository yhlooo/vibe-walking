package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-logr/logr"

	"github.com/yhlooo/vibe-walking/levels"
)

// TestLocalGameDataSurvivesRestart 验证关卡和进度在创建新服务实例后仍可读取。
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
	builtInIDs := []string{
		"walk-to-red-button", "slippery-floor", "weightlessness", "midair-jump", "all-roads-lead-to-rome",
		"three-days-to-see", "leap-of-faith", "jump", "trust",
	}
	builtInNames := []string{
		"01 走到红色按钮", "02 小心地滑", "03 失重", "04 悬空起跳", "05 条条大路通罗马",
		"06 假如给我三天光明", "07 信仰之跃", "08 跳一跳", "09 信任",
	}
	if len(catalog.Levels) != len(builtInIDs) {
		t.Fatalf("unexpected built-in order: %+v", catalog)
	}
	for index, entry := range catalog.Levels {
		if entry.Kind != "builtin" || entry.ID != builtInIDs[index] || entry.Level.Name != builtInNames[index] {
			t.Fatalf("unexpected built-in level at index %d: %+v", index, entry)
		}
		if entry.ID == "three-days-to-see" && !entry.Level.DisableReadScreen {
			t.Fatal("expected Three Days to See to disable ReadScreen")
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
	custom.Level.DisableReadScreen = true
	saved := gameResponse[levels.Entry](t, request("PUT", levelPath, custom.Level, 200))
	if saved.Revision != custom.Revision || saved.Level.SystemPrompt == nil || *saved.Level.SystemPrompt != "" {
		t.Fatalf("editing the prompt should preserve the physics revision and the explicit override: %+v", saved)
	}
	if !saved.Level.DisableReadScreen {
		t.Fatalf("expected ReadScreen to be disabled: %+v", saved)
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

	// 重复提交同一个旧草稿，模拟浏览器迁移后未能清理旧记录的重试。
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

	// 模拟旧服务保存过的通关汇总和未完成尝试。
	progressPath := filepath.Join(dir, "progress.json")
	oldProgress := fmt.Sprintf(`{
		"recentBuiltin":%q,"recentBuiltinAt":10,"levels":{
			%q:{"completedAt":"2026-11-20T10:00:00Z","bestDurationMS":4300,"run":{"elapsedMS":1000},"savedAt":10},
			%q:{"run":{"elapsedMS":2000},"savedAt":11}
		}
	}`, builtin.ID, builtin.ID, custom.ID)
	if err := os.WriteFile(progressPath, []byte(oldProgress), 0o600); err != nil {
		t.Fatal(err)
	}

	handler = start()
	reloaded := gameResponse[levels.Entry](t, request("GET", levelPath, nil, 200))
	if !reloaded.Level.DisableReadScreen {
		t.Fatalf("expected the ReadScreen setting to survive a restart: %+v", reloaded)
	}
	assertOrder(legacy.ID, custom.ID)
	if err := os.WriteFile(filepath.Join(dir, "levels", "manual.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	assertOrder(legacy.ID, custom.ID, "manual")
	additional := gameResponse[levels.Entry](t, request("POST", "levels", struct{}{}, 201))
	assertOrder(legacy.ID, custom.ID, "manual", additional.ID)

	// 旧版通关汇总和最近关卡继续有效，快照从接口和文件中清除。
	oldCompletedAt := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	migrated := gameResponse[levels.Progress](t, request("GET", "progress", nil, 200))
	prior := migrated.Levels[builtin.ID]
	if migrated.RecentLevel != builtin.ID || len(migrated.Levels) != 1 || !prior.CompletedAt.Equal(oldCompletedAt) ||
		prior.BestDurationMS == nil || *prior.BestDurationMS != 4300 || len(prior.Completions) != 0 {
		t.Fatalf("expected only the legacy summary and recent level: %+v", migrated)
	}
	migratedFile, err := os.ReadFile(progressPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"recentBuiltin"`, `"run"`, `"savedAt"`, `"elapsedMS"`} {
		if strings.Contains(string(migratedFile), field) {
			t.Fatalf("legacy field %s still on disk: %s", field, migratedFile)
		}
	}

	// 后打开的自建关卡成为继续入口。原页面仍可提交成绩，互不覆盖。
	request("PUT", "progress/recent/"+builtin.ID, nil, 204)
	request("PUT", "progress/recent/"+custom.ID, nil, 204)
	request("PUT", "progress/"+builtin.ID, json.RawMessage(`{"run":{"elapsedMS":2000}}`), 404)
	progress := gameResponse[levels.Progress](t, request("GET", "progress", nil, 200))
	if progress.RecentLevel != custom.ID || len(progress.Levels) != 1 {
		t.Fatalf("entering a level must only change the recent level: %+v", progress)
	}
	resultPath := "progress/" + builtin.ID + "/completions/"
	faster, slower := int64(2700), int64(5900)
	firstID, secondID := fmt.Sprintf("%032x", 1), fmt.Sprintf("%032x", 2)
	first := levels.CompletionUpdate{Revision: builtin.Revision, Model: "a/model", DurationMS: &faster}
	second := levels.CompletionUpdate{Revision: builtin.Revision, Model: "b/model", DurationMS: &slower}
	request("PUT", resultPath+"invalid", first, 400)

	// 并发提交同一关的不同尝试及重复请求，确保每次通关只记一条。
	replies := make(chan *httptest.ResponseRecorder, 3)
	for _, attempt := range []struct {
		id     string
		result levels.CompletionUpdate
	}{{firstID, first}, {secondID, second}, {firstID, first}} {
		body, err := json.Marshal(attempt.result)
		if err != nil {
			t.Fatal(err)
		}
		go func() { replies <- send(handler, "PUT", "/api/v1/"+resultPath+attempt.id, string(body)) }()
	}
	got := make(map[string]levels.Completion)
	for range 3 {
		reply := <-replies
		if reply.Code != 200 {
			t.Fatalf("completion returned %d: %s", reply.Code, reply.Body)
		}
		record := gameResponse[levels.Completion](t, reply)
		if previous, ok := got[record.AttemptID]; ok && !previous.CompletedAt.Equal(record.CompletedAt) {
			t.Fatalf("retry changed completion time: %+v", record)
		}
		got[record.AttemptID] = record
	}

	handler = start()
	progress = gameResponse[levels.Progress](t, request("GET", "progress", nil, 200))
	record := progress.Levels[builtin.ID]
	if progress.RecentLevel != custom.ID || len(record.Completions) != 2 ||
		record.BestDurationMS == nil || *record.BestDurationMS != faster || !record.CompletedAt.Equal(oldCompletedAt) {
		t.Fatalf("expected both attempts, preserved summary and the latest entered level: %+v", progress)
	}
	expectedResults := map[string]levels.CompletionUpdate{firstID: first, secondID: second}
	for _, completion := range record.Completions {
		expected, exists := expectedResults[completion.AttemptID]
		if !exists || completion.Model != expected.Model ||
			completion.DurationMS == nil || *completion.DurationMS != *expected.DurationMS ||
			completion.CompletedAt.IsZero() || !got[completion.AttemptID].CompletedAt.Equal(completion.CompletedAt) {
			t.Fatalf("completion data did not survive restart: %+v", completion)
		}
	}

	// 改变物理规则后，以旧修订号提交成绩应收到冲突响应。
	custom.Level.Gravity = 2
	changed := gameResponse[levels.Entry](t, request("PUT", levelPath, custom.Level, 200))
	if changed.Revision == saved.Revision {
		t.Fatal("physics edits must change the level revision")
	}
	first.Revision = saved.Revision
	request("PUT", "progress/"+custom.ID+"/completions/"+firstID, first, 409)
}

// gameResponse 将测试响应体解码为调用方指定的类型。
func gameResponse[T any](t *testing.T, reply *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(reply.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}
