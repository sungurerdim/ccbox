# API Reference

Internal module documentation for ccbox development.

## Modules

### config.ts

Stack definitions and configuration management.

#### Types

```typescript
enum LanguageStack {
  BASE = "base",       // Claude Code only
  PYTHON = "python",   // Python + uv + ruff
  WEB = "web",         // Node.js + TypeScript
  GO = "go",           // Go + golangci-lint
  RUST = "rust",       // Rust + clippy
  JAVA = "java",       // JDK + Maven + Gradle
  // ... 15 more stacks
}

interface Config {
  version: string;
  gitName: string;
  gitEmail: string;
  claudeConfigDir: string;
}
```

#### Functions

```typescript
// Get Docker image name for stack
getImageName(stack: LanguageStack): string
// Returns: "ccbox_python:latest"

// Check if image exists locally
imageExists(stack: LanguageStack): boolean

// Generate unique container name
getContainerName(projectName: string, unique?: boolean): string
// Returns: "ccbox_myproject_a1b2c3"

// Parse and validate stack from string
createStack(value: string): LanguageStack
// Throws ValidationError if invalid
```

### build.ts

Docker image building operations.

#### Types

```typescript
interface BuildOptions {
  progress?: string;  // "auto" | "plain" | "tty"
}
```

#### Functions

```typescript
// Build stack image (handles dependencies)
buildImage(stack: LanguageStack, options?: BuildOptions): Promise<boolean>

// Build project-specific image with dependencies
buildProjectImage(
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  depsList: DepsInfo[],
  depsMode: DepsMode,
  options?: BuildOptions
): Promise<string | null>
// Returns image name or null on failure

// Ensure image ready (build if needed)
ensureImageReady(
  stack: LanguageStack,
  buildOnly: boolean,
  options?: BuildOptions
): Promise<boolean>
```

### detector.ts

Project type detection for automatic stack selection.

#### Types

```typescript
interface DetectionResult {
  recommendedStack: LanguageStack;
  detectedLanguages: string[];
  detectionDetails?: Record<string, string>;  // file that triggered detection
}
```

#### Functions

```typescript
// Detect project type from directory contents
detectProjectType(directory: string, verbose?: boolean): DetectionResult
```

**Detection patterns:**
- `pyproject.toml`, `requirements.txt` -> python
- `package.json`, `tsconfig.json` -> web
- `go.mod` -> go
- `Cargo.toml` -> rust
- `pom.xml`, `build.gradle` -> java

### generator.ts

Dockerfile and entrypoint generation.

#### Functions

```typescript
// Generate Dockerfile for stack
generateDockerfile(stack: LanguageStack): string

// Generate entrypoint.sh script
generateEntrypoint(): string

// Write build files to temp directory
writeBuildFiles(stack: LanguageStack, targetArch?: string): string
// Returns build directory path

// Generate project Dockerfile with deps
generateProjectDockerfile(
  baseImage: string,
  depsList: DepsInfo[],
  depsMode: DepsMode,
  projectPath: string
): string
```

### logger.ts

Centralized logging with level control.

#### Types

```typescript
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}
```

#### Functions

```typescript
// Set minimum log level
setLogLevel(level: LogLevel): void

// Logger methods
log.debug(message: string): void   // dim, only at DEBUG level
log.info(message: string): void    // normal
log.warn(message: string): void    // yellow
log.error(message: string): void   // red
log.success(message: string): void // green
log.dim(message: string): void     // dim gray
log.bold(message: string): void    // bold
```

#### Style Helpers

```typescript
// Return styled strings (for composition)
style.dim(text: string): string
style.bold(text: string): string
style.red(text: string): string
style.green(text: string): string
style.cyan(text: string): string
```

## Examples

### Detect and build for project

```typescript
import { detectProjectType } from "./detector.js";
import { ensureImageReady } from "./build.js";

const result = detectProjectType("/path/to/project", true);
console.log(`Detected: ${result.detectedLanguages.join(", ")}`);
console.log(`Stack: ${result.recommendedStack}`);

await ensureImageReady(result.recommendedStack, false);
```

### Custom logging

```typescript
import { log, style, setLogLevel, LogLevel } from "./logger.js";

setLogLevel(LogLevel.DEBUG);

log.info("Starting operation...");
log.debug("Verbose details here");
log.success("Done!");

// Compose styled output
log.raw(`${style.green("OK")} - ${style.dim("optional details")}`);
```

### Validate paths

```typescript
import { validateProjectPath } from "./paths.js";
import { PathError } from "./errors.js";

try {
  const safe = validateProjectPath("/home/user/project");
} catch (e) {
  if (e instanceof PathError) {
    console.error("Invalid path:", e.message);
  }
}
```
