export type Environment = 'all' | 'production' | 'preview' | 'integration';
export type Status = 'pass' | 'drift' | 'blocked' | 'manual' | 'not_applicable';
export interface Observation {
  key: string;
  environment: string;
  value: unknown;
  source: string;
  status?: 'blocked' | 'manual' | 'not_applicable';
  reason?: string;
  next_step?: string;
}
export interface ReaderContext {
  environment: Environment;
  request(operation: string, params?: Record<string, unknown>): Promise<unknown>;
  root: string;
}
export interface Definition {
  id: string;
  service: string;
  environments: string[];
  rule: string;
  expected?: unknown;
  required: boolean;
  next_step: string;
}
export interface Result {
  check_id: string;
  service: string;
  environment: string;
  expected: unknown;
  observed: unknown;
  source: string;
  checked_at: string;
  status: Status;
  reason: string;
  next_step: string;
  required: boolean;
}
