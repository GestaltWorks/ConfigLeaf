// A fake host for the write session (src/actions/ssh.ts): it reads the script's own inputs (the quoted path, EXPECT,
// COPY, the two base64 heredocs or the rm of put_previous) and plays its steps against an in-memory file table, printing
// the markers and sections the script prints. Knobs: sudo asks for a password, nginx -t refuses, the reload fails, the
// path is a symlink, the session dies before the script reports. Every script it was handed is kept, so a test asserts
// on the text that would have gone over ssh.
import { createHash } from "node:crypto";
import type { SessionResult, SshRunner } from "../../../src/actions/ssh.ts";

const MARK = "@@DRIFT@@";
const hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export interface FakeHostOptions {
  sudo?: "ok" | "password";
  nginxT?: "ok" | "refuse";
  reload?: "ok" | "fail";
  link?: boolean;
  /** The session ends with this exit code and no output. */
  dies?: number;
}

export class FakeHost {
  readonly files = new Map<string, Buffer>();
  readonly scripts: { alias: string; script: string }[] = [];
  /** Every write the host saw, in order: the path and the sha256 written, or "removed". */
  readonly writes: string[] = [];
  constructor(public opts: FakeHostOptions = {}) {}

  readonly run: SshRunner = async (alias, script): Promise<SessionResult> => {
    this.scripts.push({ alias, script });
    if (this.opts.dies !== undefined) return { stdout: "", stderr: "ssh: connect to host port 22: Connection timed out\n", code: this.opts.dies };
    const path = unquote(script.match(/^P=('(?:[^']|'\\'')*')$/m)![1]);
    const expect = script.match(/^EXPECT='([^']*)'$/m)![1];
    const copy = Buffer.from(heredoc(script, "DRIFT_COPY")!, "base64");
    const prevText = heredoc(script, "DRIFT_PREVIOUS");
    const previous = prevText === null ? null : Buffer.from(prevText, "base64");
    if (prevText === null && !/put_previous\(\) \{ sudo -n rm -f -- "\$P"; \}/.test(script)) throw new Error("fake host: put_previous is neither a heredoc nor an rm");
    const out: string[] = [];
    const mark = (s: string) => out.push(`${MARK} ${s}`);
    const hashOf = (): string => (this.files.has(path) ? hex(this.files.get(path)!) : "absent");
    const section = (name: string, rc: number, output: string) => { mark(`BEGIN ${name}`); out.push(output); mark(`END ${rc}`); return rc === 0; };
    const restore = () => {
      if (previous === null) { this.files.delete(path); this.writes.push(`${path} removed`); } else { this.files.set(path, previous); this.writes.push(`${path} ${hex(previous)}`); }
      section("restore", 0, "");
      mark(`RESTORED ${hashOf()}`);
    };
    const done = (): SessionResult => { mark("DONE"); return { stdout: `${out.join("\n")}\n`, stderr: "", code: 0 }; };

    if (this.opts.link) { mark("LINK"); return done(); }
    const before = hashOf();
    mark(`BEFORE ${before}`);
    if (before !== expect) { mark("CHANGED"); return done(); }
    if (this.opts.sudo === "password") { section("write", 1, "sudo: a password is required"); return done(); }
    this.files.set(path, copy);
    this.writes.push(`${path} ${hex(copy)}`);
    section("write", 0, "");
    mark(`WRITTEN ${hashOf()}`);
    if (this.opts.nginxT === "refuse") {
      section("nginx-t", 1, `nginx: [emerg] unknown directive "proxy_pas" in ${path}:5\nnginx: configuration file /etc/nginx/nginx.conf test failed`);
      restore();
      return done();
    }
    section("nginx-t", 0, "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful");
    if (this.opts.reload === "fail") {
      section("reload", 1, "Job for nginx.service failed because the control process exited with error code.");
      restore();
      return done();
    }
    section("reload", 0, "");
    mark(`AFTER ${hashOf()}`);
    return done();
  };
}

function unquote(q: string): string {
  return q.slice(1, -1).replace(/'\\''/g, "'");
}

function heredoc(script: string, delim: string): string | null {
  const m = script.match(new RegExp(`<<'${delim}' \\| sudo -n tee -- "\\$P" >/dev/null\\n([\\s\\S]*?)\\n${delim}\\n`));
  return m ? m[1].replace(/\n/g, "") : null;
}
