// Package levels manages the game's built-in and user-authored maps.
package levels

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

// Point 是以网格左上角为原点的格子坐标。
type Point struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// Definition is the JSON format shared by shipped, editable and exported maps.
type Definition struct {
	// 关卡 JSON 格式版本。
	SchemaVersion int    `json:"schemaVersion"`
	Name          string `json:"name"`
	// 从上到下排列的地图行，每个字符代表一格。
	Tiles []string `json:"tiles"`
	// 玩家出生格。
	Spawn Point `json:"spawn"`
	// 带符号的重力强度。
	Gravity float64 `json:"gravity"`
	// 满速松开方向键后的滑行距离。
	Inertia float64 `json:"inertia"`
	// 关卡是否禁用模型查看实景。
	DisableReadScreen bool `json:"disableReadScreen,omitempty"`
	// 关卡提示词覆盖值，缺省时使用应用内置提示词。
	SystemPrompt *string `json:"systemPrompt,omitempty"`
}

// definitionJSON 保留解码阶段的字段缺省信息和原始 JSON 值。
type definitionJSON struct {
	Definition
	Spawn *struct {
		X *int `json:"x"`
		Y *int `json:"y"`
	} `json:"spawn"`
	Gravity           json.RawMessage `json:"gravity"`
	Inertia           json.RawMessage `json:"inertia"`
	DisableReadScreen json.RawMessage `json:"disableReadScreen"`
	Prompt            json.RawMessage `json:"systemPrompt"`
}

// Decode validates the map structure. An unfinished draft may lack a supported button.
func Decode(data []byte) (Definition, error) {
	// 严格读取一个 JSON 对象，并拒绝格式之外的字段。
	var body definitionJSON
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if !json.Valid(data) || decoder.Decode(&body) != nil {
		return Definition{}, errors.New("关卡 JSON 格式无效")
	}

	level := body.Definition
	level.Name = strings.TrimSpace(level.Name)
	if level.SchemaVersion != 1 || level.Name == "" || textLength(level.Name) > 80 {
		return Definition{}, errors.New("关卡需要版本 1 和有效名称（最多 80 字符）")
	}

	// 用指针区分缺失的坐标与坐标值 0。
	if body.Spawn == nil || body.Spawn.X == nil || body.Spawn.Y == nil {
		return Definition{}, errors.New("请填写出生点坐标")
	}
	level.Spawn = Point{X: *body.Spawn.X, Y: *body.Spawn.Y}

	// 允许旧版 9 × 16 地图，其余按当前尺寸预设校验。
	rows := len(level.Tiles)
	columns, supported := map[int]int{9: 16, 10: 15, 20: 30, 32: 48}[rows]
	if !supported {
		return Definition{}, errors.New("地图尺寸无效")
	}

	// 逐行检查宽度和格子标记，草稿允许暂时没有按钮。
	buttons := 0
	for y, row := range level.Tiles {
		if len(row) != columns || strings.Trim(row, ".#B") != "" {
			return Definition{}, fmt.Errorf("地图第 %d 行须为 %d 个 .、# 或 B", y+1, columns)
		}
		buttons += strings.Count(row, "B")
	}
	if buttons > 1 {
		return Definition{}, errors.New("地图只能放置一个红色按钮")
	}

	// 确认出生点在网格内，并且落在空格上。
	x, y := level.Spawn.X, level.Spawn.Y
	if x < 0 || x >= columns || y < 0 || y >= rows || level.Tiles[y][x] != '.' {
		return Definition{}, errors.New("出生点必须落在地图的空格中")
	}

	// 物理字段缺省时沿用默认值，显式传入的 0 仍是有效设置。
	level.Gravity, level.Inertia = 1, 0.5
	if err := readField(body.Gravity, &level.Gravity); err != nil || level.Gravity < -10 || level.Gravity > 10 {
		return Definition{}, errors.New("重力必须在 -10 到 10 之间")
	}
	if err := readField(body.Inertia, &level.Inertia); err != nil || level.Inertia < 0 || level.Inertia > 10 {
		return Definition{}, errors.New("惯性必须在 0 到 10 之间")
	}

	if err := readField(body.DisableReadScreen, &level.DisableReadScreen); err != nil {
		return Definition{}, errors.New("disableReadScreen 必须为布尔值")
	}
	if body.Prompt != nil {
		var prompt string
		if err := readField(body.Prompt, &prompt); err != nil || textLength(prompt) > 4096 {
			return Definition{}, errors.New("系统提示词最多 4096 个字符")
		}
		level.SystemPrompt = &prompt
	}
	return level, nil
}

// textLength 返回字符串的 UTF-16 代码单元数，与前端长度校验一致。
func textLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// readField 在字段存在时解码，并拒绝显式的 JSON null。
func readField(raw json.RawMessage, into any) error {
	if raw == nil {
		return nil
	}
	if string(raw) == "null" {
		return errors.New("unexpected null")
	}
	return json.Unmarshal(raw, into)
}

// Playable 检查关卡的按钮是否存在并满足支撑条件。
func (d Definition) Playable() bool {
	// 普通和零重力检查按钮下方，反重力检查按钮上方。
	gravity := 1
	if d.Gravity < 0 {
		gravity = -1
	}
	for y, row := range d.Tiles {
		if x := strings.IndexByte(row, 'B'); x >= 0 {
			support := y + gravity
			return support >= 0 && support < len(d.Tiles) && d.Tiles[support][x] == '#'
		}
	}
	return false
}

// newDefinition 为新建关卡提供初始草稿。
func newDefinition() Definition {
	return Definition{
		SchemaVersion: 1, Name: "未命名关卡", Gravity: 1, Inertia: 0.5, Spawn: Point{X: 2, Y: 8},
		Tiles: []string{
			"...............", "...............", "...............", "...............",
			"...............", "...............", "...............", "...............",
			"............B..", "###############",
		},
	}
}
