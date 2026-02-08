package config

import (
	"fmt"
	"strings"
)

// LanguageStack represents a supported language stack for Docker images.
type LanguageStack string

const (
	// Core Language Stacks
	StackBase   LanguageStack = "base"
	StackPython LanguageStack = "python"
	StackWeb    LanguageStack = "web"
	StackGo     LanguageStack = "go"
	StackRust   LanguageStack = "rust"
	StackJava   LanguageStack = "java"
	StackCpp    LanguageStack = "cpp"
	StackDotnet LanguageStack = "dotnet"
	StackSwift  LanguageStack = "swift"
	StackDart   LanguageStack = "dart"
	StackLua    LanguageStack = "lua"

	// Combined Language Stacks
	StackJVM        LanguageStack = "jvm"
	StackFunctional LanguageStack = "functional"
	StackScripting  LanguageStack = "scripting"
	StackSystems    LanguageStack = "systems"

	// Use-Case Stacks
	StackData      LanguageStack = "data"
	StackAI        LanguageStack = "ai"
	StackMobile    LanguageStack = "mobile"
	StackGame      LanguageStack = "game"
	StackFullstack LanguageStack = "fullstack"
)

// allStacks is the ordered list of all stack values.
var allStacks = []LanguageStack{
	StackBase, StackPython, StackWeb, StackGo, StackRust, StackJava,
	StackCpp, StackDotnet, StackSwift, StackDart, StackLua,
	StackJVM, StackFunctional, StackScripting, StackSystems,
	StackData, StackAI, StackMobile, StackGame, StackFullstack,
}

// StackInfo holds metadata about a language stack.
type StackInfo struct {
	Description string
	SizeMB      int
}

// StackInfoMap maps each stack to its description and estimated image size.
var StackInfoMap = map[LanguageStack]StackInfo{
	StackBase:       {Description: "Claude Code only (vanilla)", SizeMB: 215},
	StackPython:     {Description: "Python + uv + ruff + pytest + mypy", SizeMB: 350},
	StackWeb:        {Description: "Node.js + Bun + TypeScript + pnpm + eslint + prettier + vitest", SizeMB: 400},
	StackGo:         {Description: "Go + golangci-lint", SizeMB: 550},
	StackRust:       {Description: "Rust + clippy + rustfmt", SizeMB: 700},
	StackJava:       {Description: "JDK + Maven", SizeMB: 600},
	StackCpp:        {Description: "C++ + CMake + Clang + Conan", SizeMB: 450},
	StackDotnet:     {Description: ".NET SDK + C# + F#", SizeMB: 500},
	StackSwift:      {Description: "Swift", SizeMB: 500},
	StackDart:       {Description: "Dart SDK", SizeMB: 300},
	StackLua:        {Description: "Lua + LuaRocks", SizeMB: 250},
	StackJVM:        {Description: "Java + Scala + Clojure + Kotlin", SizeMB: 900},
	StackFunctional: {Description: "Haskell + OCaml + Elixir/Erlang", SizeMB: 900},
	StackScripting:  {Description: "Ruby + PHP + Perl (web backends)", SizeMB: 450},
	StackSystems:    {Description: "C++ + Zig + Nim (low-level)", SizeMB: 550},
	StackData:       {Description: "Python + R + Julia (data science)", SizeMB: 800},
	StackAI:         {Description: "Python + Jupyter + PyTorch + TensorFlow", SizeMB: 2500},
	StackMobile:     {Description: "Dart + Flutter SDK + Android tools", SizeMB: 1500},
	StackGame:       {Description: "C++ + SDL2 + Lua + OpenGL", SizeMB: 600},
	StackFullstack:  {Description: "Node.js + Python + PostgreSQL client", SizeMB: 700},
}

// StackDependencies maps each stack to its parent dependency.
// An empty string means the stack uses an external base image (e.g., golang:latest).
var StackDependencies = map[LanguageStack]LanguageStack{
	StackBase:       "",
	StackPython:     StackBase,
	StackWeb:        StackBase,
	StackGo:         "",
	StackRust:       "",
	StackJava:       "",
	StackCpp:        StackBase,
	StackDotnet:     StackBase,
	StackSwift:      StackBase,
	StackDart:       StackBase,
	StackLua:        StackBase,
	StackJVM:        StackJava,
	StackFunctional: StackBase,
	StackScripting:  StackBase,
	StackSystems:    StackCpp,
	StackData:       StackPython,
	StackAI:         StackPython,
	StackMobile:     StackDart,
	StackGame:       StackCpp,
	StackFullstack:  StackWeb,
}

// stackCategories groups stacks by category for filtering.
var stackCategories = map[string][]LanguageStack{
	"core": {
		StackBase, StackPython, StackWeb, StackGo, StackRust, StackJava,
		StackCpp, StackDotnet, StackSwift, StackDart, StackLua,
	},
	"combined": {
		StackJVM, StackFunctional, StackScripting, StackSystems,
	},
	"usecase": {
		StackData, StackAI, StackMobile, StackGame, StackFullstack,
	},
}

// ParseStack parses a string into a LanguageStack.
// Returns the stack and true if valid, or empty string and false if not.
func ParseStack(value string) (LanguageStack, bool) {
	normalized := strings.ToLower(value)
	for _, s := range allStacks {
		if string(s) == normalized {
			return s, true
		}
	}
	return "", false
}

// CreateStack validates and creates a LanguageStack from string input.
// Returns an error if the stack name is invalid.
func CreateStack(value string) (LanguageStack, error) {
	stack, ok := ParseStack(value)
	if !ok {
		return "", fmt.Errorf("invalid stack %q; valid options: %s", value, strings.Join(GetStackValues(), ", "))
	}
	return stack, nil
}

// GetStackValues returns all stack values as a string slice (for CLI choices).
func GetStackValues() []string {
	result := make([]string, len(allStacks))
	for i, s := range allStacks {
		result[i] = string(s)
	}
	return result
}

// FilterStacks returns stacks matching a category name or search term.
// Searches both stack names and descriptions.
func FilterStacks(filter string) []LanguageStack {
	normalized := strings.ToLower(filter)

	// Check categories first
	if category, ok := stackCategories[normalized]; ok {
		return category
	}

	// Search by name and description
	var results []LanguageStack
	for _, stack := range allStacks {
		if strings.Contains(string(stack), normalized) {
			results = append(results, stack)
			continue
		}
		if info, ok := StackInfoMap[stack]; ok {
			if strings.Contains(strings.ToLower(info.Description), normalized) {
				results = append(results, stack)
			}
		}
	}
	return results
}
