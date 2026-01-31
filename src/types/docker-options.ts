/**
 * Docker option type definitions for ccbox.
 *
 * Structured option groups for docker run command building.
 * Replaces monolithic options object with composable interfaces.
 */

/** Core options for container execution. */
export interface CoreOptions {
  /** Use a pre-built project image instead of stack image */
  projectImage?: string;
  /** Fresh mode: auth only, clean slate */
  fresh?: boolean;
}

/** Debug and logging options. */
export interface DebugOptions {
  /** Debug level (0=off, 1=basic, 2=stream) */
  debug?: number;
  /** Append custom instructions to system prompt */
  appendSystemPrompt?: string;
}

/** Mount and storage options. */
export interface MountOptions {
  /** Use ephemeral tmpfs for debug logs */
  ephemeralLogs?: boolean;
}

/** Environment and runtime options. */
export interface EnvironmentOptions {
  /** Additional environment variables (KEY=VALUE format) */
  envVars?: string[];
}

/** Prompt and model options. */
export interface PromptOptions {
  /** Initial prompt text */
  prompt?: string;
  /** Model name */
  model?: string;
  /** Quiet mode (print only) */
  quiet?: boolean;
}

/** Resource constraint options. */
export interface ResourceOptions {
  /** Remove CPU/priority limits */
  unrestricted?: boolean;
}

/** Build options for Docker image building. */
export interface BuildOptions {
  /** Docker build progress mode */
  progress?: string;
  /** Use Docker build cache */
  cache?: boolean;
}

/** Combined options for getDockerRunCmd. */
export type DockerRunOptions = CoreOptions & DebugOptions & MountOptions &
  EnvironmentOptions & PromptOptions & ResourceOptions;

/** Combined options for build and run operations. */
export type BuildAndRunOptions = DockerRunOptions & BuildOptions;
