package main

import (
	"github.com/sungur/ccbox/internal/bridge"
	"github.com/sungur/ccbox/internal/cli"
)

func main() {
	// Register bridge mode runner. This connects the CLI package (which decides
	// whether to use bridge mode) with the bridge package (which implements it).
	// Done here rather than via init() to make the dependency explicit.
	cli.RegisterBridgeRunner(func(projectPath string, ccboxArgs []string) error {
		return bridge.RunBridgeMode(bridge.BridgeOptions{Path: projectPath, CcboxArgs: ccboxArgs})
	})

	cli.Execute()
}
