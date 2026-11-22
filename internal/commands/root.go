package commands

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bombsimon/logrusr/v4"
	"github.com/go-logr/logr"
	"github.com/sirupsen/logrus"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/yhlooo/vibe-walking/internal/server"
	"github.com/yhlooo/vibe-walking/internal/version"
)

// NewGlobalOptions 创建默认 GlobalOptions
func NewGlobalOptions() GlobalOptions {
	return GlobalOptions{
		Verbosity: 0,
	}
}

// GlobalOptions 全局选项
type GlobalOptions struct {
	// 日志数量级别（ 0 / 1 / 2 ）
	Verbosity uint32
}

// Validate 校验选项是否合法
func (o *GlobalOptions) Validate() error {
	if o.Verbosity > 2 {
		return fmt.Errorf("invalid log verbosity: %d (expected: 0, 1 or 2)", o.Verbosity)
	}
	return nil
}

// AddPFlags 将选项绑定到命令行参数
func (o *GlobalOptions) AddPFlags(fs *pflag.FlagSet) {
	fs.Uint32VarP(&o.Verbosity, "verbose", "v", o.Verbosity, "Number for the log level verbosity (0, 1, or 2)")
}

type globalOptsContextKey struct{}

// ContextWithGlobalOptions 创建带全局选项的 context.Context
func ContextWithGlobalOptions(parent context.Context, opts GlobalOptions) context.Context {
	return context.WithValue(parent, globalOptsContextKey{}, opts)
}

// GlobalOptionsFromContext 从 ctx 获取全局选项
func GlobalOptionsFromContext(ctx context.Context) GlobalOptions {
	opts, _ := ctx.Value(globalOptsContextKey{}).(GlobalOptions)
	return opts
}

// NewOptions 创建默认 Options
func NewOptions() Options {
	return Options{Listen: "127.0.0.1:2333", OpenBrowser: true}
}

// Options 运行选项
type Options struct {
	Listen      string
	OpenBrowser bool
	DataDir     string
}

// AddPFlags 将选项绑定到命令行参数
func (o *Options) AddPFlags(fs *pflag.FlagSet) {
	fs.StringVarP(&o.Listen, "listen", "l", o.Listen, "HTTP listen address")
	fs.BoolVar(&o.OpenBrowser, "open-browser", o.OpenBrowser, "Open the game in a browser after startup")
	fs.StringVarP(&o.DataDir, "data-dir", "d", o.DataDir, "Local data directory (defaults to ~/.vibewalking)")
}

// NewCommand 创建根命令
func NewCommand(name string) *cobra.Command {
	globalOpts := NewGlobalOptions()
	opts := NewOptions()

	cmd := &cobra.Command{
		Use:           name,
		Short:         "Vibe Walking",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       version.Version,
		Args:          cobra.NoArgs,

		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

			if err := globalOpts.Validate(); err != nil {
				return err
			}
			ctx = ContextWithGlobalOptions(ctx, globalOpts)

			// 初始化 logger
			logrusLogger := logrus.New()
			switch globalOpts.Verbosity {
			case 0:
				logrusLogger.Level = logrus.InfoLevel
			case 1:
				logrusLogger.Level = logrus.DebugLevel
			default:
				logrusLogger.Level = logrus.TraceLevel
			}
			logger := logrusr.New(logrusLogger)
			ctx = logr.NewContext(ctx, logger)

			cmd.SetContext(ctx)

			return nil
		},

		RunE: func(cmd *cobra.Command, args []string) error {
			dataDir := opts.DataDir
			if dataDir == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return fmt.Errorf("find default data directory: %w", err)
				}
				dataDir = filepath.Join(home, ".vibewalking")
			}
			ctx := cmd.Context()
			return server.Serve(ctx, opts.Listen, dataDir, func(address string) {
				fmt.Fprintln(cmd.OutOrStdout(), address)
				if opts.OpenBrowser {
					go func() {
						if err := openBrowser(ctx, address); err != nil && ctx.Err() == nil {
							logr.FromContextOrDiscard(ctx).Error(err, "open the browser manually", "url", address)
						}
					}()
				}
			})
		},

		PersistentPostRunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}

	globalOpts.AddPFlags(cmd.PersistentFlags())
	opts.AddPFlags(cmd.Flags())

	cmd.AddCommand(
		newVersionCommand(),
	)

	return cmd
}
