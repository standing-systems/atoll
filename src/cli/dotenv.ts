// Archil's setup prompts keep credentials in the project's .env and run scripts with
// `node --env-file=.env`. The CLI reads the same file the same way: a variable already set in the
// environment wins, except that an empty one counts as unset (the trap Archil's troubleshooting notes
// describe). It takes only the credentials Atoll uses, and it never prints a value.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const CREDENTIALS = ["ARCHIL_API_KEY", "ARCHIL_REGION", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

export interface DotEnv {
  path: string;
  /** The names this file supplied. Never their values. */
  loaded: string[];
  /** Set when the file exists but couldn't be read. */
  error?: string;
}

/** Fill unset credentials from `<dir>/.env`. Returns null when there is no such file. */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): DotEnv | null {
  const path = join(dir, ".env");
  if (!existsSync(path)) return null;
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    return { path, loaded: [], error: (error as NodeJS.ErrnoException).code ?? "unreadable" };
  }
  const loaded: string[] = [];
  for (const name of CREDENTIALS) {
    const value = parsed[name]?.trim();
    if (!value || env[name]) continue;
    env[name] = value;
    loaded.push(name);
  }
  return { path, loaded };
}
