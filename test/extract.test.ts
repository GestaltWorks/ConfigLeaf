import { describe, expect, it } from "vitest";
import { Nightshift } from "../src/adapters/nightshift.ts";

describe("extractJson against the reply shapes Nightshift actually returns", () => {
  it("Ultra: reasoning that quotes the asked-for JSON, then </think>, then the answer", () => {
    const content = 'The user wants exactly the JSON {"ok":true,"who":"<your model family in two words>"} with my model family. Must output exactly that JSON.</think>{"ok":true,"who":"Nemotron Ultra"}';
    expect(Nightshift.extractJson(content)).toEqual({ ok: true, who: "Nemotron Ultra" });
  });

  it("Lightning: bare JSON", () => {
    expect(Nightshift.extractJson('{"ok":true}')).toEqual({ ok: true });
  });

  it("fenced JSON with prose around it", () => {
    expect(Nightshift.extractJson('Sure.\n```json\n{"a":[1,{"b":"}"}]}\n```\nDone.')).toEqual({ a: [1, { b: "}" }] });
  });

  it("prose containing an unparseable brace group before the real object", () => {
    expect(Nightshift.extractJson('see {not json} then {"x":1}')).toEqual({ x: 1 });
  });

  it("returns null when there is no object", () => {
    expect(Nightshift.extractJson("no json here")).toBeNull();
  });
});
