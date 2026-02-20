package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/sungur/ccbox/internal/log"
	"gopkg.in/yaml.v3"
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

// loadConfigFile reads and parses a single config file using yaml.v3.
// Returns nil if the file does not exist or cannot be parsed.
func loadConfigFile(path string) *CcboxConfig {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var cfg CcboxConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		log.Debugf("Failed to parse config %s: %v", path, err)
		return nil
	}
	return &cfg
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
		if cfg.ZeroResidue != nil {
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
		if cfg.Fresh != nil {
			result.Fresh = cfg.Fresh
		}
		if cfg.Headless != nil {
			result.Headless = cfg.Headless
		}
		if cfg.Unrestricted != nil {
			result.Unrestricted = cfg.Unrestricted
		}
		if cfg.ReadOnly != nil {
			result.ReadOnly = cfg.ReadOnly
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
