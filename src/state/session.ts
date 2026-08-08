import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Durable metadata persisted beside each named session directory. */
export interface SessionMetadata {
  sessionId: string;
  sessionTitle: string;
  workDir: string;
  createdAt: string;
  updatedAt: string;
  /** Path to the latest kernel snapshot if one was persisted. */
  kernelSnapshotPath: string | undefined;
}

/** Absolute filesystem paths for one isolated session. */
export interface SessionPaths {
  sessionId: string;
  dir: string;
  metaPath: string;
  workspaceDir: string;
  kernelDir: string;
  artifactsDir: string;
}

/**
 * Derive a deterministic session identifier from the canonical working
 * directory and the session title.
 *
 * Unnamed sessions (no `sessionTitle` or blank string) are **ephemeral** and
 * return `null` — they are never persisted to disk.
 */
export function deriveSessionId(workDir: string, sessionTitle: string | undefined): string | null {
  const title = sessionTitle?.trim();
  if (!title) return null;

  const canonical = canonicalizeWorkDir(workDir);
  const hash = createHash("sha256");
  hash.update(canonical);
  hash.update("\0");
  hash.update(title);
  return hash.digest("hex").slice(0, 32);
}

/** Canonicalise a working directory path (realpath with fallback to resolve). */
export function canonicalizeWorkDir(workDir: string): string {
  try {
    return realpathSync(workDir);
  } catch {
    return resolve(workDir);
  }
}

function readMeta(path: string): SessionMetadata | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionMetadata;
  } catch {
    return null;
  }
}

/**
 * Persistent session store.
 *
 * Each durable session lives under `<sessionsDir>/<sessionId>/` with:
 *
 * ```
 * meta.json        – SessionMetadata JSON
 * workspace/       – isolated working directory
 * kernel/          – kernel snapshots and state
 * artifacts/       – session artifacts
 * ```
 */
export class SessionStore {
  constructor(private readonly sessionsDir: string) {}

  /** Resolve the filesystem paths for a given session id. */
  sessionPaths(sessionId: string): SessionPaths {
    const dir = join(this.sessionsDir, sessionId);
    return {
      sessionId,
      dir,
      metaPath: join(dir, "meta.json"),
      workspaceDir: join(dir, "workspace"),
      kernelDir: join(dir, "kernel"),
      artifactsDir: join(dir, "artifacts"),
    };
  }

  /**
   * Get or create a durable session directory.
   *
   * Returns `null` for unnamed (ephemeral) sessions.
   */
  getOrCreate(workDir: string, sessionTitle: string | undefined): SessionPaths | null {
    const sessionId = deriveSessionId(workDir, sessionTitle);
    if (sessionId === null) return null;

    return this.createOrUpdate(sessionId, workDir, sessionTitle!);
  }

  /** Create or update a session directory and its metadata. */
  private createOrUpdate(sessionId: string, workDir: string, sessionTitle: string): SessionPaths {
    const paths = this.sessionPaths(sessionId);
    for (const dir of [paths.dir, paths.workspaceDir, paths.kernelDir, paths.artifactsDir]) {
      mkdirSync(dir, { recursive: true });
    }

    const now = new Date().toISOString();
    const existing = readMeta(paths.metaPath);
    const meta: SessionMetadata = existing
      ? { ...existing, updatedAt: now }
      : {
          sessionId,
          sessionTitle,
          workDir: canonicalizeWorkDir(workDir),
          createdAt: now,
          updatedAt: now,
          kernelSnapshotPath: undefined,
        };
    writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2) + "\n");
    return paths;
  }

  /**
   * Find the most recently updated durable session.
   *
   * Used to resume a session after a process or pod restart.
   */
  mostRecent(): SessionPaths | null {
    if (!existsSync(this.sessionsDir)) return null;

    let best: { paths: SessionPaths; updatedAt: string } | null = null;
    for (const entry of readdirSync(this.sessionsDir)) {
      const dir = join(this.sessionsDir, entry);
      const metaPath = join(dir, "meta.json");
      const meta = readMeta(metaPath);
      if (!meta) continue;
      if (best === null || meta.updatedAt > best.updatedAt) {
        best = { paths: this.sessionPaths(entry), updatedAt: meta.updatedAt };
      }
    }
    return best?.paths ?? null;
  }

  /** Load metadata for a session id (or `null` if not found). */
  loadMetadata(sessionId: string): SessionMetadata | null {
    return readMeta(this.sessionPaths(sessionId).metaPath);
  }

  /** Record the latest kernel snapshot path for a session. */
  setKernelSnapshot(sessionId: string, snapshotPath: string): void {
    const paths = this.sessionPaths(sessionId);
    const meta = readMeta(paths.metaPath);
    if (!meta) return;
    meta.kernelSnapshotPath = snapshotPath;
    meta.updatedAt = new Date().toISOString();
    writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2) + "\n");
  }

  /** Touch the session metadata to mark it as recently active. */
  touch(sessionId: string): void {
    const paths = this.sessionPaths(sessionId);
    const meta = readMeta(paths.metaPath);
    if (!meta) return;
    meta.updatedAt = new Date().toISOString();
    writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2) + "\n");
  }
}
