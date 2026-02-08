package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/sungur/ccbox/internal/log"
)

// Config file search paths (in order of precedence within each scope).
var projectConfigFiles = []string{"ccbox.yaml", "ccbox.yml", ".ccboxrc"}

// globalConfigPath returns the global config file path (~/.ccbox/config.yaml).
func globalConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".ccbox", "config.yaml")
}

// LoadConfig loads and merges ccbox configuration from global and project config files.
//
// Precedence (later overrides earlier):
//  1. Global config (~/.ccbox/config.yaml)
//  2. Project config (ccbox.yaml, ccbox.yml, .ccboxrc in projectPath)
//
// CLI flags should be applied on top of the returned config by the caller.
func LoadConfig(projectPath string) CcboxConfig {
	globalCfg := loadGlobalConfig()
	projectCfg := loadProjectConfig(projectPath)
	return mergeConfigs(globalCfg, projectCfg)
}

// loadProjectConfig finds and loads project-specific config.
func loadProjectConfig(projectPath string) *CcboxConfig {
	for _, filename := range projectConfigFiles {
		configPath := filepath.Join(projectPath, filename)
		cfg := loadConfigFile(configPath)
		if cfg != nil {
			log.Debugf("Loaded project config: %s", configPath)
			return cfg
		}
	}
	return nil
}

// loadGlobalConfig loads the global config file.
func loadGlobalConfig() *CcboxConfig {
	path := globalConfigPath()
	if path == "" {
		return nil
	}
	cfg := loadConfigFile(path)
	if cfg != nil {
		log.Debugf("Loaded global config: %s", path)
	}
	return cfg
}

// loadConfigFile reads and parses a single config file.
// Returns nil if the file does not exist or cannot be parsed.
func loadConfigFile(path string) *CcboxConfig {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	parsed := parseSimpleYaml(string(data))
	cfg := mapParsedToConfig(parsed)
	return cfg
}

// parseSimpleYaml parses basic YAML (key: value) without external dependencies.
// Supports a single level of nesting for the "env:" block.
func parseSimpleYaml(content string) map[string]any {
	result := make(map[string]any)
	lines := strings.Split(content, "\n")
	inEnvBlock := false
	envVars := make(map[string]string)

	envKeyRe := regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$`)
	kvRe := regexp.MustCompile(`^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$`)

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Skip comments and empty lines
		if strings.HasPrefix(trimmed, "#") || trimmed == "" {
			if inEnvBlock && trimmed == "" {
				continue // allow blank lines inside env block
			}
			continue
		}

		// Check for env block start
		if trimmed == "env:" {
			inEnvBlock = true
			continue
		}

		// Handle env block entries (indented with at least 2 spaces)
		if inEnvBlock && (strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t")) {
			match := envKeyRe.FindStringSubmatch(trimmed)
			if match != nil {
				key := match[1]
				value := stripQuotes(match[2])
				envVars[key] = value
			}
			continue
		} else if inEnvBlock {
			// End of env block (non-indented line)
			inEnvBlock = false
			if len(envVars) > 0 {
				result["env"] = envVars
				envVars = make(map[string]string)
			}
		}

		// Parse top-level key: value
		match := kvRe.FindStringSubmatch(trimmed)
		if match != nil {
			key := match[1]
			rawValue := strings.TrimSpace(match[2])
			cleanValue := stripQuotes(rawValue)

			switch {
			case cleanValue == "true":
				result[key] = true
			case cleanValue == "false":
				result[key] = false
			case isInteger(cleanValue):
				if v, err := strconv.Atoi(cleanValue); err == nil {
					result[key] = v
				}
			case isFloat(cleanValue):
				if v, err := strconv.ParseFloat(cleanValue, 64); err == nil {
					result[key] = v
				}
			case cleanValue != "":
				result[key] = cleanValue
			}
		}
	}

	// Handle env block at end of file
	if inEnvBlock && len(envVars) > 0 {
		result["env"] = envVars
	}

	return result
}

// mapParsedToConfig converts a parsed YAML map to a CcboxConfig struct.
func mapParsedToConfig(parsed map[string]any) *CcboxConfig {
	cfg := &CcboxConfig{}

	if v, ok := parsed["stack"].(string); ok {
		cfg.Stack = v
	}
	if v, ok := parsed["deps"].(string); ok {
		cfg.Deps = v
	}
	if v, ok := parsed["zeroResidue"].(bool); ok {
		cfg.ZeroResidue = v
	}
	if v, ok := parsed["networkPolicy"].(string); ok {
		cfg.NetworkPolicy = v
	}
	if v, ok := parsed["memory"].(string); ok {
		cfg.Memory = v
	}
	if v, ok := parsed["cpus"].(string); ok {
		cfg.CPUs = v
	}
	if v, ok := parsed["progress"].(string); ok {
		cfg.Progress = v
	}
	if v, ok := parsed["cache"].(bool); ok {
		cfg.Cache = &v
	}
	if v, ok := parsed["prune"].(bool); ok {
		cfg.Prune = &v
	}
	if v, ok := parsed["fresh"].(bool); ok {
		cfg.Fresh = v
	}
	if v, ok := parsed["headless"].(bool); ok {
		cfg.Headless = v
	}
	if v, ok := parsed["unrestricted"].(bool); ok {
		cfg.Unrestricted = v
	}
	if v, ok := parsed["debug"].(int); ok {
		cfg.Debug = v
	}
	if v, ok := parsed["env"].(map[string]string); ok {
		cfg.Env = v
	}

	return cfg
}

// mergeConfigs merges multiple configs with later values taking precedence.
// nil configs are skipped.
func mergeConfigs(configs ...*CcboxConfig) CcboxConfig {
	result := CcboxConfig{}

	for _, cfg := range configs {
		if cfg == nil {
			continue
		}

		if cfg.Stack != "" {
			result.Stack = cfg.Stack
		}
		if cfg.Deps != "" {
			result.Deps = cfg.Deps
		}
		if cfg.ZeroResidue {
			result.ZeroResidue = cfg.ZeroResidue
		}
		if cfg.NetworkPolicy != "" {
			result.NetworkPolicy = cfg.NetworkPolicy
		}
		if cfg.Memory != "" {
			result.Memory = cfg.Memory
		}
		if cfg.CPUs != "" {
			result.CPUs = cfg.CPUs
		}
		if cfg.Progress != "" {
			result.Progress = cfg.Progress
		}
		if cfg.Cache != nil {
			result.Cache = cfg.Cache
		}
		if cfg.Prune != nil {
			result.Prune = cfg.Prune
		}
		if cfg.Fresh {
			result.Fresh = cfg.Fresh
		}
		if cfg.Headless {
			result.Headless = cfg.Headless
		}
		if cfg.Unrestricted {
			result.Unrestricted = cfg.Unrestricted
		}
		if cfg.Debug > 0 {
			result.Debug = cfg.Debug
		}

		// Env vars: merge (later overrides same keys)
		if cfg.Env != nil {
			if result.Env == nil {
				result.Env = make(map[string]string)
			}
			for k, v := range cfg.Env {
				result.Env[k] = v
			}
		}
	}

	return result
}

// ConfigEnvToArray converts the Env map in a CcboxConfig to a slice
// of "KEY=VALUE" strings suitable for passing to Docker.
func ConfigEnvToArray(cfg CcboxConfig) []string {
	if cfg.Env == nil {
		return nil
	}
	result := make([]string, 0, len(cfg.Env))
	for k, v := range cfg.Env {
		result = append(result, fmt.Sprintf("%s=%s", k, v))
	}
	return result
}

// --- Helpers ---

// stripQuotes removes surrounding single or double quotes from a string.
func stripQuotes(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// isInteger checks if a string represents a valid integer.
func isInteger(s string) bool {
	if s == "" {
		return false
	}
	_, err := strconv.Atoi(s)
	return err == nil
}

// isFloat checks if a string represents a valid float (must contain a dot).
func isFloat(s string) bool {
	if s == "" || !strings.Contains(s, ".") {
		return false
	}
	_, err := strconv.ParseFloat(s, 64)
	return err == nil
}
