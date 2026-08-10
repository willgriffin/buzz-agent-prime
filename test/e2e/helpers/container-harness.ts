/**
 * Docker container harness for e2e restart recovery tests.
 *
 * Provides helpers to:
 * - Build a test container image (or skip if Docker unavailable)
 * - Start/stop/restart containers
 * - Inspect container state and volumes
 * - Simulate PVC-style persistence via Docker volumes
 *
 * Docker scenarios are opt-in. Every invoked Docker command has a bounded
 * process-group timeout so an unavailable CLI or daemon fails cleanly.
 */

import { runDockerCommand } from "../../helpers/docker.js";

export { isDockerAvailable, isDockerImageAvailable } from "../../helpers/docker.js";

export interface ContainerConfig {
  /** Container name prefix (suffixed with random ID). */
  name: string;
  /** Docker image to use. */
  image: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Volume mounts: { hostPath: containerPath } or { volumeName: containerPath }. */
  volumes?: Record<string, string>;
  /** Explicit Docker volume mounts, including Kubernetes-style subpaths. */
  mounts?: ContainerMount[];
  /** Ports to expose: { containerPort: hostPort }. */
  ports?: Record<number, number>;
  /** Command to run. */
  command?: string[];
  /** Working directory inside container. */
  workdir?: string;
  /** Override the image entrypoint for a credential-free fixture. */
  entrypoint?: string;
  /** Run with an immutable root filesystem. */
  readOnlyRootFilesystem?: boolean;
  /** Writable temporary filesystems needed with an immutable root filesystem. */
  tmpfs?: string[];
}

export interface ContainerMount {
  /** Docker volume name. */
  source: string;
  /** Destination path in the container. */
  target: string;
  /** Existing directory inside the volume to mount, like a Kubernetes subPath. */
  subPath?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  running: boolean;
}

/**
 * Create a Docker volume for PVC-style persistence testing.
 */
export async function createVolume(name: string): Promise<string> {
  await runDockerCommand(["volume", "create", name]);
  return name;
}

/**
 * Remove a Docker volume.
 */
export async function removeVolume(name: string): Promise<void> {
  try {
    await runDockerCommand(["volume", "rm", "-f", name]);
  } catch {
    // ignore
  }
}

/**
 * Start a container with the given configuration.
 * Returns the container ID.
 */
export async function startContainer(config: ContainerConfig): Promise<string> {
  const args = ["run", "-d", "--name", config.name];

  if (config.readOnlyRootFilesystem) {
    args.push("--read-only");
  }

  if (config.tmpfs) {
    for (const mount of config.tmpfs) {
      args.push("--tmpfs", mount);
    }
  }

  if (config.entrypoint) {
    args.push("--entrypoint", config.entrypoint);
  }

  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      args.push("-e", `${k}=${v}`);
    }
  }

  if (config.volumes) {
    for (const [host, container] of Object.entries(config.volumes)) {
      args.push("-v", `${host}:${container}`);
    }
  }

  if (config.mounts) {
    for (const mount of config.mounts) {
      const fields = ["type=volume", `src=${mount.source}`, `dst=${mount.target}`];
      if (mount.subPath) fields.push(`volume-subpath=${mount.subPath}`);
      args.push("--mount", fields.join(","));
    }
  }

  if (config.ports) {
    for (const [containerPort, hostPort] of Object.entries(config.ports)) {
      args.push("-p", `${hostPort}:${containerPort}`);
    }
  }

  if (config.workdir) {
    args.push("-w", config.workdir);
  }

  args.push(config.image);

  if (config.command) {
    args.push(...config.command);
  }

  return await runDockerCommand(args);
}

/**
 * Stop a container (graceful, then SIGKILL after 10s).
 */
export async function stopContainer(name: string): Promise<void> {
  try {
    await runDockerCommand(["stop", "-t", "10", name], { timeoutMs: 15000 });
  } catch {
    // ignore
  }
}

/**
 * Restart a stopped container.
 */
export async function restartContainer(name: string): Promise<void> {
  await runDockerCommand(["start", name]);
}

/**
 * Remove a container (force).
 */
export async function removeContainer(name: string): Promise<void> {
  try {
    await runDockerCommand(["rm", "-f", name]);
  } catch {
    // ignore
  }
}

/**
 * Get container info (status, running state).
 */
export async function getContainerInfo(name: string): Promise<ContainerInfo> {
  const inspect = await runDockerCommand([
    "inspect",
    "--format",
    "{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Running}}",
    name,
  ]);
  const parts = inspect.split("|");
  return {
    id: parts[0] ?? "",
    name: parts[1] ?? "",
    status: parts[2] ?? "unknown",
    running: parts[3] === "true",
  };
}

/**
 * Execute a command inside a running container and return stdout.
 */
export async function execInContainer(name: string, command: string[]): Promise<string> {
  return await runDockerCommand(["exec", name, ...command]);
}

/**
 * Get container logs.
 */
export async function getContainerLogs(name: string): Promise<string> {
  return await runDockerCommand(["logs", name]);
}

/**
 * Wait for a container to reach "running" state.
 */
export async function waitForContainerRunning(name: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await getContainerInfo(name);
      if (info.running) return true;
    } catch {
      // container might not exist yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Generate a unique container name.
 */
export function uniqueContainerName(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${suffix}`;
}
