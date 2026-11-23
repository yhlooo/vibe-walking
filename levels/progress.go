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

var ErrInvalidProgress = errors.New("游玩进度格式无效")
var ErrLevelChanged = errors.New("关卡已修改，请重新进入关卡")

type Completion struct {
	CompletedAt    time.Time `json:"completedAt"`
	BestDurationMS *int64    `json:"bestDurationMS,omitempty"`
}

type WorldState struct {
	Player struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Facing int     `json:"facing"`
	} `json:"player"`
	VelocityY         float64  `json:"velocityY"`
	CanJump           bool     `json:"canJump"`
	PreviousDirection int      `json:"previousDirection"`
	MoveDistance      *float64 `json:"moveDistance,omitempty"`
	SlideDirection    int      `json:"slideDirection"`
	SlideRemaining    float64  `json:"slideRemaining"`
}

type Run struct {
	World     WorldState `json:"world"`
	ElapsedMS *int64     `json:"elapsedMS,omitempty"`
}

type LevelProgress struct {
	*Completion
	Revision string `json:"revision,omitempty"`
	Run      *Run   `json:"run,omitempty"`
	SavedAt  int64  `json:"savedAt,omitempty"`
}

type Progress struct {
	RecentBuiltin   string                   `json:"recentBuiltin,omitempty"`
	RecentBuiltinAt int64                    `json:"recentBuiltinAt,omitempty"`
	Levels          map[string]LevelProgress `json:"levels"`
}

type ProgressUpdate struct {
	Revision   string `json:"revision"`
	SavedAt    int64  `json:"savedAt"`
	Recent     bool   `json:"recent,omitempty"`
	Run        *Run   `json:"run"`
	Won        bool   `json:"won,omitempty"`
	DurationMS *int64 `json:"durationMS,omitempty"`
}

type LegacyProgress struct {
	RecentBuiltin string                `json:"recentBuiltin"`
	Levels        map[string]Completion `json:"levels"`
}

func (s *Store) ReadProgress() (Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readProgress()
}

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
	if progress.Levels == nil {
		progress.Levels = make(map[string]LevelProgress)
	}
	return progress, nil
}

func (s *Store) progressPath() string {
	return filepath.Join(s.dir, "progress.json")
}

func mergeCompletion(previous *Completion, next Completion) *Completion {
	if previous == nil {
		return &next
	}
	best := *previous
	if next.CompletedAt.Before(best.CompletedAt) {
		best.CompletedAt = next.CompletedAt
	}
	if next.BestDurationMS != nil && (best.BestDurationMS == nil || *next.BestDurationMS < *best.BestDurationMS) {
		best.BestDurationMS = next.BestDurationMS
	}
	return &best
}

func (s *Store) UpdateProgress(ctx context.Context, id string, update ProgressUpdate) (LevelProgress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, err := s.get(id)
	if err != nil {
		return LevelProgress{}, err
	}
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
	current := progress.Levels[id]
	if current.Revision != entry.Revision || update.SavedAt >= current.SavedAt {
		current.Revision, current.Run, current.SavedAt = entry.Revision, update.Run, update.SavedAt
	}
	if update.Won {
		current.Completion = mergeCompletion(current.Completion, Completion{CompletedAt: time.Now().UTC(), BestDurationMS: update.DurationMS})
	}
	if update.Recent && entry.Kind == "builtin" && update.SavedAt >= progress.RecentBuiltinAt {
		progress.RecentBuiltin, progress.RecentBuiltinAt = id, update.SavedAt
	}
	progress.Levels[id] = current
	return current, jsonfile.Write(ctx, s.progressPath(), progress)
}

func validDuration(value *int64) bool {
	return value == nil || (*value >= 0 && *value <= 1<<53-1)
}

func validRun(level Definition, run Run) bool {
	w := run.World
	direction := func(value int) bool { return value >= -1 && value <= 1 }
	return validDuration(run.ElapsedMS) && w.Player.X >= 0 && w.Player.X <= float64(len(level.Tiles[0])-1) &&
		w.Player.Y >= 0 && w.Player.Y < float64(len(level.Tiles)) && (w.Player.Facing == -1 || w.Player.Facing == 1) &&
		w.VelocityY >= -20 && w.VelocityY <= 20 && direction(w.PreviousDirection) && direction(w.SlideDirection) &&
		(w.MoveDistance == nil || (*w.MoveDistance >= 0 && *w.MoveDistance <= 1)) &&
		w.SlideRemaining >= 0 && w.SlideRemaining <= 10
}

func (s *Store) MigrateProgress(ctx context.Context, old LegacyProgress) (Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	progress, err := s.readProgress()
	if err != nil {
		return Progress{}, err
	}
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
