// Model effects: what reaches a provider's API, what happens when this runner has no key, and which keys
// a runner somewhere else (a door, a CI job) needs from this machine. Also where each key goes and which
// hosts a system's effects declare, which together are a door's network policy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testAtoll, type TestAtoll } from "../../src/testing.ts";
import { checkSystem, defineSystem, type SystemSpec } from "../../src/index.ts";
import { perform, type EffectEnv } from "../../src/runtime/effects.ts";
import { HttpModels, keyRoutes, modelHost, ModelUnavailable, modelKey, planModelKeys, StandInModels } from "../../src/runtime/models.ts";
import { declaredHosts, validateSystem } from "../../src/system.ts";
import type { OutboxEntry } from "../../src/format.ts";

const KEY = "sk-ant-test-0123456789abcdef";

/** A reader that asks a model to summarize what it's sent, with the effect declared as given. */
function readerSystem(summarize: Record<string, unknown>): SystemSpec {
  return defineSystem({
    name: "reader",
    owner: { timezone: "UTC" },
    parts: {
      reader: {
        purpose: "Ask a model to summarize what I send",
        on: {
          read: (t, e) => {
            t.effect("summarize", { prompt: e.body.text }, { then: "summarized" });
            t.wait({ for: "summarized", reason: "the summary" });
          },
          summarized: (t, e) => {
            t.write("last.json", e.body);
            t.wait({ for: "read", reason: "the next thing to summarize" });
          },
        },
      },
    },
    effects: {
      summarize: { kind: "model", model: "anthropic/claude-haiku-5-5", maxUsd: 0.01, budget: { usd: 1, calls: 10, per: "month" }, ...summarize } as any,
    },
  });
}

let s: TestAtoll | undefined;
let saved: Record<string, string | undefined>;
let requests: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // No model key reaches these tests unless one sets it, and no request may leave the machine.
  saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  requests = vi.fn(async () => {
    throw new Error("no request should leave this test");
  });
  vi.stubGlobal("fetch", requests);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await s?.close();
  s = undefined;
});

async function summarizeOnce(system: SystemSpec, options: Parameters<typeof testAtoll>[1] = {}) {
  s = await testAtoll(system, { realEffects: true, ...options });
  await s.send("reader", "read", { text: "Summarize this, please." });
  const report = await s.tick();
  const effect = (await s.journal()).find((r) => r.kind === "effect" && ["done", "failed"].includes((r as any).state)) as any;
  return { report, last: await s.json("parts/reader/last.json"), effect };
}

describe("a model effect on a runner without its key", () => {
  it("fails and names the key when it has no stand-in, sends nothing, and charges nothing", async () => {
    const { report, last, effect } = await summarizeOnce(readerSystem({}));
    expect(last).toMatchObject({ ok: false, name: "summarize", error: "ANTHROPIC_API_KEY is not set in the runner's environment" });
    expect(last.result).toBeUndefined();
    expect(report.effects).toMatchObject({ done: 0, failed: 1 });
    expect(effect).toMatchObject({ state: "failed", error: "ANTHROPIC_API_KEY is not set in the runner's environment" });
    expect(effect.cost).toBeUndefined();
    expect(requests).not.toHaveBeenCalled();
  });

  it("answers with its stand-in when it has one, and the answer says so", async () => {
    const { last, effect } = await summarizeOnce(readerSystem({ standIn: () => ({ summary: "a stand-in summary" }) }));
    expect(last).toMatchObject({ ok: true, result: { standIn: true, model: "stand-in", json: { summary: "a stand-in summary" } } });
    expect(effect.cost).toEqual({ calls: 1, usd: 0 });
    expect(requests).not.toHaveBeenCalled();
  });

  it("on a runner told to use stand-ins only, fails one that has none instead of answering with nothing", async () => {
    process.env.ANTHROPIC_API_KEY = KEY;
    const { last, effect } = await summarizeOnce(readerSystem({}), { models: new StandInModels() });
    expect(last).toMatchObject({ ok: false, error: "This runner answers model effects only with their stand-ins, and this one has none, so anthropic/claude-haiku-5-5 wasn't called" });
    expect(effect.cost).toBeUndefined();
    expect(requests).not.toHaveBeenCalled();
  });
});

/** A fetch that records what it's asked and answers with `status` and `body`. */
function recorder(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("HttpModels, the plain fetch calls behind model effects", () => {
  it("calls Anthropic's Messages API with the key only in its header", async () => {
    const { calls, fetcher } = recorder(200, { model: "claude-haiku-5-5", content: [{ type: "text", text: '```json\n{"summary":"short"}\n```' }], usage: { input_tokens: 12, output_tokens: 5 } });
    const response = await new HttpModels({ ANTHROPIC_API_KEY: KEY }, fetcher).complete({ model: "anthropic/claude-haiku-5-5", system: "Be brief.", prompt: "Summarize this.", schema: { type: "object" }, maxTokens: 300 });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 300,
      system: "Be brief.",
      messages: [{ role: "user", content: 'Summarize this.\n\nAnswer with only a JSON value that matches this JSON schema:\n{"type":"object"}' }],
    });
    expect(String(init.body)).not.toContain(KEY);
    expect(response).toEqual({ text: '```json\n{"summary":"short"}\n```', json: { summary: "short" }, model: "claude-haiku-5-5", usage: { inputTokens: 12, outputTokens: 5 } });
  });

  it("calls OpenAI's Chat Completions API with a bearer token, asking for JSON when there's a schema", async () => {
    const { calls, fetcher } = recorder(200, { model: "gpt-5.4-mini", choices: [{ message: { content: '{"summary":"short"}' } }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
    const models = new HttpModels({ OPENAI_API_KEY: "sk-openai-test" }, fetcher);
    const response = await models.complete({ model: "openai/gpt-5.4-mini", system: "Be brief.", prompt: "Summarize this.", schema: { type: "object" } });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer sk-openai-test" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-5.4-mini",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: expect.stringContaining("Answer with only a JSON value") }],
      response_format: { type: "json_object" },
    });
    expect(response).toMatchObject({ json: { summary: "short" }, model: "gpt-5.4-mini", usage: { inputTokens: 9, outputTokens: 4 } });
    await models.complete({ model: "openai/gpt-5.4-mini", prompt: "No schema." });
    expect(JSON.parse(String(calls[1]!.init.body))).not.toHaveProperty("response_format");
  });

  it("counts a refused request as a call, and a missing key as none", async () => {
    const entry = { id: "fx-1", key: "k-1", name: "summarize", args: { prompt: "Summarize this." } } as unknown as OutboxEntry;
    const spec = { kind: "model", model: "anthropic/claude-haiku-5-5", maxUsd: 0.01 } as const;
    const env = (models: HttpModels): EffectEnv => ({ store: {} as EffectEnv["store"], models, fetch: requests as unknown as typeof fetch, now: () => new Date("2026-11-05T00:00:00Z"), env: { ANTHROPIC_API_KEY: KEY } });

    const { fetcher } = recorder(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const refused = await perform(entry, spec, env(new HttpModels({ ANTHROPIC_API_KEY: KEY }, fetcher)));
    expect(refused).toMatchObject({ ok: false, error: "Anthropic returned 401: invalid x-api-key", cost: { calls: 1 } });

    const unset = await perform(entry, spec, env(new HttpModels({}, fetcher)));
    expect(unset).toEqual({ ok: false, error: "ANTHROPIC_API_KEY is not set in the runner's environment", evidence: [] });
    await expect(new HttpModels({}, fetcher).complete({ model: "mistral/large", prompt: "x" })).rejects.toBeInstanceOf(ModelUnavailable);
  });
});

/** A system whose one part only waits, declaring the effects a test looks at. */
function withEffects(name: string, effects: Record<string, unknown>): SystemSpec {
  return defineSystem({
    name,
    parts: { holder: { purpose: "Hold the effects this test looks at", on: { poke: (t) => t.wait({ for: "poke", reason: "the next poke" }) } } },
    effects: effects as SystemSpec["effects"],
  });
}

describe("the keys a runner somewhere else needs", () => {
  const system = withEffects("mixed", {
    extract: { kind: "model", model: "anthropic/claude-opus-5-5", standIn: () => ({}), budget: { usd: 1, per: "month" } },
    summarize: { kind: "model", model: "anthropic/claude-haiku-5-5", budget: { usd: 1, per: "month" } },
    draft: { kind: "model", model: "openai/gpt-5.4-mini", standIn: () => ({}), budget: { usd: 1, per: "month" } },
    always: { kind: "model", model: "stand-in", standIn: () => ({}), budget: { usd: 1, per: "month" } },
    page: { kind: "http", allow: ["example.com"] },
  });

  it("hands over only the keys the code's model effects use, and sorts the rest by whether they have a stand-in", () => {
    expect(planModelKeys(system, { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "  ", ARCHIL_API_KEY: "never-this" })).toEqual({
      env: { ANTHROPIC_API_KEY: KEY },
      calls: [{ key: "ANTHROPIC_API_KEY", effects: ["extract", "summarize"] }],
      standIns: [{ key: "OPENAI_API_KEY", effects: ["draft"] }],
      missing: [],
    });
    expect(planModelKeys(system, {})).toEqual({
      env: {},
      calls: [],
      standIns: [
        { key: "ANTHROPIC_API_KEY", effects: ["extract"] },
        { key: "OPENAI_API_KEY", effects: ["draft"] },
      ],
      missing: [{ key: "ANTHROPIC_API_KEY", effects: ["summarize"] }],
    });
    const anthropicOnly = withEffects("anthropic-only", { extract: { kind: "model", model: "anthropic/claude-opus-5-5", budget: { usd: 1, per: "month" } } });
    expect(planModelKeys(anthropicOnly, { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-openai-test" }).env).toEqual({ ANTHROPIC_API_KEY: KEY });
  });

  it("knows where each key goes, so a door can leave it with Archil: one host, in the headers the runner sends it in", async () => {
    expect(keyRoutes({ ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-openai-test" })).toEqual([
      { name: "ANTHROPIC_API_KEY", value: KEY, host: "api.anthropic.com", headers: { "x-api-key": KEY } },
      { name: "OPENAI_API_KEY", value: "sk-openai-test", host: "api.openai.com", headers: { authorization: "Bearer sk-openai-test" } },
    ]);
    expect(keyRoutes(planModelKeys(system, { ANTHROPIC_API_KEY: KEY }).env).map((route) => route.name)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(keyRoutes({})).toEqual([]);
    expect(modelHost("ANTHROPIC_API_KEY")).toBe("api.anthropic.com");
    expect(modelHost("OPENAI_API_KEY")).toBe("api.openai.com");

    // A door's runner holds a placeholder for the key. Its call goes to the route's host with the
    // placeholder in exactly the headers the route names, which are the ones Archil overwrites.
    for (const [model, name] of [["anthropic/claude-haiku-5-5", "ANTHROPIC_API_KEY"], ["openai/gpt-5.4-mini", "OPENAI_API_KEY"]] as const) {
      const { calls, fetcher } = recorder(200, {});
      await new HttpModels({ [name]: "brokered-by-archil" }, fetcher).complete({ model, prompt: "x" });
      const route = keyRoutes({ [name]: "the-real-key" })[0]!;
      expect(new URL(calls[0]!.url).hostname).toBe(route.host);
      const sent = calls[0]!.init.headers as Record<string, string>;
      for (const [header, value] of Object.entries(route.headers)) expect(sent[header], header).toBe(value.replace("the-real-key", "brokered-by-archil"));
      expect(Object.values(sent).filter((value) => value.includes("brokered-by-archil"))).toHaveLength(Object.keys(route.headers).length);
    }
  });

  it("lists the hosts a system's effects declare, whatever their kind, each once", () => {
    expect(declaredHosts(system)).toEqual(["example.com"]);
    const more = withEffects("more", {
      page: { kind: "http", allow: ["registry.npmjs.org", "*.example.com"] },
      send: { kind: "custom", allow: ["hooks.example.net", "registry.npmjs.org"], run: () => null },
      build: { kind: "exec", allow: ["github.com"] },
      extract: { kind: "model", model: "anthropic/claude-opus-5-5", standIn: () => ({}), budget: { usd: 1, per: "month" } },
    });
    expect(validateSystem(more)).toEqual([]);
    expect(declaredHosts(more)).toEqual(["registry.npmjs.org", "*.example.com", "hooks.example.net", "github.com"]);
    expect(declaredHosts(withEffects("none", {}))).toEqual([]);
  });

  it("knows which key a model takes, and `atoll check` refuses a model it couldn't call", () => {
    expect(modelKey("anthropic/claude-opus-5-5")).toBe("ANTHROPIC_API_KEY");
    expect(modelKey("openai/gpt-5.4-mini")).toBe("OPENAI_API_KEY");
    for (const name of ["anthropic/", "antropic/claude-opus-5-5", "claude-opus-5-5", "stand-in", "", undefined]) expect(modelKey(name), String(name)).toBeNull();

    expect(checkSystem(system)).toEqual([]);
    const typo = withEffects("typo", { extract: { kind: "model", model: "antropic/claude-opus-5-5", standIn: () => ({}), budget: { usd: 1, per: "month" } } });
    expect(checkSystem(typo)).toEqual([expect.objectContaining({ severity: "error", code: "BAD_MODEL", where: "effects.extract" })]);
    const nothing = withEffects("nothing", { extract: { kind: "model", model: "stand-in", budget: { usd: 1, per: "month" } } });
    expect(checkSystem(nothing)).toEqual([expect.objectContaining({ severity: "error", code: "MODEL_WITHOUT_MODEL", where: "effects.extract" })]);
  });
});
