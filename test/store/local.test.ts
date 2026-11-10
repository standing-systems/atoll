import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { LocalStore } from "../../src/store/local.ts";
import { storeConformance } from "./conformance.ts";

let dir: string | undefined;

storeConformance("LocalStore", async () => {
  dir = await mkdtemp(join(tmpdir(), "atoll-conformance-"));
  return new LocalStore(dir);
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
