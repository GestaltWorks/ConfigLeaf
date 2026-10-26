// Whether the bash on the PATH runs this repository's bash tests (test/journal.test.ts, test/actions.test.ts): it starts,
// it gets this process's stdin and environment, it reads and writes a file at the path node gives it, and it has awk,
// grep, tee and rm. On Windows, `bash` from PowerShell or cmd is often WSL's C:\Windows\System32\bash.exe, which starts
// and sees none of this process's files or variables (measured 26 Oct 2026: the five journal tests failed under it), so
// those tests skip there and say why; Git Bash and a Linux bash, CI's, pass the probe and run them.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The probe's result: ok, or the reason the bash tests skip. */
export interface BashProbe { ok: boolean; reason: string }

function probe(): BashProbe {
  const start = spawnSync("bash", ["-c", "true"], { encoding: "utf8", timeout: 20_000 });
  if (start.error || start.status !== 0) return { ok: false, reason: "no bash runs from the PATH" };
  const dir = mkdtempSync(path.join(tmpdir(), "drift-bash-probe-"));
  try {
    const file = path.join(dir, "probe.txt").split(path.sep).join("/");
    writeFileSync(file, "file-ok");
    const script = '[ -n "$PROBE_FILE" ] || exit 4; command -v awk grep tee rm >/dev/null || exit 3; read -r line; printf "%s %s %s" "$(cat "$PROBE_FILE")" "$line" "$PROBE_ENV"; printf x | tee "$PROBE_FILE.out" >/dev/null';
    const r = spawnSync("bash", ["-c", script], { input: "stdin-ok\n", encoding: "utf8", timeout: 20_000, env: { ...process.env, PROBE_FILE: file, PROBE_ENV: "env-ok" } });
    if (r.status === 0 && r.stdout === "file-ok stdin-ok env-ok" && existsSync(`${file}.out`)) return { ok: true, reason: "" };
    return { ok: false, reason: `the bash on the PATH does not share this process's files and environment, or lacks awk, grep, tee or rm (exit ${r.status ?? "none"}); on Windows that is WSL's bash.exe, and Git Bash runs them` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Probed once per test file that imports it. */
export const BASH: BashProbe = probe();

/** Say once, for `file`, why its bash tests skip; nothing when they run. */
export function sayBashSkip(file: string): void {
  if (!BASH.ok) console.log(`${file}: the bash tests skip: ${BASH.reason}`);
}
