import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeControlCli,
  type ControlDeps,
} from "../../src/control/cli.js";

interface FakeHarness {
  deps: ControlDeps;
  spawned: string[][];
  opened: string[];
  terminated: number[];
  alive: Set<number>;
}

function makeDeps(overrides: Partial<ControlDeps> = {}): FakeHarness {
  const spawned: string[][] = [];
  const opened: string[] = [];
  const terminated: number[] = [];
  const alive = new Set<number>();
  let now = 1_000_000;
  const deps: ControlDeps = {
    mainJs: "/fake/dist/main.js",
    version: "0.0.0-test",
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    pidAlive: (pid) => alive.has(pid),
    // Models reality: nothing answers before spawn; the serve child answers after.
    probe: async () => spawned.length > 0,
    spawnServe: (args) => {
      spawned.push(args);
      const pid = 4200 + spawned.length;
      alive.add(pid);
      return pid;
    },
    terminate: (pid) => {
      terminated.push(pid);
      alive.delete(pid);
    },
    openUrl: (url) => {
      opened.push(url);
    },
    stdoutIsTty: false,
    platform: "linux",
    ...overrides,
  };
  return { deps, spawned, opened, terminated, alive };
}

function statePath(root: string): string {
  return join(root, ".folderforge", "control.json");
}

const roots: string[] = [];
function trackedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ff-control-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("folderforge control", () => {
  it("start spawns a detached serve child, persists state, and prints the SPA URL", async () => {
    const root = trackedRoot();
    const { deps, spawned } = makeDeps();
    const result = await executeControlCli(
      ["start", "--project", root, "--no-open"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.slice(1, 3)).toEqual(["control", "serve"]);
    expect(spawned[0]).toContain("--project");
    expect(spawned[0]).toContain("--port");
    const state = JSON.parse(readFileSync(statePath(root), "utf8")) as {
      pid: number;
      port: number;
      schemaVersion: number;
    };
    expect(state.schemaVersion).toBe(1);
    expect(state.port).toBe(7332);
    expect(state.pid).toBeGreaterThan(0);
    expect(result.output).toContain("http://127.0.0.1:7332/app");
  });

  it("start honours --port and --open opens the browser", async () => {
    const root = trackedRoot();
    const { deps, spawned, opened } = makeDeps();
    const result = await executeControlCli(
      ["start", "--project", root, "--port", "7400", "--open"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(spawned[0]).toContain("7400");
    expect(opened).toEqual(["http://127.0.0.1:7400/app"]);
    const state = JSON.parse(readFileSync(statePath(root), "utf8")) as {
      port: number;
    };
    expect(state.port).toBe(7400);
  });

  it("start is idempotent while the plane is alive", async () => {
    const root = trackedRoot();
    const { deps, spawned } = makeDeps();
    const first = await executeControlCli(["start", "--project", root], deps);
    const second = await executeControlCli(["start", "--project", root], deps);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain("already running");
    expect(spawned).toHaveLength(1);
  });

  it("start refuses a busy port owned by another process", async () => {
    const root = trackedRoot();
    const { deps, spawned } = makeDeps({ probe: async () => true });
    const result = await executeControlCli(["start", "--project", root], deps);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Pick another port");
    expect(spawned).toHaveLength(0);
    expect(existsSync(statePath(root))).toBe(false);
  });

  it("start reports failure and cleans up when the child never becomes ready", async () => {
    const root = trackedRoot();
    const { deps, terminated, spawned } = makeDeps({ probe: async () => false });
    const result = await executeControlCli(["start", "--project", root], deps);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("failed to become ready");
    expect(spawned).toHaveLength(1);
    expect(terminated).toHaveLength(1);
    expect(existsSync(statePath(root))).toBe(false);
  });

  it("stop terminates the child and removes state", async () => {
    const root = trackedRoot();
    const { deps, terminated } = makeDeps();
    await executeControlCli(["start", "--project", root], deps);
    const result = await executeControlCli(["stop", "--project", root], deps);
    expect(result.exitCode).toBe(0);
    expect(terminated).toHaveLength(1);
    expect(existsSync(statePath(root))).toBe(false);
  });

  it("stop with no state is a no-op", async () => {
    const root = trackedRoot();
    const { deps } = makeDeps();
    const result = await executeControlCli(["stop", "--project", root], deps);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("nothing to stop");
  });

  it("status --json reports a running plane", async () => {
    const root = trackedRoot();
    const { deps } = makeDeps();
    await executeControlCli(["start", "--project", root], deps);
    const result = await executeControlCli(
      ["status", "--project", root, "--json"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.output) as {
      running: boolean;
      port: number;
      endpointOk: boolean;
    };
    expect(payload.running).toBe(true);
    expect(payload.port).toBe(7332);
    expect(payload.endpointOk).toBe(true);
  });

  it("status clears a stale pid file", async () => {
    const root = trackedRoot();
    mkdirSync(join(root, ".folderforge"), { recursive: true });
    writeFileSync(
      statePath(root),
      JSON.stringify({
        schemaVersion: 1,
        pid: 999999,
        port: 7332,
        projectRoot: root,
        startedAt: new Date().toISOString(),
        version: "0.0.0-test",
      }),
    );
    const { deps } = makeDeps();
    const result = await executeControlCli(
      ["status", "--project", root, "--json"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.output) as { running: boolean };
    expect(payload.running).toBe(false);
    expect(existsSync(statePath(root))).toBe(false);
  });

  it("open launches the browser only when the plane answers", async () => {
    const root = trackedRoot();
    const { deps, opened } = makeDeps();
    const closed = await executeControlCli(["open", "--project", root], deps);
    expect(closed.exitCode).toBe(1);
    expect(opened).toHaveLength(0);
    await executeControlCli(["start", "--project", root], deps);
    const openedResult = await executeControlCli(
      ["open", "--project", root],
      deps,
    );
    expect(openedResult.exitCode).toBe(0);
    expect(opened).toEqual(["http://127.0.0.1:7332/app"]);
  });

  it("rejects unknown commands and invalid ports with usage errors", async () => {
    const { deps } = makeDeps();
    const unknown = await executeControlCli(["dance"], deps);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toContain("Usage: folderforge control");
    const badPort = await executeControlCli(["start", "--port", "abc"], deps);
    expect(badPort.exitCode).toBe(2);
    expect(badPort.output).toContain("Invalid --port");
  });
});
