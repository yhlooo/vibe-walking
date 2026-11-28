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

// MaxDefinitionBytes 限制单个关卡定义的大小。
const MaxDefinitionBytes = 64 << 10

var (
	// ErrNotFound 表示目录中没有指定关卡。
	ErrNotFound = errors.New("关卡不存在")
	// ErrInvalidOrder 表示排序提交与当前自建关卡集合不一致。
	ErrInvalidOrder = errors.New("关卡顺序必须包含每个当前自定义关卡 ID，且每个 ID 只能出现一次。若关卡列表已变化，请刷新页面后重试")
	// fileID 限制可以作为关卡文件名的 ID。
	fileID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
)

// Entry 将关卡定义、来源和物理修订号组合为目录条目。
type Entry struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	Description string     `json:"description,omitempty"`
	Level       Definition `json:"level"`
	// 物理规则的摘要，用于判断成绩是否基于当前定义。
	Revision string `json:"revision"`
}

// Catalog 由可读取的关卡与扫描期间的警告组成。
type Catalog struct {
	Levels   []Entry  `json:"levels"`
	Warnings []string `json:"warnings,omitempty"`
}

// Store 管理内置关卡、自建关卡及本地游玩进度。
type Store struct {
	dir      string
	builtIns []Entry
	// 串行处理关卡定义、顺序和进度的读写。
	mu sync.Mutex
}

// NewStore 加载嵌入的关卡目录，并指定存放本地数据的目录。
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

	// 内置 ID 必须唯一，并为自建关卡保留 custom- 前缀。
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

		// 同时校验元数据名称和可玩性，确保内置关卡能直接开始。
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

// newEntry 从关卡的物理参数计算关卡修订号。
func newEntry(id, kind string, level Definition) Entry {
	// 名称、提示词和读屏选项与物理修订号无关。
	board := level
	board.Name, board.SystemPrompt = "", nil
	board.DisableReadScreen = false
	raw, _ := json.Marshal(board)
	sum := sha256.Sum256(raw)
	return Entry{ID: id, Kind: kind, Level: level, Revision: hex.EncodeToString(sum[:])}
}

// List 在锁保护下生成关卡目录。
func (s *Store) List() (Catalog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list()
}

// list 按内置目录和本地顺序汇总关卡，收集损坏文件的警告。
func (s *Store) list() (Catalog, error) {
	catalog := Catalog{Levels: append([]Entry(nil), s.builtIns...)}
	files, err := os.ReadDir(filepath.Join(s.dir, "levels"))
	if errors.Is(err, os.ErrNotExist) {
		return catalog, nil
	}
	if err != nil {
		return Catalog{}, err
	}

	// 收集有效的自建关卡，逐项报告与内置关卡冲突或无法读取的文件。
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

	// 优先按已存顺序添加，再附上排序文件中尚未记录的关卡。
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

// orderPath 返回自建关卡排序文件的路径。
func (s *Store) orderPath() string {
	return filepath.Join(s.dir, "level-order.json")
}

// readOrder 从本地文件读取自建关卡顺序。
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

// SetOrder 校验客户端提交的自建关卡 ID 并保存顺序。
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

	// 逐个消耗当前 ID，重复项和来自旧目录的 ID 都会被拒绝。
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

// get 按 ID 读取内置关卡或自建关卡。
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

// Get 在锁保护下按 ID 读取关卡。
func (s *Store) Get(id string) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.get(id)
}

// levelPath 返回自建关卡定义在磁盘上的路径。
func (s *Store) levelPath(id string) string {
	return filepath.Join(s.dir, "levels", id+".json")
}

// readCustom 从磁盘解析一个自建关卡定义。
func (s *Store) readCustom(id string) (Entry, error) {
	// 先检查文件本身的类型与大小，符号链接会被拒绝。
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

// Create 创建关卡草稿或迁移旧版浏览器草稿。
func (s *Store) Create(ctx context.Context, legacy *Definition) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	level := newDefinition()
	id := "custom-" + rand.Text()
	if legacy != nil {
		// 用固定 ID 迁移浏览器草稿，重试时复用已经迁移的关卡。
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

// Update 替换现有自建关卡的定义。
func (s *Store) Update(ctx context.Context, id string, level Definition) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 先查明目标的来源，写入仅允许更新已经存在的自建关卡。
	existing, err := s.get(id)
	if err != nil || existing.Kind != "custom" {
		if err == nil {
			err = ErrNotFound
		}
		return Entry{}, err
	}
	return newEntry(id, "custom", level), jsonfile.Write(ctx, s.levelPath(id), level)
}
