package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"text/template"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/yhlooo/vibe-walking/internal/version"
)

// VersionOptions version 子命令选项
type VersionOptions struct {
	// 输出格式
	// yaml 或 json
	OutputFormat string `json:"outputFormat,omitempty" yaml:"outputFormat,omitempty"`
}

// Validate 校验选项
func (opts *VersionOptions) Validate() error {
	switch opts.OutputFormat {
	case "", "json":
	default:
		return fmt.Errorf("invalid output format: %s", opts.OutputFormat)
	}
	return nil
}

// AddPFlags 将选项绑定到命令行
func (opts *VersionOptions) AddPFlags(fs *pflag.FlagSet) {
	fs.StringVarP(&opts.OutputFormat, "output-format", "f", opts.OutputFormat, "Output format. One of (json, yaml)")
}

// NewVersionOptions 创建默认的 version 子命令选项
func NewVersionOptions() VersionOptions {
	return VersionOptions{
		OutputFormat: "",
	}
}

// versionTemplate 定义 version 子命令默认的纯文本布局。
const versionTemplate = `Version:   {{ .Version }}
GitCommit: {{ .GitCommit }}
GoVersion: {{ .GoVersion }}
Arch:      {{ .Arch }}
OS:        {{ .OS }}
`

// newVersionCommand 创建 version 子命令
func newVersionCommand() *cobra.Command {
	opts := NewVersionOptions()

	cmd := &cobra.Command{
		Use:   "version",
		Short: "Print the version information",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := opts.Validate(); err != nil {
				return err
			}

			info := version.GetVersionInfo()

			// 选择机器可读的 JSON 或交互终端使用的文本模板。
			switch opts.OutputFormat {
			case "json":
				raw, err := json.Marshal(info)
				if err != nil {
					return err
				}
				fmt.Println(string(raw))
			default:
				tpl, err := template.New("Version").Parse(versionTemplate)
				if err != nil {
					return err
				}
				return tpl.Execute(os.Stdout, info)
			}

			return nil
		},
	}

	// 将选项绑定到命令行
	opts.AddPFlags(cmd.Flags())

	return cmd
}
