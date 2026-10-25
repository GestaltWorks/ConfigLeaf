// LINUX_SSH_CONFIG: the ssh_config file every ssh session reads its aliases from. The collector's session (fetchHost)
// and the write session (runWriteSession) run the same argv, sshArgv: the fixed options, -F <file> when the setting
// names a file, then the alias and bash -s. node:child_process is replaced by a fake that records each spawn, so no
// ssh starts and nothing reaches a network; each case sets LINUX_HOSTS and LINUX_SSH_CONFIG in process.env before a
// fresh import of the modules (Node's loadEnvFile leaves variables already set alone, an empty one included).
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JOURNAL_SHELL } from "../src/collectors/journal.ts";

const spawned: { command: string; args: string[]; stdin: string }[] = [];

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const entry = { command, args: [...args], stdin: "" };
    spawned.push(entry);
    child.stdin.on("data", (b: Buffer) => { entry.stdin += b.toString("utf8"); });
    child.stdin.on("finish", () => setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 0, null); }));
    return child;
  },
}));

const saved = { hosts: process.env.LINUX_HOSTS, sshConfig: process.env.LINUX_SSH_CONFIG };
const FIXED = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const LAB_CONFIG = "lab/ssh_config.local";

async function load(sshConfig: string) {
  vi.resetModules();
  process.env.LINUX_HOSTS = "lab-a=/var/backups/export";
  process.env.LINUX_SSH_CONFIG = sshConfig;
  const linux = await import("../src/collectors/linux.ts");
  const ssh = await import("../src/actions/ssh.ts");
  return { linux, ssh };
}

beforeEach(() => { spawned.length = 0; });
afterAll(() => {
  for (const [k, v] of [["LINUX_HOSTS", saved.hosts], ["LINUX_SSH_CONFIG", saved.sshConfig]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe("LINUX_SSH_CONFIG on every ssh session", () => {
  it("sshArgv: -F <file> before the alias when a file is named, the fixed options alone when blank", async () => {
    const { linux } = await load("");
    expect(linux.sshArgv("lab-a", "")).toEqual([...FIXED, "lab-a", "bash", "-s"]);
    expect(linux.sshArgv("lab-a", LAB_CONFIG)).toEqual([...FIXED, "-F", LAB_CONFIG, "lab-a", "bash", "-s"]);
    // the trace line names the setting, never a path of this machine
    expect(linux.sshSummary("lab-a", LAB_CONFIG)).toBe("ssh -o BatchMode=yes -o ConnectTimeout=15 -F <LINUX_SSH_CONFIG> lab-a bash -s");
    expect(linux.sshSummary("lab-a", "")).toBe("ssh -o BatchMode=yes -o ConnectTimeout=15 lab-a bash -s");
  });

  it("without LINUX_SSH_CONFIG, the collector and the write session spawn ssh with no -F: the user's own ssh_config", async () => {
    const { linux, ssh } = await load("");
    expect(linux.SSH_CONFIG).toBe("");
    await linux.fetchHost("lab-a");
    await ssh.runWriteSession("lab-a", "echo write\n");
    expect(spawned.map((s) => s.command)).toEqual(["ssh", "ssh"]);
    for (const s of spawned) expect(s.args).toEqual([...FIXED, "lab-a", "bash", "-s"]);
    expect(spawned[0].stdin).toBe(linux.readScript("/var/backups/export"));
    expect(spawned[1].stdin).toBe("echo write\n");
  });

  it("with LINUX_SSH_CONFIG, both sessions add -F <file> before the alias, and the read script names sudo only in its journal section", async () => {
    const { linux, ssh } = await load(LAB_CONFIG);
    expect(linux.SSH_CONFIG).toBe(LAB_CONFIG);
    await linux.fetchHost("lab-a");
    await ssh.runWriteSession("lab-a", "echo write\n");
    for (const s of spawned) expect(s.args).toEqual([...FIXED, "-F", LAB_CONFIG, "lab-a", "bash", "-s"]);
    expect(spawned[0].stdin).toContain(JOURNAL_SHELL);
    expect(spawned[0].stdin.replace(JOURNAL_SHELL, "")).not.toMatch(/\bsudo\b/);
  });

  it("an alias LINUX_HOSTS does not list starts no session, whatever ssh_config is named", async () => {
    const { linux, ssh } = await load(LAB_CONFIG);
    expect(() => linux.fetchHost("other-host")).toThrow(/unknown host alias/);
    await expect(ssh.runWriteSession("other-host", "echo write\n")).rejects.toThrow(/unknown host alias/);
    expect(spawned).toEqual([]);
  });
});
