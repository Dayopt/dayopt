import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { serializeUntrustedMcpData } from './untrusted-data-serialization';

// v4: independent records and period-clipped aggregate reads. Mutation receipt versions are unchanged.
export const MCP_TOOL_SCHEMA_VERSION = 4 as const;

/**
 * 成功結果の legacy text は必ず untrusted data として枠付けする。
 *
 * title / note / tag 名など、返す payload はすべてユーザーが書いた自由テキストを
 * 含みうる。枠付けを個々の tool 側に置くと read tool を足すたび漏れるので、
 * 唯一の成功経路であるここに寄せる。structuredContent は outputSchema 検証を
 * 通す機械可読チャネルなので枠を付けず生のまま返す。
 */
export function createMcpToolSuccess(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: serializeUntrustedMcpData(structuredContent),
      },
    ],
    structuredContent,
  };
}

export function createMcpToolError(
  code: string,
  message: string,
  retryable = false,
): CallToolResult {
  const errorContent = {
    schemaVersion: MCP_TOOL_SCHEMA_VERSION,
    error: { code, message, retryable },
  };
  return {
    // SDK 1.29 validates structuredContent against the success outputSchema even
    // when isError=true. Keep stable JSON in legacy text and omit structuredContent
    // so clients receive the domain error instead of a false output-schema failure.
    content: [{ type: 'text', text: JSON.stringify(errorContent, null, 2) }],
    isError: true,
  };
}
