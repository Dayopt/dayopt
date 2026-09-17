/**
 * Check: Architecture Map の生成ブロック drift と参照切れ
 *
 * `pnpm architecture:check` と同じ判定を docs-guard から常時実行する。
 * glossary-sync と同じ理由で docs-guard 側に置く: `check:static` lane は docs-only PR で
 * skip されるため、生成ブロックを手で書き換えた PR や、写し表の path だけを直した PR を
 * 止められるのは常時実行の `pnpm docs:check` だけ。
 */

import {
  checkArchitectureReferences,
  findStaleArchitectureMapDocs,
} from '../../generate-architecture-map.ts';
import { colors } from '../config.ts';

export interface ArchitectureMapViolation {
  reason: string;
}

export async function runArchitectureMapCheck(): Promise<ArchitectureMapViolation[]> {
  try {
    const violations: ArchitectureMapViolation[] = [];
    for (const path of await findStaleArchitectureMapDocs()) {
      violations.push({
        reason: `${path} の生成ブロックが text 正本と一致しません。pnpm architecture:generate を実行してください`,
      });
    }
    for (const violation of checkArchitectureReferences()) {
      violations.push({ reason: `${violation.source}: ${violation.reason}` });
    }
    return violations;
  } catch (error) {
    return [{ reason: error instanceof Error ? error.message : String(error) }];
  }
}

export function reportArchitectureMapCheck(violations: ArchitectureMapViolation[]): boolean {
  if (violations.length === 0) {
    console.log(
      `${colors.green}✅ architecture-map: 生成ブロックは最新、参照は全件実在${colors.reset}`,
    );
    return true;
  }

  console.log(`${colors.red}❌ architecture-map: ${violations.length} 件${colors.reset}`);
  for (const violation of violations) {
    console.log(`   ${violation.reason}`);
  }
  return false;
}
