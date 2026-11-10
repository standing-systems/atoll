// A small system used by the runtime tests: a counter part, a watcher with an effect and a schedule, a
// part that asks, and one that speaks for the owner behind an approval.

import { defineSystem, type SystemSpec } from "../../src/index.ts";

export function counterSystem(): SystemSpec {
  return defineSystem({
    name: "fixture",
    owner: { timezone: "UTC" },
    parts: {
      counter: {
        purpose: "Count the pings I send, and tell the tally to the ledger",
        on: {
          ping: async (t) => {
            const state = (await t.json<{ n: number }>("count.json")) ?? { n: 0 };
            t.write("count.json", { n: state.n + 1 });
            t.write("history/" + String(state.n + 1).padStart(4, "0") + ".txt", `ping ${state.n + 1} at ${t.now.toISOString()}\n`);
            t.send("ledger", "tally", { n: state.n + 1 });
            t.note(`count is now ${state.n + 1}`);
            t.wait({ for: "ping", reason: "the next ping" });
          },
          boom: () => {
            throw new Error("this handler always fails");
          },
        },
      },
      ledger: {
        purpose: "Keep the latest tally the counter reported",
        on: {
          tally: async (t, e) => {
            t.write("latest.json", { n: e.body.n, at: t.now.toISOString() });
            t.wait({ for: "tally", reason: "the next tally" });
          },
        },
      },
      watch: {
        purpose: "Tell me when this page changes",
        instances: true,
        schedules: [{ every: "1h", send: "watch.poll" }],
        on: {
          "watch.start": async (t, e) => {
            t.write("config.json", { url: e.body.url });
            t.effect("page.get", { url: e.body.url }, { then: "watch.fetched" });
            t.wait({ for: "watch.fetched", reason: "the page" });
          },
          "watch.poll": async (t) => {
            const config = await t.json<{ url: string }>("config.json");
            t.effect("page.get", { url: config!.url }, { then: "watch.fetched" });
            t.wait({ for: "watch.fetched", reason: "the page" });
          },
          "watch.fetched": async (t, e) => {
            if (!e.body.ok) {
              t.note(`fetch failed: ${e.body.error}`);
              return;
            }
            const body = String(e.body.result?.text ?? "");
            const last = await t.read("last.txt");
            if (last !== body) {
              t.write("last.txt", body);
              if (last !== null) t.tell(`The page changed: ${body}`, { evidence: e.evidence ?? [] });
            }
          },
        },
      },
      nag: {
        purpose: "Ask me whether to keep going, and remind me by timer",
        on: {
          start: async (t) => {
            t.ask({
              question: "Keep going?",
              why: "Testing asks.",
              options: [
                { id: "yes", label: "Yes", consequence: "It keeps going." },
                { id: "no", label: "No", consequence: "It stops." },
              ],
              recommend: "yes",
              default: "no",
              expires: "2d",
              payload: { draft: "hello" },
            });
            t.wait({ until: "1d", reason: "a day to pass" });
          },
          timer: async (t) => {
            t.write("timer-fired.txt", t.now.toISOString());
          },
          "ask.answered": async (t, e) => {
            t.write("answer.json", e.body);
            if (e.body.option === "no") t.done("told to stop");
          },
          "ask.expired": async (t, e) => {
            t.write("expired.json", e.body);
            t.done("nobody answered");
          },
        },
      },
      speaker: {
        purpose: "Send a message to Sam for me, but only once I approve the exact text",
        on: {
          say: (t, e) => {
            t.effect("message.send", { to: "sam", text: e.body.text }, { then: "said" });
            t.wait({ for: "said", reason: "the message to go out" });
          },
          said: (t, e) => {
            t.write("outcome.json", e.body);
            t.done("message handled");
          },
        },
      },
      thinker: {
        purpose: "Ask the model a question within a budget",
        on: {
          think: (t, e) => {
            t.effect("model.ask", { prompt: e.body.prompt }, { then: "thought" });
          },
          thought: (t, e) => {
            t.write(`answers/${e.id}.json`, e.body);
          },
        },
      },
    },
    effects: {
      "page.get": { kind: "http", allow: ["example.com"] },
      "message.send": { kind: "custom", approval: true, describe: (a: any) => `Send ${a.to} "${a.text}"`, run: async () => ({ sent: true }) },
      "model.ask": { kind: "model", standIn: (a: any) => ({ answer: `stand-in answer to ${a.prompt}` }), budget: { calls: 2, per: "day" } },
    },
  });
}
