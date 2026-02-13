package main

import (
	"github.com/sungur/ccbox/internal/cli"
	_ "github.com/sungur/ccbox/internal/bridge" // registers bridge runner via init()
)

func main() {
	cli.Execute()
}
