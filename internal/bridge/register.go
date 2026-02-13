package bridge

import "github.com/sungur/ccbox/internal/cli"

func init() {
	cli.RegisterBridgeRunner(func(projectPath string, ccboxArgs []string) error {
		return RunBridgeMode(BridgeOptions{Path: projectPath, CcboxArgs: ccboxArgs})
	})
}
