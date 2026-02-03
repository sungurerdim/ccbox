/**
 * Voice-to-text support for ccbox.
 *
 * Provides push-to-talk voice input using whisper.cpp for speech-to-text.
 * Transcribed text is sent to Claude Code via docker exec or -p flag.
 *
 * Dependency direction:
 *   This module imports from: platform.ts, exec.ts, logger.ts
 *   It should NOT import from: cli, generator, docker-runtime
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { exec } from "./exec.js";
import { log } from "./logger.js";
import { detectHostPlatform, commandExists } from "./platform.js";
import { getCcboxTempVoice } from "./constants.js";
import { findRunningContainer } from "./docker-utils.js";
import { getDockerEnv } from "./paths.js";

/** Whisper model sizes with download URLs. */
const WHISPER_MODELS: Record<string, { size: string; url: string }> = {
  base: {
    size: "142MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  },
  small: {
    size: "466MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  },
  tiny: {
    size: "75MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  },
};

/**
 * Get the whisper model directory.
 */
function getModelDir(): string {
  return join(homedir(), ".ccbox", "models");
}

/**
 * Get path to whisper model file.
 */
function getModelPath(model = "base"): string {
  return join(getModelDir(), `ggml-${model}.bin`);
}

/**
 * Check if whisper.cpp is available on the host.
 */
export function isWhisperAvailable(): boolean {
  return commandExists("whisper-cpp") || commandExists("whisper") || commandExists("main");
}

/**
 * Get the whisper command name.
 */
function getWhisperCommand(): string | null {
  if (commandExists("whisper-cpp")) { return "whisper-cpp"; }
  if (commandExists("whisper")) { return "whisper"; }
  if (commandExists("main")) { return "main"; }
  return null;
}

/**
 * Download whisper model if not present.
 *
 * @param model - Model name (tiny, base, small).
 * @returns True if model is available.
 */
export async function ensureModel(model = "base"): Promise<boolean> {
  const modelPath = getModelPath(model);
  if (existsSync(modelPath)) {
    return true;
  }

  const modelInfo = WHISPER_MODELS[model];
  if (!modelInfo) {
    log.error(`Unknown whisper model: ${model}. Available: ${Object.keys(WHISPER_MODELS).join(", ")}`);
    return false;
  }

  log.dim(`Downloading whisper ${model} model (${modelInfo.size})...`);
  const modelDir = getModelDir();
  mkdirSync(modelDir, { recursive: true });

  try {
    const result = await exec("curl", [
      "-L", "-o", modelPath, modelInfo.url,
    ], { timeout: 300_000 }); // 5 min for download

    if (result.exitCode === 0 && existsSync(modelPath)) {
      log.success(`Model downloaded: ${model}`);
      return true;
    }
  } catch (e) {
    log.error(`Model download failed: ${String(e)}`);
  }

  return false;
}

/**
 * Record audio from microphone.
 *
 * Uses platform-specific tools for recording.
 *
 * @param durationSec - Maximum recording duration in seconds.
 * @param outputPath - Path to save WAV file.
 * @returns True if recording succeeded.
 */
export async function recordAudio(durationSec: number, outputPath: string): Promise<boolean> {
  const platform = detectHostPlatform();

  try {
    let result;

    switch (platform) {
      case "windows-native":
      case "windows-wsl":
        // Use PowerShell for recording on Windows
        result = await exec("powershell.exe", [
          "-NoProfile", "-Command",
          `Add-Type -AssemblyName System.Speech; $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine; $r.SetInputToDefaultAudioDevice(); Start-Sleep -Seconds ${durationSec}`,
        ], { timeout: (durationSec + 5) * 1000 });
        break;

      case "macos":
        // Use sox (rec) on macOS
        if (commandExists("rec")) {
          result = await exec("rec", [
            outputPath, "trim", "0", String(durationSec),
          ], { timeout: (durationSec + 5) * 1000 });
        } else {
          log.warn("sox not found. Install with: brew install sox");
          return false;
        }
        break;

      case "linux":
        // Use arecord on Linux
        if (commandExists("arecord")) {
          result = await exec("arecord", [
            "-f", "S16_LE", "-r", "16000", "-c", "1",
            "-d", String(durationSec), outputPath,
          ], { timeout: (durationSec + 5) * 1000 });
        } else if (commandExists("rec")) {
          result = await exec("rec", [
            outputPath, "trim", "0", String(durationSec),
          ], { timeout: (durationSec + 5) * 1000 });
        } else {
          log.warn("No audio recorder found. Install arecord (alsa-utils) or sox.");
          return false;
        }
        break;
    }

    return (result?.exitCode ?? 1) === 0;
  } catch (e) {
    log.debug(`Recording failed: ${String(e)}`);
    return false;
  }
}

/**
 * Transcribe audio using whisper.cpp.
 *
 * @param audioPath - Path to WAV file.
 * @param model - Whisper model to use.
 * @returns Transcribed text, or null on failure.
 */
export async function transcribe(audioPath: string, model = "base"): Promise<string | null> {
  const whisperCmd = getWhisperCommand();
  if (!whisperCmd) {
    log.error("whisper.cpp not found in PATH.");
    log.dim("Install: https://github.com/ggerganov/whisper.cpp");
    return null;
  }

  const modelPath = getModelPath(model);
  if (!existsSync(modelPath)) {
    log.error(`Model not found: ${modelPath}`);
    return null;
  }

  try {
    const result = await exec(whisperCmd, [
      "-m", modelPath,
      "-f", audioPath,
      "--no-timestamps",
      "-nt",
    ], { timeout: 60_000 });

    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
  } catch (e) {
    log.debug(`Transcription failed: ${String(e)}`);
  }

  return null;
}

/**
 * Send transcribed text to a running ccbox container.
 *
 * Injects text into the active Claude Code session via ccbox-inject (tmux).
 *
 * @param text - Transcribed text to send.
 * @param containerName - Optional container name.
 * @returns True if sent successfully.
 */
export async function sendToContainer(text: string, containerName?: string): Promise<boolean> {
  const container = containerName ?? await findRunningContainer();
  if (!container) {
    log.error("No running ccbox container found.");
    return false;
  }

  log.dim(`Sending to container: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

  try {
    const result = await exec("docker", [
      "exec", container, "/usr/local/bin/ccbox-inject", text,
    ], { timeout: 10_000, env: getDockerEnv() });

    if (result.exitCode === 0) {
      log.success("Voice input sent to active session");
      return true;
    }
    log.error(`Injection failed: ${result.stderr}`);
  } catch (e) {
    log.error(`Failed to send to container: ${String(e)}`);
  }

  return false;
}

/**
 * Run voice-to-text pipeline.
 *
 * Records audio, transcribes with whisper, sends to container.
 *
 * @param options - Voice command options.
 * @returns True if the full pipeline succeeded.
 */
export async function voicePipeline(options: {
  model?: string;
  duration?: number;
  containerName?: string;
} = {}): Promise<boolean> {
  const { model = "base", duration = 10, containerName } = options;

  // Check prerequisites
  if (!isWhisperAvailable()) {
    log.error("whisper.cpp not found in PATH.");
    log.dim("Install: https://github.com/ggerganov/whisper.cpp");
    log.dim("  macOS: brew install whisper-cpp");
    log.dim("  Linux: build from source or use package manager");
    return false;
  }

  // Ensure model
  if (!(await ensureModel(model))) {
    return false;
  }

  // Record audio
  const tmpDir = getCcboxTempVoice();
  mkdirSync(tmpDir, { recursive: true });
  const audioPath = join(tmpDir, `recording-${Date.now()}.wav`);

  log.dim(`Recording (${duration}s max)... Press Ctrl+C to stop.`);
  if (!(await recordAudio(duration, audioPath))) {
    log.warn("Recording failed or no audio captured.");
    return false;
  }

  // Transcribe
  log.dim("Transcribing...");
  const text = await transcribe(audioPath, model);
  if (!text) {
    log.warn("Transcription returned empty result.");
    return false;
  }

  log.dim(`Transcription: "${text}"`);

  // Send to container
  return sendToContainer(text, containerName);
}
