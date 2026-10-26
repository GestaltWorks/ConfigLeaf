// What a CLI entry point runs first, before it prints or reads anything: the configured values the modules read when
// they need them (src/config.ts, PASS_CONCURRENCY), checked once, so an invalid one is one plain line on stderr and exit 2,
// a usage error, never a stack trace. The modules themselves only throw ConfigError; ending the process is the entry point's.

import { ConfigError, config } from "./config.ts";

/** Read every value checked at startup; on a ConfigError write its message as one line on stderr and exit 2. Any other error is thrown. */
export function exitOnConfigError(): void {
  try {
    void config.passConcurrency;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
}
