/**
 * Dockerfile generator interface for ccbox.
 *
 * Defines the contract for generating Dockerfiles for different stacks.
 * Enables dependency injection and testability.
 */

import type { LanguageStack } from "../stacks.js";

/**
 * Interface for Dockerfile generation.
 * Implementations produce Dockerfile content for a given stack.
 */
export interface DockerfileGenerator {
  /** Generate Dockerfile content for the given stack. */
  generate(stack: LanguageStack): string;
}

/**
 * Interface for writing Docker images.
 * Implementations handle the actual Docker build process.
 */
export interface ImageWriter {
  /** Write (build) a Docker image from configuration. */
  write(config: ImageWriteConfig): Promise<ImageWriteResult>;
}

/** Configuration for writing a Docker image. */
export interface ImageWriteConfig {
  /** Build directory containing Dockerfile */
  buildDir: string;
  /** Target image name (e.g., ccbox_python:latest) */
  imageName: string;
  /** Build arguments */
  buildArgs?: Record<string, string>;
  /** Build timeout in milliseconds */
  timeout?: number;
  /** Progress mode (auto/plain/tty) */
  progress?: string;
  /** Whether to use Docker build cache */
  cache?: boolean;
}

/** Result of an image write operation. */
export interface ImageWriteResult {
  /** Whether the build succeeded */
  success: boolean;
  /** Image name that was built */
  imageName: string;
  /** Build output/logs */
  output?: string;
  /** Error message if failed */
  error?: string;
}
