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
  spawnedEnv: Array<Record<string, string> | undefined>;
  opened: string[];
  terminated: number[];
  alive: Set<number>;
}

function makeDeps(overrides: Partial<ControlDeps> = {}): FakeHarness {
  const spawned: string[][] = [];
  const spawnedEnv: Array<Record<string, string> | undefined> = [];
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
    spawnServe: (args, _logPath, env) => {
      spawned.push(args);
      spawnedEnv.push(env);
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
  return { deps, spawned, spawnedEnv, opened, terminated, alive };
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

  it("start forwards --allow roots to the serve child and persists them in state", async () => {
    const root = trackedRoot();
    const { deps, spawned } = makeDeps();
    const result = await executeControlCli(
      ["start", "--project", root, "--allow", "/data/alpha", "--allow", "/data/beta"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    const args = spawned[0] ?? [];
    const forwarded = args.flatMap((a, i) => (a === "--allow" ? [args[i + 1]] : []));
    expect(forwarded).toEqual(["/data/alpha", "/data/beta"]);
    const state = JSON.parse(readFileSync(statePath(root), "utf8")) as { allow?: string[] };
    expect(state.allow).toEqual(["/data/alpha", "/data/beta"]);
  });

  it("start --watchdog spawns a detached watchdog and records its pid", async () => {
    const root = trackedRoot();
    const { deps, spawned } = makeDeps();
    const result = await executeControlCli(["start", "--project", root, "--watchdog"], deps);
    expect(result.exitCode).toBe(0);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toContain("watch");
    const state = JSON.parse(readFileSync(statePath(root), "utf8")) as { watchdogPid?: number };
    expect(state.watchdogPid).toBe(4202);
  });

  it("watch restarts a hung plane after 3 failed probes, then exits when state is removed", async () => {
    const root = trackedRoot();
    mkdirSync(join(root, ".folderforge"), { recursive: true });
    writeFileSync(
      statePath(root),
      JSON.stringify({
        schemaVersion: 1,
        pid: 4201,
        port: 7332,
        projectRoot: root,
        startedAt: "2026-08-27T00:00:00.000Z",
        version: "0.0.0-test",
        allow: ["/data/x"],
      }),
    );
    let respawned = false;
    const respawnedArgs: string[][] = [];
    const harness = makeDeps({
      probe: async () => {
        // After the respawn, simulate a deliberate `control stop` (state removed).
        if (respawned) rmSync(statePath(root), { force: true });
        return false;
      },
      spawnServe: (args) => {
        respawned = true;
        respawnedArgs.push(args);
        harness.alive.add(4299);
        return 4299;
      },
    });
    harness.alive.add(4201);
    const result = await executeControlCli(["watch", "--project", root], harness.deps);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("restarts performed: 1");
    expect(harness.terminated).toEqual([4201]);
    expect(respawnedArgs).toHaveLength(1);
    expect(respawnedArgs[0]).toEqual(
      expect.arrayContaining(["control", "serve", "--port", "7332", "--allow", "/data/x"]),
    );
  });

  it("stop terminates the watchdog before the plane", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    await executeControlCli(["start", "--project", root, "--watchdog"], harness.deps);
    const result = await executeControlCli(["stop", "--project", root], harness.deps);
    expect(result.exitCode).toBe(0);
    expect(harness.terminated).toEqual([4202, 4201]);
  });

  function authPath(root: string): string {
    return join(root, ".folderforge", "control-auth.json");
  }

  it("start --auth token writes a credential file and prints a signed dynamic link", async () => {
    const root = trackedRoot();
    const { deps, spawned } = makeDeps();
    const result = await executeControlCli(
      ["start", "--project", root, "--auth", "token", "--no-open"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    const auth = JSON.parse(readFileSync(authPath(root), "utf8")) as {
      mode: string;
      credential: string;
    };
    expect(auth.mode).toBe("token");
    expect(auth.credential.length).toBeGreaterThan(20);
    expect(result.output).toContain(`/app?token=${auth.credential}`);
    // The credential never enters the serve child's argv (no `ps` leak).
    expect(spawned[0]?.join(" ")).not.toContain(auth.credential);
    const state = JSON.parse(readFileSync(statePath(root), "utf8")) as {
      auth?: { mode: string };
    };
    expect(state.auth?.mode).toBe("token");
  });

  it("auth api-key on a running plane mints a fresh credential and restarts the plane", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    await executeControlCli(
      ["start", "--project", root, "--auth", "token", "--no-open"],
      harness.deps,
    );
    const before = JSON.parse(readFileSync(authPath(root), "utf8")) as {
      credential: string;
    };
    const result = await executeControlCli(
      ["auth", "api-key", "--project", root],
      harness.deps,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("api-key");
    const after = JSON.parse(readFileSync(authPath(root), "utf8")) as {
      mode: string;
      credential: string;
    };
    expect(after.mode).toBe("api-key");
    expect(after.credential).not.toBe(before.credential);
    expect(harness.terminated).toEqual([4201]);
    expect(harness.spawned).toHaveLength(2);
    const state = JSON.parse(readFileSync(statePath(root), "utf8")) as {
      pid: number;
      auth?: { mode: string };
    };
    expect(state.pid).toBe(4202);
    expect(state.auth?.mode).toBe("api-key");
  });

  it("auth none on a stopped plane clears the credential for the next start", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    await executeControlCli(
      ["start", "--project", root, "--auth", "token", "--no-open"],
      harness.deps,
    );
    expect(existsSync(authPath(root))).toBe(true);
    await executeControlCli(["stop", "--project", root], harness.deps);
    const result = await executeControlCli(["auth", "none", "--project", root], harness.deps);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("next `control start`");
    expect(existsSync(authPath(root))).toBe(false);
    expect(harness.spawned).toHaveLength(1); // no restart spawn
  });

  it("start --openai-tunnel supervises the ChatGPT tunnel and stop kills it", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    harness.deps.getEnv = (name) =>
      name === "CONTROL_PLANE_API_KEY" ? "sk-test" : undefined;
    const result = await executeControlCli(
      [
        "start",
        "--project",
        root,
        "--no-open",
        "--openai-tunnel",
        "--tunnel-id",
        "tunnel_0123456789abcdef0123456789abcdef",
      ],
      harness.deps,
    );
    expect(result.exitCode).toBe(0);
    expect(harness.spawned).toHaveLength(2);
    const tunnelArgs = harness.spawned[1] ?? [];
    expect(tunnelArgs.slice(1, 4)).toEqual(["connect", "chatgpt", "--openai-tunnel"]);
    expect(tunnelArgs).toContain("--tunnel-id");
    expect(tunnelArgs).toContain("--no-dashboard");
    expect(tunnelArgs.join(" ")).not.toContain("sk-test"); // key value stays in the env
    const state = JSON.parse(readFileSync(statePath(root), "utf8")) as {
      openaiTunnel?: { pid: number; tunnelId: string; apiKeyEnv: string };
    };
    expect(state.openaiTunnel?.tunnelId).toBe("tunnel_0123456789abcdef0123456789abcdef");
    expect(state.openaiTunnel?.apiKeyEnv).toBe("CONTROL_PLANE_API_KEY");
    expect(result.output).toContain("ChatGPT tunnel");
    const stop = await executeControlCli(["stop", "--project", root], harness.deps);
    expect(stop.exitCode).toBe(0);
    expect(harness.terminated).toEqual([4202, 4201]); // tunnel supervisor, then the plane
  });

  it("start --openai-tunnel reuses the tunnel config saved in Mission Control", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    harness.deps.getEnv = (name) => (name === "MY_GPT_KEY" ? "sk-test" : undefined);
    mkdirSync(join(root, ".folderforge"), { recursive: true });
    writeFileSync(
      join(root, ".folderforge", "openai-tunnel-config.json"),
      JSON.stringify({
        tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        apiKeyEnv: "MY_GPT_KEY",
        linkedAt: new Date().toISOString(),
      }),
    );
    const result = await executeControlCli(
      ["start", "--project", root, "--no-open", "--openai-tunnel"],
      harness.deps,
    );
    expect(result.exitCode).toBe(0);
    const tunnelArgs = harness.spawned[1] ?? [];
    expect(tunnelArgs).toContain("tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(tunnelArgs).toContain("MY_GPT_KEY");
  });

  it("start --openai-tunnel injects the app-saved key into the tunnel child env when the var is unset", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    harness.deps.getEnv = () => undefined; // nothing exported anywhere
    mkdirSync(join(root, ".folderforge"), { recursive: true });
    writeFileSync(
      join(root, ".folderforge", "openai-tunnel-config.json"),
      JSON.stringify({
        tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        apiKeyEnv: "MY_GPT_KEY",
        apiKey: "sk-stored-secret",
        linkedAt: new Date().toISOString(),
      }),
    );
    const result = await executeControlCli(
      ["start", "--project", root, "--no-open", "--openai-tunnel"],
      harness.deps,
    );
    expect(result.exitCode).toBe(0);
    expect(harness.spawned).toHaveLength(2);
    expect(harness.spawnedEnv[1]).toEqual({ MY_GPT_KEY: "sk-stored-secret" });
    // The key still never enters argv (no `ps` leak).
    expect(harness.spawned[1]?.join(" ")).not.toContain("sk-stored-secret");
  });

  it("stop also terminates an app-started tunnel supervisor from the shared store", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    await executeControlCli(["start", "--project", root, "--no-open"], harness.deps);
    mkdirSync(join(root, ".folderforge"), { recursive: true });
    writeFileSync(
      join(root, ".folderforge", "openai-tunnel-config.json"),
      JSON.stringify({
        tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        apiKeyEnv: "CONTROL_PLANE_API_KEY",
        linkedAt: new Date().toISOString(),
        supervisorPid: 4399,
      }),
    );
    harness.alive.add(4399);
    const result = await executeControlCli(["stop", "--project", root], harness.deps);
    expect(result.exitCode).toBe(0);
    expect(harness.terminated).toContain(4399);
    const stored = JSON.parse(
      readFileSync(join(root, ".folderforge", "openai-tunnel-config.json"), "utf8"),
    ) as { supervisorPid?: number };
    expect(stored.supervisorPid).toBeUndefined();
  });

  it("start --openai-tunnel fails fast when the API-key env var is missing", async () => {
    const root = trackedRoot();
    const harness = makeDeps();
    harness.deps.getEnv = () => undefined;
    const result = await executeControlCli(
      [
        "start",
        "--project",
        root,
        "--openai-tunnel",
        "--tunnel-id",
        "tunnel_0123456789abcdef0123456789abcdef",
      ],
      harness.deps,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("CONTROL_PLANE_API_KEY");
    expect(harness.spawned).toHaveLength(0);
  });

  it("rejects a malformed tunnel id with a usage error", async () => {
    const { deps } = makeDeps();
    const result = await executeControlCli(
      ["start", "--openai-tunnel", "--tunnel-id", "abc"],
      deps,
    );
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("--tunnel-id");
  });
});
