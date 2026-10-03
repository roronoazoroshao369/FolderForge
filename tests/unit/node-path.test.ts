import { delimiter, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRuntimeNodeOnPath } from "../../src/runtime/node-path.js";

describe("ensureRuntimeNodeOnPath", () => {
  it("prepends the active runtime bin when PATH resolves node elsewhere", () => {
    const env = { PATH: ["/usr/local/bin", "/usr/bin"].join(delimiter) };
    const execPath = "/home/devops/.nvm/versions/node/v22.23.0/bin/node";

    expect(ensureRuntimeNodeOnPath(env, execPath)).toBe(
      [dirname(execPath), "/usr/local/bin", "/usr/bin"].join(delimiter),
    );
  });

  it("does not duplicate an existing runtime bin", () => {
    const execPath = "/opt/node/bin/node";
    const env = { PATH: [dirname(execPath), "/usr/bin"].join(delimiter) };

    expect(ensureRuntimeNodeOnPath(env, execPath)).toBe(env.PATH);
    expect(env.PATH.split(delimiter).filter((entry) => entry === dirname(execPath))).toHaveLength(1);
  });

  it("initializes an empty PATH with the active runtime bin", () => {
    const env: NodeJS.ProcessEnv = {};
    const execPath = "/opt/node/bin/node";

    expect(ensureRuntimeNodeOnPath(env, execPath)).toBe(dirname(execPath));
    expect(env.PATH).toBe(dirname(execPath));
  });
});
