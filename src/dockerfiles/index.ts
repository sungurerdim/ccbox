/**
 * Dockerfile generation facade for ccbox.
 *
 * Master module that delegates to category-specific generators.
 * Re-exports from dockerfile-gen.ts which contains all templates.
 *
 * Organization:
 * - base.ts: Python, Node/Bun, Deno base templates
 * - web.ts: Next.js, React, Vue, etc.
 * - jvm.ts: Java, Kotlin, Scala, Clojure
 * - other.ts: Go, Rust, Ruby, PHP, etc.
 */

export {
  generateDockerfile,
  DOCKERFILE_GENERATORS,
  PYTHON_TOOLS_BASE,
} from "../dockerfile-gen.js";
