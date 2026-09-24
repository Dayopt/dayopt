import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { McpRequestContext } from './_context';
import { createMcpServer } from './_server';

const baseContext: McpRequestContext = {
  tokenId: 'token-1',
  connectionId: 'connection-1',
  userId: 'user-1',
  clientId: 'chatgpt',
  scopes: ['read:entries'],
  resourceUri: 'https://mcp.dayopt.app' as McpRequestContext['resourceUri'],
};

async function listTools(scopes: readonly McpRequestContext['scopes'][number][]) {
  const server = createMcpServer({ ...baseContext, scopes: [...scopes] });
  const client = new Client({ name: 'scope-filter-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP scope-filtered tool discovery', () => {
  it.each([
    [['read:entries'], ['entries.list', 'plans.get', 'plans.list', 'records.get', 'records.list']],
    [['read:activities'], ['activities.list', 'categories.list']],
    [['read:constraints'], ['constraints.get']],
    [['read:stats'], ['review.get']],
    [
      ['read:entries', 'write:plans', 'delete:records'],
      [
        'entries.list',
        'plans.create',
        'plans.get',
        'plans.list',
        'plans.update',
        'records.delete',
        'records.get',
        'records.list',
        'records.restore',
        'records.trash.list',
      ],
    ],
    [
      ['read:entries', 'write:records'],
      [
        'entries.list',
        'plans.get',
        'plans.list',
        'records.create',
        'records.get',
        'records.list',
        'records.update',
      ],
    ],
    [
      ['read:entries', 'delete:plans'],
      [
        'entries.list',
        'plans.delete',
        'plans.get',
        'plans.list',
        'plans.restore',
        'plans.trash.list',
        'records.get',
        'records.list',
      ],
    ],
  ] as const)('scopes %j advertise only the public tool set', async (scopes, expected) => {
    expect(await listTools(scopes)).toEqual([...expected].sort());
  });
});
