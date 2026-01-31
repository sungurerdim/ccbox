/**
 * Docker build mock for unit testing.
 *
 * Provides fake Docker build/run results so unit tests
 * can verify build logic without requiring Docker.
 */

export interface BuildConfig {
  imageName: string;
  dockerfile: string;
  buildDir: string;
  args?: string[];
}

export interface BuildResult {
  imageId: string;
  exitCode: number;
}

/** Mock Docker build that returns a fake image ID. */
export async function mockDockerBuild(config: BuildConfig): Promise<BuildResult> {
  return {
    imageId: `mock-${Date.now()}-${config.imageName.replace(/[^a-z0-9]/g, "-")}`,
    exitCode: 0,
  };
}

/** Mock Docker build that simulates a failure. */
export async function mockDockerBuildFailure(_config: BuildConfig): Promise<BuildResult> {
  return {
    imageId: "",
    exitCode: 1,
  };
}

/** Record of all mock calls for verification. */
export class DockerMockRecorder {
  readonly calls: BuildConfig[] = [];

  async build(config: BuildConfig): Promise<BuildResult> {
    this.calls.push(config);
    return mockDockerBuild(config);
  }

  reset(): void {
    this.calls.length = 0;
  }
}
