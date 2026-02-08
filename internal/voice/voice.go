// Package voice provides audio recording and speech-to-text transcription
// using platform audio tools and whisper.cpp.
package voice

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Options configures voice recording and transcription.
type Options struct {
	Model    string // Whisper model name (e.g., "base.en", "small", "medium")
	Duration int    // Recording duration in seconds
}

// Pipeline runs the full voice-to-text pipeline: record audio, transcribe, return text.
func Pipeline(opts Options) (string, error) {
	if opts.Duration <= 0 {
		opts.Duration = 10
	}
	if opts.Model == "" {
		opts.Model = "base.en"
	}

	if err := checkDependencies(); err != nil {
		return "", err
	}

	audioPath, err := Record(opts.Duration)
	if err != nil {
		return "", fmt.Errorf("recording failed: %w", err)
	}
	defer os.Remove(audioPath)

	text, err := Transcribe(audioPath, opts.Model)
	if err != nil {
		return "", fmt.Errorf("transcription failed: %w", err)
	}

	return strings.TrimSpace(text), nil
}

// Record captures audio from the default microphone for the given duration in seconds.
// Returns the path to the recorded WAV file (16kHz, mono, 16-bit PCM).
func Record(duration int) (string, error) {
	audioFile := filepath.Join(os.TempDir(), fmt.Sprintf("ccbox-voice-%d.wav", time.Now().UnixMilli()))
	durStr := fmt.Sprintf("%d", duration)

	var cmd *exec.Cmd

	switch {
	case commandExists("ffmpeg"):
		cmd = exec.Command("ffmpeg",
			"-y",                    // overwrite output
			"-f", inputFormat(),     // platform-specific input format
			"-i", inputDevice(),     // platform-specific input device
			"-t", durStr,            // duration
			"-ar", "16000",          // 16kHz (whisper requirement)
			"-ac", "1",              // mono
			"-c:a", "pcm_s16le",    // 16-bit PCM
			audioFile,
		)
	case runtime.GOOS == "linux" && commandExists("arecord"):
		cmd = exec.Command("arecord",
			"-f", "S16_LE",
			"-r", "16000",
			"-c", "1",
			"-d", durStr,
			audioFile,
		)
	case commandExists("rec"):
		cmd = exec.Command("rec",
			"-r", "16000",
			"-c", "1",
			"-b", "16",
			audioFile,
			"trim", "0", durStr,
		)
	default:
		return "", fmt.Errorf("no audio recording tool found (install ffmpeg, arecord, or sox)")
	}

	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		os.Remove(audioFile)
		return "", fmt.Errorf("recording command failed: %w", err)
	}

	info, err := os.Stat(audioFile)
	if err != nil || info.Size() == 0 {
		os.Remove(audioFile)
		return "", fmt.Errorf("recording produced no audio data")
	}

	return audioFile, nil
}

// Transcribe runs whisper.cpp on an audio file and returns the transcribed text.
// The model parameter is a whisper model name (e.g., "base.en") which is resolved
// to a file path automatically.
func Transcribe(audioPath, model string) (string, error) {
	modelPath := resolveModelPath(model)

	var cmd *exec.Cmd
	var stdout bytes.Buffer

	switch {
	case commandExists("whisper-cli"):
		cmd = exec.Command("whisper-cli",
			"-m", modelPath,
			"-f", audioPath,
			"--no-timestamps",
		)
	case commandExists("whisper"):
		cmd = exec.Command("whisper",
			"-m", modelPath,
			"-f", audioPath,
			"--no-timestamps",
		)
	default:
		return "", fmt.Errorf("whisper.cpp not found (install whisper-cli from https://github.com/ggerganov/whisper.cpp)")
	}

	cmd.Stdout = &stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("whisper transcription failed: %w", err)
	}

	return stdout.String(), nil
}

// checkDependencies verifies that required external tools are available.
func checkDependencies() error {
	hasRecorder := commandExists("ffmpeg") ||
		(runtime.GOOS == "linux" && commandExists("arecord")) ||
		commandExists("rec")
	if !hasRecorder {
		return fmt.Errorf("no audio recording tool found\nInstall one of: ffmpeg (recommended), arecord (Linux/ALSA), or sox (rec)")
	}

	hasWhisper := commandExists("whisper-cli") || commandExists("whisper")
	if !hasWhisper {
		return fmt.Errorf("whisper.cpp not found\nInstall from: https://github.com/ggerganov/whisper.cpp")
	}

	return nil
}

// resolveModelPath finds the whisper model file on disk.
// Checks common installation locations and returns the first match,
// or the default cache path if none found (whisper-cli will report its own error).
func resolveModelPath(model string) string {
	home := homeDir()
	candidates := []string{
		filepath.Join(home, ".cache", "whisper", "ggml-"+model+".bin"),
		filepath.Join(home, ".local", "share", "whisper", "ggml-"+model+".bin"),
		filepath.Join("models", "ggml-"+model+".bin"),
		model, // allow direct path
	}

	for _, path := range candidates {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}

	// Return default location; whisper-cli will give a clear error if missing.
	return filepath.Join(home, ".cache", "whisper", "ggml-"+model+".bin")
}

// inputFormat returns the ffmpeg input format flag for the current platform.
func inputFormat() string {
	switch runtime.GOOS {
	case "darwin":
		return "avfoundation"
	case "linux":
		return "pulse"
	case "windows":
		return "dshow"
	default:
		return "pulse"
	}
}

// inputDevice returns the ffmpeg input device identifier for the current platform.
func inputDevice() string {
	switch runtime.GOOS {
	case "darwin":
		return ":0" // default audio input
	case "linux":
		return "default"
	case "windows":
		return "audio=Microphone"
	default:
		return "default"
	}
}

// commandExists checks whether a command is available in the system PATH.
func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// homeDir returns the user's home directory, or "." as fallback.
func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}
