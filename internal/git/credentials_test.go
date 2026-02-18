package git

import (
	"testing"
)

func TestSanitizeEnvValue(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"normal text", "hello world", "hello world"},
		{"newline", "hello\nworld", "hello world"},
		{"carriage return", "hello\rworld", "hello world"},
		{"null byte", "hello\x00world", "helloworld"},
		{"leading/trailing spaces", "  hello  ", "hello"},
		{"combination", " hello\r\nworld\x00 ", "hello  world"},
		{"empty", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeEnvValue(tt.input)
			if got != tt.want {
				t.Errorf("sanitizeEnvValue(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
