/**
 * Base Dockerfile templates for ccbox (Python, Node/Bun, Deno).
 *
 * Extracted from dockerfile-gen.ts for maintainability.
 */

export { generateDockerfile as generateBaseDockerfile } from "../dockerfile-gen.js";

// Note: This module provides the organizational split point.
// The actual templates remain in dockerfile-gen.ts for now,
// as they share common template strings (COMMON_TOOLS, FUSE_BUILD, etc.)
// that would require significant refactoring to fully decouple.
//
// To add a new base stack:
// 1. Add template function in dockerfile-gen.ts
// 2. Register in DOCKERFILE_GENERATORS map
// 3. Add enum value to LanguageStack in stacks.ts
