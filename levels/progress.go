package levels

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/yhlooo/vibe-walking/internal/jsonfile"
)

// ErrInvalidProgress 表示提交的记录不符合游玩进度格式。
var ErrInvalidProgress = errors.New("游玩进度格式无效")

// ErrLevelChanged 表示提交成绩所用的关卡修订号已过期。
var ErrLevelChanged = errors.New("关卡已修改，请重新进入关卡")

const progressVersion = 2

var attemptIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// Completion 记录一次通关的模型、时间和用时。
type Completion struct {
	AttemptID   string    `json:"attemptID"`
	Revision    string    `json:"revision"`
	Model       string    `json:"model,omitempty"`
	CompletedAt time.Time `json:"completedAt"`
	DurationMS  *int64    `json:"durationMS,omitempty"`
}

// CompletionSummary 保存关卡的首次通关时间和最快成绩，也用于兼容旧版汇总。
type CompletionSummary struct {
	CompletedAt    time.Time `json:"completedAt"`
	BestDurationMS *int64    `json:"bestDurationMS,omitempty"`
}

// LevelProgress 保存关卡的成绩汇总及逐次通关记录。
type LevelProgress struct {
	CompletionSummary
	Completions []Completion `json:"completions,omitempty"`
}

// Progress 汇总通关记录和首页继续入口所用的最近关卡 ID。
type Progress struct {
	RecentLevel string                   `json:"recentLevel,omitempty"`
	Levels      map[string]LevelProgress `json:"levels"`
}

// CompletionUpdate 描述客户端提交的一次通关。
type CompletionUpdate struct {
	Revision   string `json:"revision"`
	Model      string `json:"model,omitempty"`
	DurationMS *int64 `json:"durationMS,omitempty"`
}

// LegacyProgress 是从浏览器旧存储导入的关卡及成绩汇总。
type LegacyProgress struct {
	RecentBuiltin string                       `json:"recentBuiltin"`
	Levels        map[string]CompletionSummary `json:"levels"`
}

// ReadProgress 读取持久化进度，首次打开旧文件时移除已废弃的尝试快照。
func (s *Store) ReadProgress(ctx context.Context) (Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	progress, upgrade, err := s.readProgress()
	if err == nil && upgrade {
		err = s.writeProgress(ctx, progress)
	}
	return progress, err
}

// readProgress 读取进度文件，解码时只选取旧文件中仍使用的字段。
func (s *Store) readProgress() (Progress, bool, error) {
	progress := Progress{Levels: make(map[string]LevelProgress)}
	raw, err := os.ReadFile(s.progressPath())
	if errors.Is(err, os.ErrNotExist) {
		return progress, false, nil
	}
	if err != nil {
		return Progress{}, false, err
	}

	file := struct {
		Progress
		Version       int    `json:"version"`
		RecentBuiltin string `json:"recentBuiltin"`
	}{Progress: progress}
	if err := json.Unmarshal(raw, &file); err != nil {
		return Progress{}, false, err
	}
	if file.Version != 0 && file.Version != progressVersion {
		return Progress{}, false, errors.New("不支持的游玩进度版本")
	}

	if file.Levels == nil {
		file.Levels = make(map[string]LevelProgress)
	}
	upgrade := file.Version == 0
	if upgrade {
		if file.RecentLevel == "" {
			file.RecentLevel = file.RecentBuiltin
		}
		for id, entry := range file.Levels {
			if entry.CompletedAt.IsZero() {
				delete(file.Levels, id)
			}
		}
	}
	return file.Progress, upgrade, nil
}

// progressPath 返回进度文件在数据目录中的路径。
func (s *Store) progressPath() string {
	return filepath.Join(s.dir, "progress.json")
}

// writeProgress 原子替换当前版本的进度文件。
func (s *Store) writeProgress(ctx context.Context, progress Progress) error {
	return jsonfile.Write(ctx, s.progressPath(), struct {
		Version int `json:"version"`
		Progress
	}{Version: progressVersion, Progress: progress})
}

// SetRecentLevel 按服务处理顺序更新最近进入的正式游玩关卡。
func (s *Store) SetRecentLevel(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, err := s.get(id)
	if err != nil {
		return err
	}
	if !entry.Level.Playable() {
		return ErrInvalidProgress
	}
	progress, upgrade, err := s.readProgress()
	if err != nil {
		return err
	}
	if progress.RecentLevel == id && !upgrade {
		return nil
	}
	progress.RecentLevel = id
	return s.writeProgress(ctx, progress)
}

// RecordCompletion 校验关卡修订号并追加一次通关，重复提交同一尝试时返回已有记录。
func (s *Store) RecordCompletion(ctx context.Context, id, attemptID string, update CompletionUpdate) (Completion, error) {
	if !attemptIDPattern.MatchString(attemptID) || !validDuration(update.DurationMS) ||
		(update.Model != "" && strings.TrimSpace(update.Model) != update.Model) {
		return Completion{}, ErrInvalidProgress
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, err := s.get(id)
	if err != nil {
		return Completion{}, err
	}
	progress, _, err := s.readProgress()
	if err != nil {
		return Completion{}, err
	}

	current := progress.Levels[id]
	for _, completion := range current.Completions {
		if completion.AttemptID == attemptID {
			return completion, nil
		}
	}
	if update.Revision != entry.Revision {
		return Completion{}, ErrLevelChanged
	}
	if !entry.Level.Playable() {
		return Completion{}, ErrInvalidProgress
	}

	completion := Completion{
		AttemptID: attemptID, Revision: update.Revision, Model: update.Model,
		CompletedAt: time.Now().UTC(), DurationMS: update.DurationMS,
	}
	current.Completions = append(current.Completions, completion)
	current.mergeSummary(CompletionSummary{CompletedAt: completion.CompletedAt, BestDurationMS: completion.DurationMS})
	progress.Levels[id] = current
	return completion, s.writeProgress(ctx, progress)
}

// mergeSummary 保留最早通关时间及最短已知用时。
func (p *LevelProgress) mergeSummary(next CompletionSummary) {
	if p.CompletedAt.IsZero() || next.CompletedAt.Before(p.CompletedAt) {
		p.CompletedAt = next.CompletedAt
	}
	if next.BestDurationMS != nil && (p.BestDurationMS == nil || *next.BestDurationMS < *p.BestDurationMS) {
		p.BestDurationMS = next.BestDurationMS
	}
}

// validDuration 接受未提供或处于 JavaScript 安全整数范围内的非负时长。
func validDuration(value *int64) bool {
	return value == nil || (*value >= 0 && *value <= 1<<53-1)
}

// MigrateProgress 将浏览器旧记录合并到当前进度。
func (s *Store) MigrateProgress(ctx context.Context, old LegacyProgress) (Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	progress, _, err := s.readProgress()
	if err != nil {
		return Progress{}, err
	}

	// 浏览器旧版进度只迁移已知内置关卡，已有最近记录优先保留。
	for _, entry := range s.builtIns {
		if old.RecentBuiltin == entry.ID && progress.RecentLevel == "" {
			progress.RecentLevel = entry.ID
		}
		if item, ok := old.Levels[entry.ID]; ok && !item.CompletedAt.IsZero() && validDuration(item.BestDurationMS) {
			current := progress.Levels[entry.ID]
			current.mergeSummary(item)
			progress.Levels[entry.ID] = current
		}
	}
	return progress, s.writeProgress(ctx, progress)
}
