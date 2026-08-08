/**
 * Docker container harness for e2e restart recovery tests.
 *
 * Provides helpers to:
 * - Build a test container image (or skip if Docker unavailable)
 * - Start/stop/restart containers
 * - Inspect container state and volumes
 * - Simulate PVC-style persistence via Docker volumes
 *
 * All Docker operations are wrapped in try/catch so tests can skip
 * gracefully when Docker is not available (e.g., in CI without Docker).
 */

import { execFileSync } from "node:child_process";

export interface ContainerConfig {
  /** Container name prefix (suffixed with random ID). */
  name: string;
  /** Docker image to use. */
  image: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Volume mounts: { hostPath: containerPath } or { volumeName: containerPath }. */
  volumes?: Record<string, string>;
  /** Ports to expose: { containerPort: hostPort }. */
  ports?: Record<number, number>;
  /** Command to run. */
  command?: string[];
  /** Working directory inside container. */
  workdir?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  running: boolean;
}

/**
 * Check if Docker is available on the system.
 */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a Docker command and return stdout.
 */
function docker(args: string[]): string {
  return execFileSync("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 30000,
  }).trim();
}

/**
 * Create a Docker volume for PVC-style persistence testing.
 */
export function createVolume(name: string): string {
  docker(["volume", "create", name]);
  return name;
}

/**
 * Remove a Docker volume.
 */
export function removeVolume(name: string): void {
  try {
    docker(["volume", "rm", "-f", name]);
  } catch {
    // ignore
  }
}

/**
 * Start a container with the given configuration.
 * Returns the container ID.
 */
export function startContainer(config: ContainerConfig): string {
  const args = ["run", "-d", "--name", config.name];

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

  return docker(args);
}

/**
 * Stop a container (graceful, then SIGKILL after 10s).
 */
export function stopContainer(name: string): void {
  try {
    docker(["stop", "-t", "10", name]);
  } catch {
    // ignore
  }
}

/**
 * Restart a stopped container.
 */
export function restartContainer(name: string): void {
  docker(["start", name]);
}

/**
 * Remove a container (force).
 */
export function removeContainer(name: string): void {
  try {
    docker(["rm", "-f", name]);
  } catch {
    // ignore
  }
}

/**
 * Get container info (status, running state).
 */
export function getContainerInfo(name: string): ContainerInfo {
  const inspect = docker([
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
export function execInContainer(name: string, command: string[]): string {
  return docker(["exec", name, ...command]);
}

/**
 * Get container logs.
 */
export function getContainerLogs(name: string): string {
  return docker(["logs", name]);
}

/**
 * Wait for a container to reach "running" state.
 */
export async function waitForContainerRunning(name: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = getContainerInfo(name);
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
