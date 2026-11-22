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
	ErrNotFound = errors.New("关卡不存在")
	fileID      = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
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
	// Renaming a level or updating its prompt does not invalidate its physical checkpoint.
	board := level
	board.Name, board.SystemPrompt = "", nil
	raw, _ := json.Marshal(board)
	sum := sha256.Sum256(raw)
	return Entry{ID: id, Kind: kind, Level: level, Revision: hex.EncodeToString(sum[:])}
}

func (s *Store) List() (Catalog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	catalog := Catalog{Levels: append([]Entry(nil), s.builtIns...)}
	files, err := os.ReadDir(filepath.Join(s.dir, "levels"))
	if errors.Is(err, os.ErrNotExist) {
		return catalog, nil
	}
	if err != nil {
		return Catalog{}, err
	}
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
		catalog.Levels = append(catalog.Levels, entry)
	}
	return catalog, nil
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
