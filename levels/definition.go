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

type Point struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// Definition is the JSON format shared by shipped, editable and exported maps.
type Definition struct {
	SchemaVersion int      `json:"schemaVersion"`
	Name          string   `json:"name"`
	Tiles         []string `json:"tiles"`
	Spawn         Point    `json:"spawn"`
	Gravity       float64  `json:"gravity"`
	Inertia       float64  `json:"inertia"`
	SystemPrompt  *string  `json:"systemPrompt,omitempty"`
}

type definitionJSON struct {
	Definition
	Spawn *struct {
		X *int `json:"x"`
		Y *int `json:"y"`
	} `json:"spawn"`
	Gravity json.RawMessage `json:"gravity"`
	Inertia json.RawMessage `json:"inertia"`
	Prompt  json.RawMessage `json:"systemPrompt"`
}

// Decode validates the map structure. An unfinished draft may lack a supported button.
func Decode(data []byte) (Definition, error) {
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
	if body.Spawn == nil || body.Spawn.X == nil || body.Spawn.Y == nil {
		return Definition{}, errors.New("请填写出生点坐标")
	}
	level.Spawn = Point{X: *body.Spawn.X, Y: *body.Spawn.Y}
	rows := len(level.Tiles)
	columns, supported := map[int]int{9: 16, 10: 15, 20: 30, 32: 48}[rows]
	if !supported {
		return Definition{}, errors.New("地图尺寸无效")
	}
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
	x, y := level.Spawn.X, level.Spawn.Y
	if x < 0 || x >= columns || y < 0 || y >= rows || level.Tiles[y][x] != '.' {
		return Definition{}, errors.New("出生点必须落在地图的空格中")
	}
	level.Gravity, level.Inertia = 1, 0.5
	if err := readField(body.Gravity, &level.Gravity); err != nil || level.Gravity < -10 || level.Gravity > 10 {
		return Definition{}, errors.New("重力必须在 -10 到 10 之间")
	}
	if err := readField(body.Inertia, &level.Inertia); err != nil || level.Inertia < 0 || level.Inertia > 10 {
		return Definition{}, errors.New("惯性必须在 0 到 10 之间")
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

func textLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func readField(raw json.RawMessage, into any) error {
	if raw == nil {
		return nil
	}
	if string(raw) == "null" {
		return errors.New("unexpected null")
	}
	return json.Unmarshal(raw, into)
}

func (d Definition) Playable() bool {
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
