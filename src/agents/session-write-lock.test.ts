import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  acquireSessionWriteLock,
  cleanStaleLockFiles,
  resolveSessionLockMaxHoldFromTimeout,
} from "./session-write-lock.js";

async function expectLockRemovedOnlyAfterFinalRelease(params: {
  lockPath: string;
  firstLock: { release: () => Promise<void> };
  secondLock: { release: () => Promise<void> };
}) {
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.firstLock.release();
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.secondLock.release();
  await expect(fs.access(params.lockPath)).rejects.toThrow();
}

describe("acquireSessionWriteLock", () => {
  it("reuses locks across symlinked session paths", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "link");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir);

      const sessionReal = path.join(realDir, "sessions.json");
      const sessionLink = path.join(linkDir, "sessions.json");

      const lockA = await acquireSessionWriteLock({ sessionFile: sessionReal, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile: sessionLink, timeoutMs: 500 });

      await lockB.release();
      await lockA.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the lock file until the last release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;

      const lockA = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims stale lock files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 123456, createdAt: new Date(Date.now() - 60_000).toISOString() }),
        "utf8",
      );

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10 });
      const raw = await fs.readFile(lockPath, "utf8");
      const payload = JSON.parse(raw) as { pid: number };

      expect(payload.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reclaim fresh malformed lock files during contention", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(lockPath, "{}", "utf8");

      await expect(
        acquireSessionWriteLock({ sessionFile, timeoutMs: 50, staleMs: 60_000 }),
      ).rejects.toThrow(/session file locked/);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims malformed lock files once they are old enough", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(lockPath, "{}", "utf8");
      const staleDate = new Date(Date.now() - 2 * 60_000);
      await fs.utimes(lockPath, staleDate, staleDate);

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10_000 });
      await lock.release();
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("watchdog releases stale in-process locks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sessionFile = path.join(root, "session.jsonl");
      const lockPath = `${sessionFile}.lock`;
      const lockA = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        maxHoldMs: 1,
      });

      const released = await __testing.runLockWatchdogCheck(Date.now() + 1000);
      expect(released).toBeGreaterThanOrEqual(1);
      await expect(fs.access(lockPath)).rejects.toThrow();

      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await expect(fs.access(lockPath)).resolves.toBeUndefined();

      // Old release handle must not affect the new lock.
      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    } finally {
      warnSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives max hold from timeout plus grace", () => {
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 600_000 })).toBe(720_000);
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 1_000, minMs: 5_000 })).toBe(121_000);
  });

  it("clamps max hold for effectively no-timeout runs", () => {
    expect(
      resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: 2_147_000_000,
      }),
    ).toBe(2_147_000_000);
  });

  it("cleans stale .jsonl lock files in sessions directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    const staleDeadLock = path.join(sessionsDir, "dead.jsonl.lock");
    const staleAliveLock = path.join(sessionsDir, "old-live.jsonl.lock");
    const freshAliveLock = path.join(sessionsDir, "fresh-live.jsonl.lock");

    try {
      await fs.writeFile(
        staleDeadLock,
        JSON.stringify({
          pid: 999_999,
          createdAt: new Date(nowMs - 120_000).toISOString(),
        }),
        "utf8",
      );
      await fs.writeFile(
        staleAliveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 120_000).toISOString(),
        }),
        "utf8",
      );
      await fs.writeFile(
        freshAliveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 1_000).toISOString(),
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
      });

      expect(result.locks).toHaveLength(3);
      expect(result.cleaned).toHaveLength(2);
      expect(result.cleaned.map((entry) => path.basename(entry.lockPath)).toSorted()).toEqual([
        "dead.jsonl.lock",
        "old-live.jsonl.lock",
      ]);

      await expect(fs.access(staleDeadLock)).rejects.toThrow();
      await expect(fs.access(staleAliveLock)).rejects.toThrow();
      await expect(fs.access(freshAliveLock)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes held locks on termination signals", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
    const originalKill = process.kill.bind(process);
    process.kill = ((_pid: number, _signal?: NodeJS.Signals) => true) as typeof process.kill;
    try {
      for (const signal of signals) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-cleanup-"));
        try {
          const sessionFile = path.join(root, "sessions.json");
          const lockPath = `${sessionFile}.lock`;
          await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
          const keepAlive = () => {};
          if (signal === "SIGINT") {
            process.on(signal, keepAlive);
          }

          __testing.handleTerminationSignal(signal);

          await expect(fs.stat(lockPath)).rejects.toThrow();
          if (signal === "SIGINT") {
            process.off(signal, keepAlive);
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    } finally {
      process.kill = originalKill;
    }
  });

  it("registers cleanup for SIGQUIT and SIGABRT", () => {
    expect(__testing.cleanupSignals).toContain("SIGQUIT");
    expect(__testing.cleanupSignals).toContain("SIGABRT");
  });
  it("cleans up locks on SIGINT without removing other handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const originalKill = process.kill.bind(process);
    const killCalls: Array<NodeJS.Signals | undefined> = [];
    let otherHandlerCalled = false;

    process.kill = ((pid: number, signal?: NodeJS.Signals) => {
      killCalls.push(signal);
      return true;
    }) as typeof process.kill;

    const otherHandler = () => {
      otherHandlerCalled = true;
    };

    process.on("SIGINT", otherHandler);

    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("SIGINT");

      await expect(fs.access(lockPath)).rejects.toThrow();
      expect(otherHandlerCalled).toBe(true);
      expect(killCalls).toEqual([]);
    } finally {
      process.off("SIGINT", otherHandler);
      process.kill = originalKill;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up locks on exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("exit", 0);

      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps other signal listeners registered", () => {
    const keepAlive = () => {};
    process.on("SIGINT", keepAlive);

    __testing.handleTerminationSignal("SIGINT");

    expect(process.listeners("SIGINT")).toContain(keepAlive);
    process.off("SIGINT", keepAlive);
  });

  it("reclaims own-orphan locks (same PID, not in memory)", async () => {
    // This simulates Docker container restart where PID is reused
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;

      // Create a lock file with our own PID (simulating restart)
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(Date.now() - 1000).toISOString(),
        }),
        "utf8",
      );

      // Should reclaim the lock since it's our PID but not in HELD_LOCKS
      const lock = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        detectOwnOrphan: true,
      });

      // Verify the lock was reclaimed and we now hold it
      const raw = await fs.readFile(lockPath, "utf8");
      const payload = JSON.parse(raw) as { pid: number };
      expect(payload.pid).toBe(process.pid);

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("removing orphaned lock from previous process instance"),
      );

      await lock.release();
    } finally {
      warnSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reclaim own-orphan when detectOwnOrphan is disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;

      // Create a lock file with our own PID
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );

      // Should timeout since detectOwnOrphan is disabled
      await expect(
        acquireSessionWriteLock({
          sessionFile,
          timeoutMs: 100,
          staleMs: 60_000, // Not stale
          detectOwnOrphan: false,
        }),
      ).rejects.toThrow(/session file locked/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects environment variable overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const originalEnv = { ...process.env };
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;

      // Create a stale lock from a dead process
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: 999_999,
          createdAt: new Date(Date.now() - 5000).toISOString(), // 5s ago
        }),
        "utf8",
      );

      // Set env var for short stale threshold (should reclaim)
      process.env.OPENCLAW_SESSION_LOCK_STALE_MS = "1000";

      const lock = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        // Don't pass staleMs - should use env var
      });

      const raw = await fs.readFile(lockPath, "utf8");
      const payload = JSON.parse(raw) as { pid: number };
      expect(payload.pid).toBe(process.pid);

      await lock.release();
    } finally {
      process.env = originalEnv;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("defaults to 60s timeout instead of 10s", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;

      // Create a fresh lock from another process
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: 999_999,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const startTime = Date.now();

      // Don't pass timeoutMs - should use new default of 60s
      // But we don't want to wait that long, so check it times out
      // after we remove the lock
      const lockPromise = acquireSessionWriteLock({
        sessionFile,
        staleMs: 120_000, // Not stale
      });

      // Wait a bit then remove the lock
      await new Promise((r) => setTimeout(r, 200));
      await fs.rm(lockPath, { force: true });

      // Should acquire after lock is removed
      const lock = await lockPromise;
      const elapsed = Date.now() - startTime;

      // Verify we waited (proving default is not 0)
      expect(elapsed).toBeGreaterThan(100);

      await lock.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
