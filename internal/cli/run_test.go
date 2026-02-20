package cli

import (
	"testing"
)

func TestValidateEnvVar(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"valid simple", "FOO=bar", false},
		{"valid with underscore", "MY_VAR=hello", false},
		{"valid empty value", "FOO=", false},
		{"valid with equals in value", "FOO=a=b", false},
		{"invalid no equals", "FOOBAR", true},
		{"invalid starts with number", "1FOO=bar", true},
		{"invalid empty key", "=bar", true},
		{"invalid special chars in key", "FOO-BAR=baz", true},
		{"invalid empty string", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEnvVar(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateEnvVar(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
		})
	}
}

func TestBoolPtrDefault(t *testing.T) {
	trueVal := true
	falseVal := false

	tests := []struct {
		name       string
		ptr        *bool
		defaultVal bool
		want       bool
	}{
		{"nil with true default", nil, true, true},
		{"nil with false default", nil, false, false},
		{"true ptr ignores default", &trueVal, false, true},
		{"false ptr ignores default", &falseVal, true, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := boolPtrDefault(tt.ptr, tt.defaultVal)
			if got != tt.want {
				t.Errorf("boolPtrDefault() = %v, want %v", got, tt.want)
			}
		})
	}
}

