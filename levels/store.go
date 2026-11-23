package levels

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/yhlooo/vibe-walking/internal/jsonfile"
)

//go:embed meta.json definitions/*.json
var builtInFiles embed.FS

const MaxDefinitionBytes = 64 << 10

var (
	ErrNotFound     = errors.New("关卡不存在")
	ErrInvalidOrder = errors.New("关卡顺序必须包含每个当前自定义关卡 ID，且每个 ID 只能出现一次。若关卡列表已变化，请刷新页面后重试")
	fileID          = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
)

type Entry struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	Description string     `json:"description,omitempty"`
	Level       Definition `json:"level"`
	Revision    string     `json:"revision"`
}

type Catalog struct {
	Levels   []Entry  `json:"levels"`
	Warnings []string `json:"warnings,omitempty"`
}

type Store struct {
	dir      string
	builtIns []Entry
	mu       sync.Mutex
}

func NewStore(dir string) (*Store, error) {
	store := &Store{dir: dir}
	var metadata []struct{ ID, Name, Definition, Description string }
	raw, err := builtInFiles.ReadFile("meta.json")
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	for _, item := range metadata {
		if seen[item.ID] || !fileID.MatchString(item.ID) || strings.HasPrefix(item.ID, "custom-") {
			return nil, fmt.Errorf("invalid built-in level ID %q", item.ID)
		}
		seen[item.ID] = true
		raw, err := builtInFiles.ReadFile("definitions/" + item.Definition)
		if err != nil {
			return nil, err
		}
		level, err := Decode(raw)
		if err != nil {
			return nil, fmt.Errorf("decode built-in level %q: %w", item.ID, err)
		}
		if level.Name != item.Name || !level.Playable() {
			return nil, fmt.Errorf("invalid built-in level %q", item.ID)
		}
		entry := newEntry(item.ID, "builtin", level)
		entry.Description = item.Description
		store.builtIns = append(store.builtIns, entry)
	}
	if len(store.builtIns) == 0 {
		return nil, errors.New("no built-in levels")
	}
	return store, nil
}

func newEntry(id, kind string, level Definition) Entry {
	// Only physical changes invalidate a checkpoint.
	board := level
	board.Name, board.SystemPrompt = "", nil
	board.DisableReadScreen = false
	raw, _ := json.Marshal(board)
	sum := sha256.Sum256(raw)
	return Entry{ID: id, Kind: kind, Level: level, Revision: hex.EncodeToString(sum[:])}
}

func (s *Store) List() (Catalog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list()
}

func (s *Store) list() (Catalog, error) {
	catalog := Catalog{Levels: append([]Entry(nil), s.builtIns...)}
	files, err := os.ReadDir(filepath.Join(s.dir, "levels"))
	if errors.Is(err, os.ErrNotExist) {
		return catalog, nil
	}
	if err != nil {
		return Catalog{}, err
	}
	var custom []Entry
	byID := make(map[string]Entry)
	for _, file := range files {
		id, ok := strings.CutSuffix(file.Name(), ".json")
		if !ok || !fileID.MatchString(id) || !file.Type().IsRegular() {
			continue
		}
		for _, builtIn := range s.builtIns {
			if id == builtIn.ID {
				catalog.Warnings = append(catalog.Warnings, file.Name()+" 与内置关卡 ID 重复")
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		entry, err := s.readCustom(id)
		if err != nil {
			catalog.Warnings = append(catalog.Warnings, "无法读取 "+file.Name()+" · "+err.Error())
			continue
		}
		custom = append(custom, entry)
		byID[id] = entry
	}
	order, err := s.readOrder()
	if err != nil {
		catalog.Warnings = append(catalog.Warnings, "无法读取自定义关卡顺序 · "+err.Error())
	}
	for _, id := range order {
		if entry, ok := byID[id]; ok {
			catalog.Levels = append(catalog.Levels, entry)
			delete(byID, id)
		}
	}
	for _, entry := range custom {
		if _, ok := byID[entry.ID]; ok {
			catalog.Levels = append(catalog.Levels, entry)
		}
	}
	return catalog, nil
}

func (s *Store) orderPath() string {
	return filepath.Join(s.dir, "level-order.json")
}

func (s *Store) readOrder() ([]string, error) {
	raw, err := os.ReadFile(s.orderPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *Store) SetOrder(ctx context.Context, ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	catalog, err := s.list()
	if err != nil {
		return err
	}
	custom := catalog.Levels[len(s.builtIns):]
	if ids == nil || len(ids) != len(custom) {
		return ErrInvalidOrder
	}
	remaining := make(map[string]bool, len(custom))
	for _, entry := range custom {
		remaining[entry.ID] = true
	}
	for _, id := range ids {
		if !remaining[id] {
			return ErrInvalidOrder
		}
		delete(remaining, id)
	}
	return jsonfile.Write(ctx, s.orderPath(), ids)
}

func (s *Store) get(id string) (Entry, error) {
	for _, level := range s.builtIns {
		if level.ID == id {
			return level, nil
		}
	}
	if !fileID.MatchString(id) {
		return Entry{}, ErrNotFound
	}
	return s.readCustom(id)
}

func (s *Store) Get(id string) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.get(id)
}

func (s *Store) levelPath(id string) string {
	return filepath.Join(s.dir, "levels", id+".json")
}

func (s *Store) readCustom(id string) (Entry, error) {
	info, err := os.Lstat(s.levelPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return Entry{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxDefinitionBytes {
		return Entry{}, errors.New("关卡必须是至多 64 KiB 的 JSON 文件")
	}
	raw, err := os.ReadFile(s.levelPath(id))
	if err != nil {
		return Entry{}, err
	}
	level, err := Decode(raw)
	if err != nil {
		return Entry{}, err
	}
	return newEntry(id, "custom", level), nil
}

func (s *Store) Create(ctx context.Context, legacy *Definition) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	level := newDefinition()
	id := "custom-" + rand.Text()
	if legacy != nil {
		id, level = "custom-legacy", *legacy
		existing, err := s.readCustom(id)
		if !errors.Is(err, ErrNotFound) {
			return existing, err
		}
	}
	catalog, err := s.list()
	if err != nil {
		return Entry{}, err
	}
	custom := catalog.Levels[len(s.builtIns):]
	order := make([]string, 0, len(custom)+1)
	for _, entry := range custom {
		order = append(order, entry.ID)
	}
	// Write the order first. If the definition write fails, its missing ID is ignored.
	if err := jsonfile.Write(ctx, s.orderPath(), append(order, id)); err != nil {
		return Entry{}, err
	}
	return newEntry(id, "custom", level), jsonfile.Write(ctx, s.levelPath(id), level)
}

func (s *Store) Update(ctx context.Context, id string, level Definition) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.get(id)
	if err != nil || existing.Kind != "custom" {
		if err == nil {
			err = ErrNotFound
		}
		return Entry{}, err
	}
	return newEntry(id, "custom", level), jsonfile.Write(ctx, s.levelPath(id), level)
}
