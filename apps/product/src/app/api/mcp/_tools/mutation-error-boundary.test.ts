import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, expect, it, vi } from 'vitest';

import type { McpRequestContext } from '../_context';
import { registerPlansCreateTool, registerRecordsCreateTool } from './timeblock-mutations';

const applyCreate = vi.hoisted(() => vi.fn());
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn((error: Error) => error));
vi.mock('@/features/timeblock/server/mcp-mutation-db', () => ({
  createMcpMutationDb: () => ({ applyPlanCreate: applyCreate, applyRecordCreate: applyCreate }),
}));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedDatabaseError }));
vi.mock('@/lib/analytics/posthog-server', () => ({ trackPostHogServerEvent: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it.each([
  ['plans.create', 'DM008', 'NOT_FOUND', false],
  ['records.create', 'DM008', 'NOT_FOUND', false],
  ['plans.create', 'XX000', 'MUTATION_FAILED', true],
  ['records.create', 'XX000', 'MUTATION_FAILED', true],
] as const)('%s maps %s to %s with retryable=%s', async (name, databaseCode, code, retryable) => {
  applyCreate.mockResolvedValue({ data: null, error: { code: databaseCode } });
  const server = new McpServer({ name: 'mutation-boundary', version: '1.0.0' });
  const context: McpRequestContext = {
    tokenId: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    clientId: 'chatgpt',
    scopes: ['write:plans', 'write:records'],
    resourceUri: 'https://mcp.dayopt.app' as McpRequestContext['resourceUri'],
  };
  registerPlansCreateTool(server, context);
  registerRecordsCreateTool(server, context);
  const client = new Client({ name: 'boundary-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name,
        arguments: {
          operationId: '44444444-4444-4444-8444-444444444444',
          title: 'Synthetic replay',
          startAt: '2026-09-01T10:00:00Z',
          endAt: '2026-09-01T11:00:00Z',
        },
      }),
    );
    expect(applyCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ p_operation_id: '44444444-4444-4444-8444-444444444444' }),
    );
    expect(result.isError).toBe(true);
    const content = result.content[0];
    if (content?.type !== 'text') throw new Error('Expected MCP text error');
    expect(JSON.parse(content.text)).toMatchObject({ error: { code, retryable } });
    expect(captureUnexpectedDatabaseError).toHaveBeenCalledTimes(databaseCode === 'DM008' ? 0 : 1);
  } finally {
    await client.close();
    await server.close();
  }
});
