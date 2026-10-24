// Zetaris engine: the live path. Wraps the measured REST adapter; the only engine-specific part is
// naming: schema tables live in the registered datasource, so {{t:observation}} renders as
// <ZETARIS_DATASOURCE>.observation. One SELECT per call, no bound parameters (layer.ts renders them).

import { Zetaris, type QueryResult } from "../../adapters/zetaris.ts";
import { config } from "../../config.ts";
import type { Engine, RunOptions } from "../layer.ts";

export class ZetarisEngine implements Engine {
  readonly name = "zetaris" as const;

  constructor(private readonly client: Zetaris = new Zetaris()) {}

  qualify(table: string): string {
    return `${config.zetaris.datasource}.${table}`;
  }

  run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.client.query(sql, opts);
  }
}
