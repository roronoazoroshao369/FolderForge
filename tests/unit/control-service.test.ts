import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  systemctl: string[][];
  alive: Set<number>;
}

function makeDeps(xdg: string, overrides: Partial<ControlDeps> = {}): FakeHarness {
  const spawned: string[][] = [];
  const systemctl: string[][] = [];
  const alive = new Set<number>();
  let now = 1_000_000;
  const deps: ControlDeps = {
    mainJs: "/fake/dist/main.js",
    version: "9.9.9-test",
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    pidAlive: (pid) => alive.has(pid),
    probe: async () => spawned.length > 0,
    spawnServe: (args) => {
      spawned.push(args);
      const pid = 4300 + spawned.length;
      alive.add(pid);
      return pid;
    },
    terminate: (pid) => {
      alive.delete(pid);
    },
    openUrl: () => {},
    execPath: "/fake/node",
    homeDir: "/tmp/ff-control-nohome",
    // Fake runtime paths count as existing; everything else hits the real fs.
    fileExists: (path) => path.startsWith("/fake/") || existsSync(path),
    execSystemctl: (args) => {
      systemctl.push(args);
      const verb = args[1];
      return {
        exitCode: 0,
        stdout: verb === "is-enabled" ? "enabled\n" : verb === "is-active" ? "active\n" : "",
        stderr: "",
      };
    },
    getEnv: (name) => (name === "XDG_CONFIG_HOME" ? xdg : undefined),
    stdoutIsTty: false,
    platform: "linux",
    ...overrides,
  };
  return { deps, spawned, systemctl, alive };
}

const roots: string[] = [];
function trackedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ff-service-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function writeState(root: string, over: Record<string, unknown> = {}): void {
  mkdirSync(join(root, ".folderforge"), { recursive: true });
  writeFileSync(
    join(root, ".folderforge", "control.json"),
    JSON.stringify({
      schemaVersion: 1,
      pid: 4301,
      port: 7571,
      projectRoot: root,
      startedAt: "2026-09-05T00:00:00.000Z",
      version: "2.8.1",
      ...over,
    }) + "\n",
  );
}

function unitPath(xdg: string): string {
  return join(xdg, "systemd", "user", "folderforge-control.service");
}

describe("folderforge control service", () => {
  it("prints usage without a subcommand and rejects unknown ones", async () => {
    const xdg = trackedRoot();
    const { deps } = makeDeps(xdg);
    const usage = await executeControlCli(["service", "--project", trackedRoot()], deps);
    expect(usage.exitCode).toBe(2);
    expect(usage.output).toContain("install|uninstall|status");
    const unknown = await executeControlCli(
      ["service", "restart", "--project", trackedRoot()],
      deps,
    );
    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toContain("Unknown service command");
  });

  it("rejects --enable/--replace outside `service install`", async () => {
    const xdg = trackedRoot();
    const { deps } = makeDeps(xdg);
    const start = await executeControlCli(["start", "--enable", "--project", trackedRoot()], deps);
    expect(start.exitCode).toBe(2);
    expect(start.output).toContain("only valid with `control service install`");
    const uninstall = await executeControlCli(
      ["service", "uninstall", "--replace", "--project", trackedRoot()],
      deps,
    );
    expect(uninstall.exitCode).toBe(2);
  });

  it("install needs an existing control.json and fails fast on a moved runtime", async () => {
    const xdg = trackedRoot();
    const { deps } = makeDeps(xdg);
    const root = trackedRoot();
    const noState = await executeControlCli(["service", "install", "--project", root], deps);
    expect(noState.exitCode).toBe(1);
    expect(noState.output).toContain("control start");
    expect(existsSync(unitPath(xdg))).toBe(false);

    writeState(root);
    const moved = makeDeps(xdg, { fileExists: () => false });
    const stale = await executeControlCli(["service", "install", "--project", root], moved.deps);
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain("re-run `folderforge control service install`");
  });

  it("refuses non-Linux platforms with a clear message", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    writeState(root);
    const { deps } = makeDeps(xdg, { platform: "darwin" });
    const result = await executeControlCli(["service", "install", "--project", root], deps);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Linux");
  });

  it("install renders the exact serve argv from state, mode 0600, no secrets, no systemctl by default", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    writeState(root, { allow: ["/home/devops/extra dir"] });
    writeFileSync(
      join(root, ".folderforge", "control-auth.json"),
      JSON.stringify({
        mode: "token",
        credential: "secret-marker-abc",
        createdAt: "2026-09-05T00:00:00.000Z",
      }),
    );
    const { deps, systemctl } = makeDeps(xdg);
    const result = await executeControlCli(["service", "install", "--project", root], deps);
    expect(result.exitCode).toBe(0);
    const unit = readFileSync(unitPath(xdg), "utf8");
    expect(unit).toContain("Description=FolderForge Mission Control plane");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(
      `ExecStart=/fake/node /fake/dist/main.js control serve --project ${root} --port 7571 --allow "/home/devops/extra dir"`,
    );
    expect(unit).not.toContain("secret-marker-abc");
    expect(statSync(unitPath(xdg)).mode & 0o777).toBe(0o600);
    expect(systemctl).toHaveLength(0);
    expect(result.output).toContain("systemctl --user enable --now folderforge-control.service");
  });

  it("install --enable runs daemon-reload + enable --now via fixed argv", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    writeState(root);
    const { deps, systemctl } = makeDeps(xdg);
    const result = await executeControlCli(
      ["service", "install", "--enable", "--project", root],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(systemctl).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "folderforge-control.service"],
    ]);
    expect(result.output).toContain("Enabled and started");
  });

  it("install --enable surfaces a systemctl failure", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    writeState(root);
    const { deps } = makeDeps(xdg, {
      execSystemctl: () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Unit folderforge-control.service not found.",
      }),
    });
    const result = await executeControlCli(
      ["service", "install", "--enable", "--project", root],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("systemctl --user daemon-reload failed");
  });

  it("refuses to overwrite another project's unit without --replace", async () => {
    const xdg = trackedRoot();
    const rootA = trackedRoot();
    const rootB = trackedRoot();
    writeState(rootA);
    const { deps } = makeDeps(xdg);
    const first = await executeControlCli(["service", "install", "--project", rootA], deps);
    expect(first.exitCode).toBe(0);
    writeState(rootB);
    const refused = await executeControlCli(["service", "install", "--project", rootB], deps);
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain("--replace");
    expect(refused.output).toContain(rootA);
    const replaced = await executeControlCli(
      ["service", "install", "--replace", "--project", rootB],
      deps,
    );
    expect(replaced.exitCode).toBe(0);
    expect(readFileSync(unitPath(xdg), "utf8")).toContain(`--project ${rootB}`);
  });

  it("reinstall with identical state is idempotent", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    writeState(root);
    const { deps } = makeDeps(xdg);
    const first = await executeControlCli(["service", "install", "--project", root], deps);
    const second = await executeControlCli(["service", "install", "--project", root], deps);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const text = readFileSync(unitPath(xdg), "utf8");
    const third = await executeControlCli(["service", "install", "--project", root], deps);
    expect(third.exitCode).toBe(0);
    expect(readFileSync(unitPath(xdg), "utf8")).toBe(text);
  });

  it("uninstall is idempotent: disable --now + remove + daemon-reload", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    const { deps, systemctl } = makeDeps(xdg);
    const nothing = await executeControlCli(["service", "uninstall", "--project", root], deps);
    expect(nothing.exitCode).toBe(0);
    expect(nothing.output).toContain("not installed");

    writeState(root);
    await executeControlCli(["service", "install", "--project", root], deps);
    expect(existsSync(unitPath(xdg))).toBe(true);
    const gone = await executeControlCli(["service", "uninstall", "--project", root], deps);
    expect(gone.exitCode).toBe(0);
    expect(existsSync(unitPath(xdg))).toBe(false);
    expect(systemctl).toEqual([
      ["--user", "disable", "--now", "folderforge-control.service"],
      ["--user", "daemon-reload"],
    ]);
  });

  it("status reports the unit target and systemd state", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    const { deps } = makeDeps(xdg);
    const missing = await executeControlCli(["service", "status", "--project", root], deps);
    expect(missing.exitCode).toBe(0);
    expect(missing.output).toContain("not installed");

    writeState(root);
    await executeControlCli(["service", "install", "--project", root], deps);
    const result = await executeControlCli(["service", "status", "--project", root], deps);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`project ${root}`);
    expect(result.output).toContain("7571");
    expect(result.output).toContain("enabled=enabled");
    expect(result.output).toContain("active=active");
  });

  it("control status surfaces the boot service in text and --json", async () => {
    const xdg = trackedRoot();
    const root = trackedRoot();
    writeState(root);
    const { deps, alive } = makeDeps(xdg);
    alive.add(4301);
    const text = await executeControlCli(["status", "--project", root], deps);
    expect(text.output).toContain("Boot service: not installed");
    const json = await executeControlCli(["status", "--project", root, "--json"], deps);
    const parsed = JSON.parse(json.output) as { bootService?: string };
    expect(parsed.bootService).toBe("not installed");

    await executeControlCli(["service", "install", "--project", root], deps);
    const after = await executeControlCli(["status", "--project", root], deps);
    expect(after.output).toContain("Boot service: enabled");
  });
});
