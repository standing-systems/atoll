// A local stand-in for Archil's control plane and S3 endpoint, for testing ArchilStore offline: the SDK
// is pointed at it with baseUrl and s3BaseUrl, so requests go through the SDK's real transport and the
// tests can see exactly what reaches the wire. Tests script the answers; anything unscripted is a 500.

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeReply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type Responder = (request: SeenRequest) => FakeReply | undefined;

export interface FakeArchil {
  url: string;
  requests: SeenRequest[];
  /** Answer matching requests; earlier responders win. A responder returns undefined to pass. */
  on(responder: Responder): void;
  /** Answer the next requests that match, one reply each, in order. */
  queue(match: (request: SeenRequest) => boolean, ...replies: FakeReply[]): void;
  reset(): void;
  close(): Promise<void>;
}

export const DISK_ID = "dsk-00000000000000a1";
export const BRANCH_ID = "dsk-00000000000000b2";

export function diskJson(id: string, name: string): FakeReply {
  return json(200, {
    success: true,
    data: {
      id,
      name,
      organization: "org-test",
      status: "available",
      provider: "aws",
      region: "aws-us-west-2",
      createdAt: "2026-11-05T00:00:00Z",
      sandboxDisk: false,
      allowSandboxMount: true,
    },
  });
}

export function json(status: number, value: unknown): FakeReply {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export function s3Error(status: number, code: string, message: string): FakeReply {
  return {
    status,
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>req-test</RequestId></Error>`,
  };
}

export function listXml(prefix: string, keys: { key: string; size: number }[]): FakeReply {
  const contents = keys.map(({ key, size }) => `<Contents><Key>${key}</Key><Size>${size}</Size><ETag>"e"</ETag></Contents>`).join("");
  return {
    status: 200,
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${DISK_ID}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
  };
}

/** One level of a listing (delimiter "/"): files in Contents, folders in CommonPrefixes. */
export function listLevelXml(prefix: string, keys: string[], folders: string[]): FakeReply {
  const contents = keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size><ETag>"e"</ETag></Contents>`).join("");
  const common = folders.map((folder) => `<CommonPrefixes><Prefix>${folder}</Prefix></CommonPrefixes>`).join("");
  return {
    status: 200,
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${DISK_ID}</Name><Prefix>${prefix}</Prefix><Delimiter>/</Delimiter><KeyCount>${keys.length + folders.length}</KeyCount><IsTruncated>false</IsTruncated>${contents}${common}</ListBucketResult>`,
  };
}

export async function startFakeArchil(): Promise<FakeArchil> {
  const requests: SeenRequest[] = [];
  let responders: Responder[] = [];
  const builtIn: Responder = (request) => {
    if (request.method === "GET" && request.path === `/api/disks/${DISK_ID}`) return diskJson(DISK_ID, "radar");
    if (request.method === "GET" && request.path === `/api/disks/${BRANCH_ID}`) return diskJson(BRANCH_ID, `__branch__${DISK_ID}__trial`);
    return undefined;
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const request: SeenRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      let reply: FakeReply | undefined;
      for (const responder of [...responders, builtIn]) {
        reply = responder(request);
        if (reply) break;
      }
      reply ??= json(500, { success: false, error: `unscripted ${request.method} ${request.path}` });
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(responder) {
      responders.push(responder);
    },
    queue(match, ...replies) {
      responders.push((request) => (match(request) ? replies.shift() : undefined));
    },
    reset() {
      responders = [];
      requests.length = 0;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
