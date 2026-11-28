package levels

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/yhlooo/vibe-walking/internal/jsonfile"
)

// ErrInvalidProgress 表示提交的记录不符合游玩进度格式。
var ErrInvalidProgress = errors.New("游玩进度格式无效")

// ErrLevelChanged 表示存档所基于的关卡修订号已过期。
var ErrLevelChanged = errors.New("关卡已修改，请重新进入关卡")

// Completion 记录通关时间和已知的最短用时。
type Completion struct {
	CompletedAt    time.Time `json:"completedAt"`
	BestDurationMS *int64    `json:"bestDurationMS,omitempty"`
}

// WorldState 保存恢复游玩所需的玩家位置、跳跃和水平移动状态。
type WorldState struct {
	Player struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Facing int     `json:"facing"`
	} `json:"player"`
	VelocityY         float64 `json:"velocityY"`
	CanJump           bool    `json:"canJump"`
	PreviousDirection int     `json:"previousDirection"`
	// 记录当前方向上的加速距离，旧存档可以省略。
	MoveDistance   *float64 `json:"moveDistance,omitempty"`
	SlideDirection int      `json:"slideDirection"`
	SlideRemaining float64  `json:"slideRemaining"`
}

// Run 是可继续的一局的存档。
type Run struct {
	World     WorldState `json:"world"`
	ElapsedMS *int64     `json:"elapsedMS,omitempty"`
}

// LevelProgress 记录一个关卡的通关成绩和当前存档。
type LevelProgress struct {
	*Completion
	// 标记当前存档所对应的关卡物理定义。
	Revision string `json:"revision,omitempty"`
	Run      *Run   `json:"run,omitempty"`
	// 用于比较客户端提交的存档先后。
	SavedAt int64 `json:"savedAt,omitempty"`
}

// Progress 汇总关卡进度和最近游玩的内置关卡。
type Progress struct {
	RecentBuiltin   string                   `json:"recentBuiltin,omitempty"`
	RecentBuiltinAt int64                    `json:"recentBuiltinAt,omitempty"`
	Levels          map[string]LevelProgress `json:"levels"`
}

// ProgressUpdate 描述客户端提交的一次存档或成绩更新。
type ProgressUpdate struct {
	Revision string `json:"revision"`
	SavedAt  int64  `json:"savedAt"`
	Recent   bool   `json:"recent,omitempty"`
	// 空值表示清除当前存档。
	Run        *Run   `json:"run"`
	Won        bool   `json:"won,omitempty"`
	DurationMS *int64 `json:"durationMS,omitempty"`
}

// LegacyProgress 是从浏览器旧存储导入的通关记录。
type LegacyProgress struct {
	RecentBuiltin string                `json:"recentBuiltin"`
	Levels        map[string]Completion `json:"levels"`
}

// ReadProgress 在锁保护下读取持久化进度。
func (s *Store) ReadProgress() (Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readProgress()
}

// readProgress 读取进度文件，并为新安装初始化空记录。
func (s *Store) readProgress() (Progress, error) {
	progress := Progress{Levels: make(map[string]LevelProgress)}
	raw, err := os.ReadFile(s.progressPath())
	if errors.Is(err, os.ErrNotExist) {
		return progress, nil
	}
	if err != nil {
		return Progress{}, err
	}
	if err := json.Unmarshal(raw, &progress); err != nil {
		return Progress{}, err
	}

	// 旧文件可能省略关卡记录，为后续合并准备可写的映射。
	if progress.Levels == nil {
		progress.Levels = make(map[string]LevelProgress)
	}
	return progress, nil
}

// progressPath 返回进度文件在数据目录中的路径。
func (s *Store) progressPath() string {
	return filepath.Join(s.dir, "progress.json")
}

// mergeCompletion 合并通关时间并保留已知的最短用时。
func mergeCompletion(previous *Completion, next Completion) *Completion {
	if previous == nil {
		return &next
	}

	// 将最早通关时间和最快用时分别比较，两者可能来自不同场游玩。
	best := *previous
	if next.CompletedAt.Before(best.CompletedAt) {
		best.CompletedAt = next.CompletedAt
	}
	if next.BestDurationMS != nil && (best.BestDurationMS == nil || *next.BestDurationMS < *best.BestDurationMS) {
		best.BestDurationMS = next.BestDurationMS
	}
	return &best
}

// UpdateProgress 校验关卡修订号并合并客户端进度。
func (s *Store) UpdateProgress(ctx context.Context, id string, update ProgressUpdate) (LevelProgress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, err := s.get(id)
	if err != nil {
		return LevelProgress{}, err
	}

	// 先核对物理版本，避免旧地图的位置进入新地图的存档。
	if update.Revision != entry.Revision {
		return LevelProgress{}, ErrLevelChanged
	}
	if update.SavedAt <= 0 || !entry.Level.Playable() || !validDuration(update.DurationMS) ||
		(update.Run != nil && (update.Won || !validRun(entry.Level, *update.Run))) ||
		(!update.Won && update.DurationMS != nil) {
		return LevelProgress{}, ErrInvalidProgress
	}

	progress, err := s.readProgress()
	if err != nil {
		return LevelProgress{}, err
	}

	// 用修订号和时间戳保护较新的存档，通关成绩独立合并。
	current := progress.Levels[id]
	if current.Revision != entry.Revision || update.SavedAt >= current.SavedAt {
		current.Revision, current.Run, current.SavedAt = entry.Revision, update.Run, update.SavedAt
	}
	if update.Won {
		current.Completion = mergeCompletion(current.Completion, Completion{CompletedAt: time.Now().UTC(), BestDurationMS: update.DurationMS})
	}

	// 首页继续入口只记录内置关卡，并以时间戳筛选最新一次访问。
	if update.Recent && entry.Kind == "builtin" && update.SavedAt >= progress.RecentBuiltinAt {
		progress.RecentBuiltin, progress.RecentBuiltinAt = id, update.SavedAt
	}

	progress.Levels[id] = current
	return current, jsonfile.Write(ctx, s.progressPath(), progress)
}

// validDuration 接受未提供或处于 JavaScript 安全整数范围内的非负时长。
func validDuration(value *int64) bool {
	return value == nil || (*value >= 0 && *value <= 1<<53-1)
}

// validRun 校验存档中的数值和角色位置。
func validRun(level Definition, run Run) bool {
	w := run.World
	direction := func(value int) bool { return value >= -1 && value <= 1 }
	return validDuration(run.ElapsedMS) && w.Player.X >= 0 && w.Player.X <= float64(len(level.Tiles[0])-1) &&
		w.Player.Y >= 0 && w.Player.Y < float64(len(level.Tiles)) && (w.Player.Facing == -1 || w.Player.Facing == 1) &&
		w.VelocityY >= -20 && w.VelocityY <= 20 && direction(w.PreviousDirection) && direction(w.SlideDirection) &&
		(w.MoveDistance == nil || (*w.MoveDistance >= 0 && *w.MoveDistance <= 1)) &&
		w.SlideRemaining >= 0 && w.SlideRemaining <= 10
}

// MigrateProgress 将浏览器旧记录合并到当前进度。
func (s *Store) MigrateProgress(ctx context.Context, old LegacyProgress) (Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	progress, err := s.readProgress()
	if err != nil {
		return Progress{}, err
	}

	// 浏览器旧版进度只迁移已知内置关卡，已有最近记录优先保留。
	for _, entry := range s.builtIns {
		if old.RecentBuiltin == entry.ID && progress.RecentBuiltin == "" {
			progress.RecentBuiltin = entry.ID
		}
		if item, ok := old.Levels[entry.ID]; ok && !item.CompletedAt.IsZero() && validDuration(item.BestDurationMS) {
			current := progress.Levels[entry.ID]
			current.Completion = mergeCompletion(current.Completion, item)
			progress.Levels[entry.ID] = current
		}
	}
	return progress, jsonfile.Write(ctx, s.progressPath(), progress)
}
