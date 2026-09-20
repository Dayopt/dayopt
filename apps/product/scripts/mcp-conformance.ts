import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { handleMcpProtocolRequest } from '../src/app/api/mcp/_protocol-handler';
import { MCP_TOOL_DESCRIPTORS } from '../src/app/api/mcp/_tools/registry';

/**
 * MCP protocol conformance の repo 内再実行。
 *
 * issue #1754 のコメント欄 step-6-conformance.md 相当（docs/projects 全廃に伴い
 * #2473 で移設）の Required release evidence。`@modelcontextprotocol/conformance` CLI を child process で起動し、
 * `handleMcpProtocolRequest`（現行 v1 SDK / WebStandardStreamableHTTPServerTransport
 * 実装）に対して spec の active suite を走らせる。
 *
 * v2 SDK（`@modelcontextprotocol/node` / `@modelcontextprotocol/server`）は使わない。
 * Node の `http.createServer` から Web Standard `Request`/`Response` への変換と、
 * localhost host/origin 検証は自前実装する。
 */

const SPEC_VERSION = '2025-11-25';
const EXPECTED_FAILURES_PATH = fileURLToPath(
  new URL('./mcp-conformance-expected-failures.yml', import.meta.url),
);
const CONFORMANCE_CHILD_ENV_KEYS = [
  'CI',
  'COLORTERM',
  'FORCE_COLOR',
  'HOME',
  'NO_COLOR',
  'PATH',
  'PNPM_HOME',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'SystemRoot',
  'WINDIR',
] as const;

/** localhost 判定は DNS rebinding protection の対象を host/origin どちらでも同一基準にする。 */
const LOCALHOST_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// registry の全 requiredScope を導出した full-scope context。read-only context だと
// write / delete 系 tool が tools/list に一度も現れず、その schema の spec 準拠が
// 検証されないまま pass してしまう（scope filter 自体は unit test が固定する）。
// 手書き配列にしないのは、将来 registry へ新 scope の tool が増えた時に検証から
// 静かに欠落するのを防ぐため。
const CONFORMANCE_AUTH_INFO: AuthInfo = {
  token: '<redacted>',
  clientId: 'chatgpt',
  scopes: [...new Set(MCP_TOOL_DESCRIPTORS.map((descriptor) => descriptor.requiredScope))],
  resource: new URL('https://mcp.dayopt.app'),
  extra: {
    tokenId: 'conformance-token',
    connectionId: 'conformance-connection',
    userId: 'conformance-user',
    resourceUri: 'https://mcp.dayopt.app',
  },
};

async function main(): Promise<void> {
  // `pnpm test:mcp:conformance` は dummy env を inline 代入で固定する。tsx を直接
  // 実行した shell に実 secret が export されていても、実 Supabase へ向かわず・
  // 実 credential を dummy host へ送らないよう、URL と両 key のすべてが dummy 値で
  // なければ起動を拒否する。
  const requiredDummyEnv: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://dummy.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'dummy',
    SUPABASE_SECRET_KEY: 'dummy',
  };
  for (const [key, expected] of Object.entries(requiredDummyEnv)) {
    if (process.env[key] !== expected) {
      throw new Error(
        `Refusing to run: ${key} must be the dummy conformance value. Run via \`pnpm --filter product test:mcp:conformance\`.`,
      );
    }
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), 'dayopt-mcp-conformance-'));
  const server = createServer((request, response) => {
    void handleIncomingRequest(request, response).catch((error: unknown) => {
      process.stderr.write(`MCP conformance adapter failed: ${errorMessage(error)}\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('MCP conformance server did not expose a TCP port');
    }
    const serverUrl = `http://127.0.0.1:${address.port}/mcp`;

    await runConformanceSuite(serverUrl, outputDirectory);
    await verifyJsonArtifacts(outputDirectory);
    process.stdout.write('Dayopt MCP conformance checks passed.\n');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function handleIncomingRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!hasHttpRequestTarget(request)) {
    response.writeHead(400).end();
    return;
  }

  const rejection = validateLocalhostRequest(request);
  if (rejection) {
    response.writeHead(rejection.status, { 'content-type': 'text/plain' }).end(rejection.message);
    return;
  }

  const webRequest = await toWebRequest(request);
  const webResponse = await handleMcpProtocolRequest(webRequest, {
    authInfo: CONFORMANCE_AUTH_INFO,
  });
  await writeWebResponse(webResponse, response);
}

/**
 * DNS rebinding protection 相当。SDK 1.30 の `allowedHosts` / `allowedOrigins` は
 * deprecated（"use external middleware instead"）のため、conformance の
 * `dns-rebinding-protection` scenario が要求する検証をこの adapter で自前実装する。
 */
function validateLocalhostRequest(
  request: IncomingMessage & { headers: IncomingMessage['headers'] },
): { status: number; message: string } | null {
  const hostHeader = request.headers.host;
  if (!hostHeader || !isLocalhostAuthority(hostHeader)) {
    return { status: 403, message: 'Forbidden: invalid Host header' };
  }

  const originHeader = request.headers.origin;
  if (typeof originHeader === 'string' && originHeader.length > 0) {
    let originHostname: string;
    try {
      originHostname = new URL(originHeader).hostname.toLowerCase();
    } catch {
      return { status: 403, message: 'Forbidden: invalid Origin header' };
    }
    if (!LOCALHOST_HOSTNAMES.has(originHostname)) {
      return { status: 403, message: 'Forbidden: invalid Origin header' };
    }
  }

  return null;
}

function isLocalhostAuthority(hostHeader: string): boolean {
  // Host header は "hostname:port" 形式。IPv6 の "[::1]:port" も考慮し、
  // 最後の ":" だけをポート区切りとして扱う（"[::1]" 自体に ":" を含むため）。
  const hostname = hostHeader.startsWith('[')
    ? (hostHeader.match(/^(\[[^\]]+\])/u)?.[1] ?? hostHeader)
    : (hostHeader.split(':')[0] ?? hostHeader);
  return LOCALHOST_HOSTNAMES.has(hostname.toLowerCase());
}

async function toWebRequest(
  request: IncomingMessage & { method: string; url: string },
): Promise<Request> {
  const hostHeader = request.headers.host ?? '127.0.0.1';
  const url = new URL(request.url, `http://${hostHeader}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  const hasBody =
    request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'DELETE';
  const body = hasBody ? await bufferRequestBody(request) : undefined;

  return new Request(url, {
    method: request.method,
    headers,
    ...(body !== undefined && body.byteLength > 0 ? { body, duplex: 'half' } : {}),
  } as RequestInit & { duplex?: 'half' });
}

async function bufferRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function writeWebResponse(webResponse: Response, response: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(webResponse.status, headers);

  if (!webResponse.body) {
    response.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeChunk(response, value);
    }
  } finally {
    reader.releaseLock();
    response.end();
  }
}

function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    response.write(Buffer.from(chunk), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runConformanceSuite(serverUrl: string, outputDirectory: string): Promise<void> {
  const child = spawn(
    'pnpm',
    [
      'exec',
      'conformance',
      'server',
      '--url',
      serverUrl,
      '--spec-version',
      SPEC_VERSION,
      '--expected-failures',
      EXPECTED_FAILURES_PATH,
      '--output-dir',
      outputDirectory,
    ],
    {
      stdio: 'inherit',
      env: createConformanceChildEnvironment(),
    },
  );
  const [exitCode] = (await once(child, 'close')) as [number | null];
  if (exitCode !== 0) {
    throw new Error(`MCP conformance suite failed with exit code ${String(exitCode)}`);
  }
}

async function verifyJsonArtifacts(directory: string): Promise<void> {
  const files = await listFiles(directory);
  const jsonFiles = files.filter((file) => file.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new Error('MCP conformance did not write JSON result artifacts');
  }
  for (const file of jsonFiles) {
    void JSON.parse(await readFile(file, 'utf8'));
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function createConformanceChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of CONFORMANCE_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function hasHttpRequestTarget(
  request: IncomingMessage,
): request is IncomingMessage & { method: string; url: string } {
  return (
    typeof request.method === 'string' &&
    request.method.length > 0 &&
    typeof request.url === 'string' &&
    request.url.length > 0
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`Dayopt MCP conformance failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
