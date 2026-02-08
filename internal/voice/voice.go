// Package voice provides audio recording and speech-to-text transcription
// using platform audio tools and whisper.cpp.
package voice

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
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

	// Ensure whisper model is downloaded before recording
	if _, err := EnsureModel(opts.Model); err != nil {
		return "", fmt.Errorf("model download failed: %w", err)
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

// EnsureModel checks if the whisper model exists, downloading it if missing.
// Returns the path to the model file.
func EnsureModel(model string) (string, error) {
	modelPath := resolveModelPath(model)
	if _, err := os.Stat(modelPath); err == nil {
		return modelPath, nil
	}

	// Model not found, download it
	url := fmt.Sprintf("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-%s.bin", model)

	// Ensure cache directory exists
	cacheDir := filepath.Dir(modelPath)
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return "", fmt.Errorf("create cache dir: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Downloading whisper model %q...\n", model)

	resp, err := http.Get(url) //nolint:gosec // URL is constructed from known safe base
	if err != nil {
		return "", fmt.Errorf("download model: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download model: HTTP %d", resp.StatusCode)
	}

	tmpPath := modelPath + ".tmp"
	f, err := os.Create(tmpPath)
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}

	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("download model: %w", err)
	}
	f.Close()

	// Atomic rename
	if err := os.Rename(tmpPath, modelPath); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("install model: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Model %q downloaded to %s\n", model, modelPath)
	return modelPath, nil
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
		if commandExists("pactl") {
			return "pulse"
		}
		return "alsa"
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
		// Allow override via environment variable for non-standard audio devices
		if dev := os.Getenv("CCBOX_AUDIO_DEVICE"); dev != "" {
			return "audio=" + dev
		}
		return "audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave:{0.0.0.00000000}.{default}"
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
