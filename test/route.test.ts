// The default fast route (src/config.ts): the Lightning model is called at NVIDIA's endpoint first and at OpenRouter
// second (measured 26 Oct 2026: 5 of 6 against 1 of 6). src/config.ts is imported afresh with METERLESS_MODEL_FAST and
// METERLESS_FALLBACK_FAST unset and process.loadEnvFile stubbed, so the operator's .env stays out of the defaults:
// modelFast is the NVIDIA id and fallbackFast holds the OpenRouter id alone. .env.example sets the same two values, the
// model line before the fallback line. Offline.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAST_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const FAST_FALLBACK = "openrouter/nvidia/nemotron-3.5-lightning";
const KEYS = ["METERLESS_MODEL_FAST", "METERLESS_FALLBACK_FAST"] as const;
const EXAMPLE = fileURLToPath(new URL("../.env.example", import.meta.url));

const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  vi.resetModules();
  for (const k of KEYS) delete process.env[k];
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

describe("the default fast route", () => {
  it("calls NVIDIA's endpoint first and OpenRouter second when neither variable is set", async () => {
    const { config } = await import("../src/config.ts");
    expect(process.loadEnvFile).toHaveBeenCalled();
    expect(config.nightshift.modelFast).toBe(FAST_MODEL);
    expect(config.nightshift.modelFast.startsWith("nvidia/")).toBe(true);
    expect(config.nightshift.fallbackFast).toEqual([FAST_FALLBACK]);
  });

  it(".env.example sets the same two values, the model line before the fallback line", () => {
    const lines = readFileSync(EXAMPLE, "utf8").split(/\r?\n/);
    const set = lines.flatMap((l) => KEYS.filter((k) => l.startsWith(`${k}=`)).map((k) => [k, l.slice(k.length + 1).trim()]));
    expect(set).toEqual([["METERLESS_MODEL_FAST", FAST_MODEL], ["METERLESS_FALLBACK_FAST", FAST_FALLBACK]]);
  });
});
