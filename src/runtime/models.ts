// Model providers for `model` effects. The runner never needs one: a model effect with a `standIn`
// answers deterministically, and says so in its result. Real providers are plain fetch calls, so no
// model SDK is a dependency, and keys come only from the runner's environment.

import type { SystemSpec } from "../system.ts";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types.ts";

/** The environment variable that holds each provider's key, by the prefix of a model's name. */
export const MODEL_KEYS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" } as const;
export type ModelKey = (typeof MODEL_KEYS)[keyof typeof MODEL_KEYS];

/** Where each key goes: the one host it is sent to, and the request headers that carry it. */
const KEY_ROUTES: Record<ModelKey, { host: string; headers: (key: string) => Record<string, string> }> = {
  ANTHROPIC_API_KEY: { host: "api.anthropic.com", headers: (key) => ({ "x-api-key": key }) },
  OPENAI_API_KEY: { host: "api.openai.com", headers: (key) => ({ authorization: `Bearer ${key}` }) },
};

/** The host a model key is sent to. */
export function modelHost(key: ModelKey): string {
  return KEY_ROUTES[key].host;
}

/**
 * A model key with its route. A door on a plan with network policies gives this to Archil, which sets
 * `headers` on the door's requests to `host`, so the door itself never holds `value`.
 */
export interface KeyRoute {
  name: ModelKey;
  value: string;
  host: string;
  headers: Record<string, string>;
}

/** The route of each key in `env`, which is a plan's `env`: the keys a system's models use, set here. */
export function keyRoutes(env: Partial<Record<ModelKey, string>>): KeyRoute[] {
  return (Object.entries(env) as [ModelKey, string][]).map(([name, value]) => ({ name, value, host: KEY_ROUTES[name].host, headers: KEY_ROUTES[name].headers(value) }));
}

/** The key a model needs ("anthropic/<model>" needs ANTHROPIC_API_KEY), or null for a name Atoll can't call. */
export function modelKey(model: string | undefined): ModelKey | null {
  const match = /^([a-z]+)\/(.+)$/.exec(model ?? "");
  if (!match) return null;
  return (MODEL_KEYS as Record<string, ModelKey>)[match[1]!] ?? null;
}

/** A model effect that calls a provider: the model, the key that takes, and whether it has a stand-in. */
export interface ModelNeed {
  effect: string;
  model: string;
  key: ModelKey;
  standIn: boolean;
}

/** The model effects in a system that call a provider when their key is set. */
export function modelNeeds(system: SystemSpec): ModelNeed[] {
  const needs: ModelNeed[] = [];
  for (const [effect, spec] of Object.entries(system.effects ?? {})) {
    if (spec.kind !== "model") continue;
    const key = modelKey(spec.model);
    if (key) needs.push({ effect, model: spec.model!, key, standIn: Boolean(spec.standIn) });
  }
  return needs;
}

/** What a runner somewhere else needs from this machine's environment to call this system's models. */
export interface ModelKeyPlan {
  /** The keys to hand over: only those the system's effects use, and only if set here. */
  env: Partial<Record<ModelKey, string>>;
  /** Effects that will call their model, by the key they use. */
  calls: { key: ModelKey; effects: string[] }[];
  /** Effects that will answer with their stand-ins, because their key isn't set here. */
  standIns: { key: ModelKey; effects: string[] }[];
  /** Effects that couldn't run at all: their key isn't set here and they have no stand-in. */
  missing: { key: ModelKey; effects: string[] }[];
}

export function planModelKeys(system: SystemSpec, env: Record<string, string | undefined>): ModelKeyPlan {
  const plan: ModelKeyPlan = { env: {}, calls: [], standIns: [], missing: [] };
  const add = (list: { key: ModelKey; effects: string[] }[], key: ModelKey, effect: string) => {
    const entry = list.find((e) => e.key === key);
    if (entry) entry.effects.push(effect);
    else list.push({ key, effects: [effect] });
  };
  for (const need of modelNeeds(system)) {
    const value = env[need.key]?.trim();
    if (value) {
      plan.env[need.key] = value;
      add(plan.calls, need.key, need.effect);
    } else add(need.standIn ? plan.standIns : plan.missing, need.key, need.effect);
  }
  return plan;
}

/** Thrown before any request goes out: no key for the model, or no way to call it. It costs nothing. */
export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailable";
  }
}

/** A runner with this provider answers each model effect with its stand-in, and fails one that has none. */
export class StandInModels implements ModelProvider {
  readonly name = "stand-in";
  async complete(request: ModelRequest): Promise<ModelResponse> {
    throw new ModelUnavailable(`This runner answers model effects only with their stand-ins, and this one has none, so ${request.model} wasn't called`);
  }
}

function jsonFrom(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** Calls Anthropic's Messages API or OpenAI's Chat Completions API, chosen by the model's prefix. */
export class HttpModels implements ModelProvider {
  readonly name = "http";
  private readonly env: Record<string, string | undefined>;
  private readonly fetcher: typeof fetch;
  constructor(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch) {
    this.env = env;
    this.fetcher = fetcher;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const [provider, ...rest] = request.model.split("/");
    const model = rest.join("/");
    const instructions = request.schema
      ? `${request.prompt}\n\nAnswer with only a JSON value that matches this JSON schema:\n${JSON.stringify(request.schema)}`
      : request.prompt;
    if (provider === "anthropic") {
      const key = this.env.ANTHROPIC_API_KEY;
      if (!key) throw new ModelUnavailable("ANTHROPIC_API_KEY is not set in the runner's environment");
      const response = await this.fetcher("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...KEY_ROUTES.ANTHROPIC_API_KEY.headers(key), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens ?? 4096,
          ...(request.system ? { system: request.system } : {}),
          messages: [{ role: "user", content: instructions }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await response.json()) as any;
      if (!response.ok) throw new Error(`Anthropic returned ${response.status}: ${body?.error?.message ?? "no message"}`);
      const text = (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      return {
        text,
        json: request.schema ? jsonFrom(text) : undefined,
        model: body.model ?? request.model,
        usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
      };
    }
    if (provider === "openai") {
      const key = this.env.OPENAI_API_KEY;
      if (!key) throw new ModelUnavailable("OPENAI_API_KEY is not set in the runner's environment");
      const response = await this.fetcher("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...KEY_ROUTES.OPENAI_API_KEY.headers(key) },
        body: JSON.stringify({
          model,
          messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: instructions }],
          ...(request.schema ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await response.json()) as any;
      if (!response.ok) throw new Error(`OpenAI returned ${response.status}: ${body?.error?.message ?? "no message"}`);
      const text = body.choices?.[0]?.message?.content ?? "";
      return {
        text,
        json: request.schema ? jsonFrom(text) : undefined,
        model: body.model ?? request.model,
        usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens },
      };
    }
    throw new ModelUnavailable(`Unknown model provider in "${request.model}" (use anthropic/<model> or openai/<model>)`);
  }
}
