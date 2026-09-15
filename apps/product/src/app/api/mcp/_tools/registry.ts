import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_SCOPES, hasWriteScope, type SupportedScope } from '@/lib/oauth-server';

import type { McpRequestContext } from '../_context';
import { registerActivitiesListTool } from './activities-list';
import { registerCategoriesListTool } from './categories-list';
import { registerConstraintsGetTool } from './constraints-get';
import { registerEntriesListTool } from './entries-list';
import { registerReviewGetTool } from './review-get';
import {
  registerPlansGetTool,
  registerPlansTrashListTool,
  registerRecordsGetTool,
  registerRecordsTrashListTool,
} from './timeblock-detail';
import { registerPlansListTool, registerRecordsListTool } from './timeblock-list';
import {
  registerPlansCreateTool,
  registerPlansDeleteTool,
  registerPlansRestoreTool,
  registerPlansUpdateTool,
  registerRecordsCreateTool,
  registerRecordsDeleteTool,
  registerRecordsRestoreTool,
  registerRecordsUpdateTool,
} from './timeblock-mutations';

interface McpToolDescriptor {
  name: string;
  requiredScope: SupportedScope;
  register: (server: McpServer, ctx: McpRequestContext) => void;
}

/** Exact set of tools that this deployment can register and authorize. */
export const MCP_TOOL_DESCRIPTORS = [
  {
    name: 'entries.list',
    requiredScope: 'read:entries',
    register: registerEntriesListTool,
  },
  {
    name: 'activities.list',
    requiredScope: 'read:activities',
    register: registerActivitiesListTool,
  },
  {
    name: 'categories.list',
    requiredScope: 'read:activities',
    register: registerCategoriesListTool,
  },
  {
    name: 'constraints.get',
    requiredScope: 'read:constraints',
    register: registerConstraintsGetTool,
  },
  {
    name: 'review.get',
    requiredScope: 'read:stats',
    register: registerReviewGetTool,
  },
  {
    name: 'plans.list',
    requiredScope: 'read:entries',
    register: registerPlansListTool,
  },
  {
    name: 'plans.get',
    requiredScope: 'read:entries',
    register: registerPlansGetTool,
  },
  {
    name: 'plans.create',
    requiredScope: 'write:plans',
    register: registerPlansCreateTool,
  },
  {
    name: 'plans.update',
    requiredScope: 'write:plans',
    register: registerPlansUpdateTool,
  },
  {
    name: 'plans.trash.list',
    requiredScope: 'delete:plans',
    register: registerPlansTrashListTool,
  },
  {
    name: 'plans.delete',
    requiredScope: 'delete:plans',
    register: registerPlansDeleteTool,
  },
  {
    name: 'plans.restore',
    requiredScope: 'delete:plans',
    register: registerPlansRestoreTool,
  },
  {
    name: 'records.list',
    requiredScope: 'read:entries',
    register: registerRecordsListTool,
  },
  {
    name: 'records.get',
    requiredScope: 'read:entries',
    register: registerRecordsGetTool,
  },
  {
    name: 'records.create',
    requiredScope: 'write:records',
    register: registerRecordsCreateTool,
  },
  {
    name: 'records.update',
    requiredScope: 'write:records',
    register: registerRecordsUpdateTool,
  },
  {
    name: 'records.trash.list',
    requiredScope: 'delete:records',
    register: registerRecordsTrashListTool,
  },
  {
    name: 'records.delete',
    requiredScope: 'delete:records',
    register: registerRecordsDeleteTool,
  },
  {
    name: 'records.restore',
    requiredScope: 'delete:records',
    register: registerRecordsRestoreTool,
  },
] as const satisfies readonly McpToolDescriptor[];

const descriptorByName = new Map<string, McpToolDescriptor>(
  MCP_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor] as const),
);

export function getRequiredScopeForTool(toolName: string): SupportedScope | null {
  return descriptorByName.get(toolName)?.requiredScope ?? null;
}

export function mergeMcpChallengeScopes(
  effectiveScopes: readonly SupportedScope[],
  missingScopes: readonly SupportedScope[],
): SupportedScope[] {
  const requiredBaseScopes = hasWriteScope(missingScopes) ? DEFAULT_SCOPES : [];
  return [
    ...new Set<SupportedScope>([...requiredBaseScopes, ...effectiveScopes, ...missingScopes]),
  ];
}
