/**
 * Docker run command builder for ccbox.
 *
 * Fluent builder pattern for constructing docker run commands.
 * Replaces the monolithic getDockerRunCmd parameter list.
 *
 * Usage:
 *   const cmd = new DockerRunCommandBuilder("ccbox_python:latest")
 *     .withUserMapping(1000, 1000)
 *     .withCapabilities({ capDrop: "ALL", capAdd: ["SETUID", "SETGID"] })
 *     .withMounts([{ host: "/project", container: "/ccbox/project", mode: "rw" }])
 *     .withEnvironment({ HOME: "/ccbox", TZ: "UTC" })
 *     .build();
 */

/** Mount specification for Docker volumes. */
export interface MountSpec {
  host: string;
  container: string;
  mode?: "rw" | "ro";
}

/** Capability configuration. */
export interface CapabilityConfig {
  capDrop?: string;
  capAdd?: string[];
}

/** Tmpfs mount configuration. */
export interface TmpfsConfig {
  path: string;
  size: string;
  mode?: string;
  options?: string;
}

/**
 * Builder for Docker run commands.
 *
 * Produces a string[] suitable for passing to execInherit("docker", args).
 */
export class DockerRunCommandBuilder {
  private readonly args: string[] = ["run", "--rm"];
  private readonly envVars: Map<string, string> = new Map();
  private readonly mounts: string[] = [];
  private readonly tmpfsMounts: string[] = [];
  private imageName: string;

  constructor(imageName: string) {
    this.imageName = imageName;
  }

  /** Set container name. */
  withName(name: string): this {
    this.args.push("--name", name);
    return this;
  }

  /** Set interactive mode (-it or -i). */
  withInteractive(tty = true): this {
    this.args.push(tty ? "-it" : "-i");
    return this;
  }

  /** Add user UID/GID mapping via environment variables. */
  withUserMapping(uid: number, gid: number): this {
    this.envVars.set("CCBOX_UID", String(uid));
    this.envVars.set("CCBOX_GID", String(gid));
    return this;
  }

  /** Configure capability restrictions. */
  withCapabilities(config: CapabilityConfig): this {
    if (config.capDrop) {
      this.args.push(`--cap-drop=${config.capDrop}`);
    }
    if (config.capAdd) {
      for (const cap of config.capAdd) {
        this.args.push(`--cap-add=${cap}`);
      }
    }
    return this;
  }

  /** Add volume mounts. */
  withMounts(specs: MountSpec[]): this {
    for (const spec of specs) {
      this.mounts.push(`${spec.host}:${spec.container}:${spec.mode ?? "rw"}`);
    }
    return this;
  }

  /** Add raw volume mount string. */
  withRawMount(mount: string): this {
    this.mounts.push(mount);
    return this;
  }

  /** Add tmpfs mounts. */
  withTmpfs(configs: TmpfsConfig[]): this {
    for (const cfg of configs) {
      const opts = [
        `rw`,
        `size=${cfg.size}`,
        cfg.mode ? `mode=${cfg.mode}` : null,
        cfg.options ?? null,
      ].filter(Boolean).join(",");
      this.tmpfsMounts.push(`${cfg.path}:${opts}`);
    }
    return this;
  }

  /** Set environment variables. */
  withEnvironment(vars: Record<string, string>): this {
    for (const [key, value] of Object.entries(vars)) {
      this.envVars.set(key, value);
    }
    return this;
  }

  /** Set timezone. */
  withTimezone(tz: string): this {
    this.envVars.set("TZ", tz);
    return this;
  }

  /** Set working directory. */
  withWorkdir(dir: string): this {
    this.args.push("-w", dir);
    return this;
  }

  /** Add resource limits. */
  withResourceLimits(opts: {
    pidsLimit?: number;
    cpuShares?: number;
    shmSize?: string;
  }): this {
    if (opts.pidsLimit) { this.args.push(`--pids-limit=${opts.pidsLimit}`); }
    if (opts.cpuShares) { this.args.push(`--cpu-shares=${opts.cpuShares}`); }
    if (opts.shmSize) { this.args.push(`--shm-size=${opts.shmSize}`); }
    return this;
  }

  /** Add init process. */
  withInit(): this {
    this.args.push("--init");
    return this;
  }

  /** Add privileged mode. */
  withPrivileged(): this {
    this.args.push("--privileged");
    return this;
  }

  /** Add device. */
  withDevice(device: string): this {
    this.args.push("--device", device);
    return this;
  }

  /** Add log options. */
  withLogOptions(driver: string, opts: Record<string, string>): this {
    this.args.push("--log-driver", driver);
    for (const [key, value] of Object.entries(opts)) {
      this.args.push("--log-opt", `${key}=${value}`);
    }
    return this;
  }

  /** Add DNS options. */
  withDnsOptions(opts: string[]): this {
    for (const opt of opts) {
      this.args.push("--dns-opt", opt);
    }
    return this;
  }

  /** Add ulimit. */
  withUlimit(name: string, soft: number, hard: number): this {
    this.args.push("--ulimit", `${name}=${soft}:${hard}`);
    return this;
  }

  /** Add raw argument. */
  withRawArg(...rawArgs: string[]): this {
    this.args.push(...rawArgs);
    return this;
  }

  /** Build the final command array (without "docker" prefix). */
  build(): string[] {
    const cmd = [...this.args];

    // Add volume mounts
    for (const mount of this.mounts) {
      cmd.push("-v", mount);
    }

    // Add tmpfs mounts
    for (const tmpfs of this.tmpfsMounts) {
      cmd.push("--tmpfs", tmpfs);
    }

    // Add environment variables
    for (const [key, value] of this.envVars) {
      cmd.push("-e", `${key}=${value}`);
    }

    // Image name
    cmd.push(this.imageName);

    return cmd;
  }

  /** Build the final command array with "docker" prefix. */
  buildFull(): string[] {
    return ["docker", ...this.build()];
  }
}
