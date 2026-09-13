export type ObservabilityRecord = Record<string, unknown>;

export interface TechnicalErrorContext {
  feature?: string;
  operation?: string;
  route?: string;
  requestId?: string;
  errorCode?: string;
  errorMessage?: string;
  source?: string;
  component?: string;
  digest?: string;
  /** 内部の接続 ID。UUID 形だけを通す（email / provider account は通さない、#2687） */
  connectionId?: string;
  consecutiveFailures?: number;
}

const REDACTED = '[REDACTED]';
const REDACTED_EMAIL = '[REDACTED_EMAIL]';
const REDACTED_TOKEN = '[REDACTED_TOKEN]';

const PROTOCOL_ID_KEYS = new Set([
  'dist',
  'environment',
  'event_id',
  'release',
  'trace_id',
  'span_id',
  'parent_span_id',
  'segment_id',
  'profile_id',
]);

const TECHNICAL_CONTEXT_KEYS = new Set([
  'action',
  'appversion',
  'attempt',
  'category',
  'component',
  'componentstack',
  'connectionid',
  'consecutivefailures',
  'count',
  'digest',
  'directive',
  'duration',
  'environment',
  'errorboundary',
  'errorcode',
  'errormessage',
  'errortype',
  'feature',
  'level',
  'limit',
  'method',
  'operation',
  'page',
  'platform',
  'release',
  'requestid',
  'route',
  'runtime',
  'serviceerrorcode',
  'source',
  'status',
  'statuscode',
  'type',
]);

const TECHNICAL_NUMBER_KEYS = new Set([
  'attempt',
  'consecutivefailures',
  'count',
  'duration',
  'limit',
  'statuscode',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TECHNICAL_TAG_KEYS = new Set([
  ...TECHNICAL_CONTEXT_KEYS,
  'app.platform',
  'error_boundary',
  'error_type',
  'errorcode',
  'serviceerrorcode',
]);

const BUILT_IN_CONTEXT_FIELDS: Record<string, ReadonlySet<string>> = {
  app: new Set([
    'app_build',
    'app_identifier',
    'app_name',
    'app_start_time',
    'app_version',
    'build_type',
  ]),
  browser: new Set(['name', 'version']),
  cloud_resource: new Set(['cloud_provider', 'platform', 'region', 'zone']),
  culture: new Set(['locale', 'timezone']),
  csp: new Set([
    'blockedUri',
    'columnNumber',
    'documentUri',
    'effectiveDirective',
    'lineNumber',
    'sourceFile',
  ]),
  device: new Set([
    'arch',
    'battery_level',
    'brand',
    'charging',
    'family',
    'free_memory',
    'free_storage',
    'memory_size',
    'model',
    'name',
    'online',
    'orientation',
    'processor_count',
    'screen_density',
    'screen_dpi',
    'screen_height',
    'screen_width',
    'simulator',
    'storage_size',
    'timezone',
    'type',
    'usable_memory',
  ]),
  gpu: new Set(['api_type', 'memory_size', 'name', 'vendor_name', 'version']),
  os: new Set(['build', 'kernel_version', 'name', 'rooted', 'version']),
  otel: new Set([
    'service.name',
    'service.version',
    'telemetry.sdk.language',
    'telemetry.sdk.name',
  ]),
  replay: new Set(['replay_id']),
  response: new Set(['body_size', 'status_code']),
  runtime: new Set(['build', 'name', 'version']),
  trace: new Set(['op', 'origin', 'parent_span_id', 'span_id', 'status', 'trace_id']),
};

const BUILT_IN_NUMBER_FIELDS: Record<string, ReadonlySet<string>> = {
  csp: new Set(['columnNumber', 'lineNumber']),
  device: new Set([
    'battery_level',
    'free_memory',
    'free_storage',
    'memory_size',
    'processor_count',
    'screen_density',
    'screen_dpi',
    'screen_height',
    'screen_width',
    'storage_size',
    'usable_memory',
  ]),
  gpu: new Set(['memory_size']),
  response: new Set(['body_size', 'status_code']),
};

const BUILT_IN_BOOLEAN_FIELDS: Record<string, ReadonlySet<string>> = {
  device: new Set(['charging', 'online', 'simulator']),
  os: new Set(['rooted']),
};

const CUSTOM_CONTEXT_KEYS = new Set(['react']);
const SAFE_BREADCRUMB_DATA_KEYS = new Set([
  'category',
  'component',
  'directive',
  'feature',
  'level',
  'method',
  'operation',
  'route',
  'source',
  'status',
  'status_code',
  'type',
  'url',
]);

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const AUTHORIZATION_SECRET_RE =
  /\b(authorization)\b(["']?)\s*([:=]\s*|\s+)(["']?)([^\n,;&}"']+)/giu;
const LABELED_SECRET_RE =
  /\b(client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret[_-]?key|session[_-]?token|auth[_-]?token|code|otp|token|secret|password)\b(["']?)\s*([:=]\s*|\s+)(["']?)([^\s,;&}"']+)/giu;
const EMBEDDED_ABSOLUTE_URL_RE = /https?:\/\/[^\s<>"')\]]+/giu;
const EMBEDDED_QUERY_PATH_RE = /\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*[?#][^\s<>"')\]]+/gu;

function isRecord(value: unknown): value is ObservabilityRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isEmailLocalCharacter(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    isAsciiDigit(code) ||
    code === 95 ||
    code === 46 ||
    code === 43 ||
    code === 45
  );
}

function isEmailDomainCharacter(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 95 || code === 45 || code === 46;
}

function findEmailDomainEnd(value: string, atIndex: number): number | null {
  let index = atIndex + 1;
  let labelLength = 0;
  let labelContainsOnlyLetters = true;
  let sawDot = false;
  let lastValidEnd: number | null = null;

  while (index < value.length && isEmailDomainCharacter(value.charCodeAt(index))) {
    const code = value.charCodeAt(index);
    if (code === 46) {
      if (labelLength === 0) break;
      sawDot = true;
      labelLength = 0;
      labelContainsOnlyLetters = true;
      index += 1;
      continue;
    }

    labelLength += 1;
    labelContainsOnlyLetters &&= isAsciiLetter(code);
    index += 1;
    if (sawDot && labelLength >= 2 && labelContainsOnlyLetters) lastValidEnd = index;
  }

  return lastValidEnd;
}

function redactEmails(value: string): string {
  let appendFrom = 0;
  let searchFrom = 0;
  const output: string[] = [];

  while (searchFrom < value.length) {
    const atIndex = value.indexOf('@', searchFrom);
    if (atIndex < 0) break;

    let localStart = atIndex;
    while (localStart > appendFrom && isEmailLocalCharacter(value.charCodeAt(localStart - 1))) {
      localStart -= 1;
    }

    const domainEnd = localStart < atIndex ? findEmailDomainEnd(value, atIndex) : null;
    if (domainEnd === null) {
      searchFrom = atIndex + 1;
      continue;
    }

    output.push(value.slice(appendFrom, localStart), REDACTED_EMAIL);
    appendFrom = domainEnd;
    searchFrom = domainEnd;
  }

  if (output.length === 0) return value;
  output.push(value.slice(appendFrom));
  return output.join('');
}

function redactTokenSecrets(value: string): string {
  return redactEmails(value)
    .replace(JWT_RE, REDACTED_TOKEN)
    .replace(LONG_TOKEN_RE, (match) => (match.startsWith('REDACTED') ? match : REDACTED_TOKEN));
}

function redactStringSecrets(value: string): string {
  return redactTokenSecrets(value)
    .replace(
      AUTHORIZATION_SECRET_RE,
      (_match, label: string, keyQuote: string, separator: string, valueQuote: string) =>
        `${label}${keyQuote}${separator}${valueQuote}${REDACTED}`,
    )
    .replace(
      LABELED_SECRET_RE,
      (_match, label: string, keyQuote: string, separator: string, valueQuote: string) =>
        `${label}${keyQuote}${separator}${valueQuote}${REDACTED}`,
    );
}

function sanitizeString(value: string): string {
  return redactTokenSecrets(value)
    .replace(EMBEDDED_ABSOLUTE_URL_RE, (url) => sanitizeObservabilityUrl(url))
    .replace(EMBEDDED_QUERY_PATH_RE, (url) => sanitizeObservabilityUrl(url))
    .replace(
      AUTHORIZATION_SECRET_RE,
      (_match, label: string, keyQuote: string, separator: string, valueQuote: string) =>
        `${label}${keyQuote}${separator}${valueQuote}${REDACTED}`,
    )
    .replace(
      LABELED_SECRET_RE,
      (_match, label: string, keyQuote: string, separator: string, valueQuote: string) =>
        `${label}${keyQuote}${separator}${valueQuote}${REDACTED}`,
    );
}

function sanitizeEventMessage(value: string): string {
  return /^CSP Violation: [a-z0-9-]{1,64}$/u.test(value) ? value : REDACTED;
}

function sanitizeTechnicalIdentifier(value: unknown): string {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    return value;
  }
  return REDACTED;
}

function sanitizeTechnicalLabel(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_.:+/-]+$/u.test(value)
  ) {
    return undefined;
  }
  return sanitizeString(value);
}

function sanitizePrimitiveValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

/**
 * `sanitizeTechnicalContext` の結果は丸ごと `scope.setTags()` へ流れる（`integration.ts`
 * の `captureUnexpectedError`）。Sentry tag value は 200 字上限・indexed のため、これを
 * 超える文字列は SDK 側で黙って欠落・切り詰めされる。`componentStack` は tag 宛先ではなく
 * `scope.setContext('react', ...)` へ別経路で渡るため、この上限は対象外。
 */
const SENTRY_TAG_VALUE_MAX_LENGTH = 200;

const UNRECOGNIZED_ERROR_MESSAGE = '[UNRECOGNIZED_ERROR_MESSAGE]';

/**
 * `errorMessage`（PostgREST/gateway/DB driver 由来の自由文字列）専用の default-closed
 * sanitizer（#2289 round 4、Codex P1）。
 *
 * `sanitizeString` は denylist（既知の secret パターンを狙って redact する）であり、
 * 自由文の error message には安全ではない。未ラベルの短い token、UUID、SQL キャスト
 * エラーが引用する生の入力値（例: `invalid input syntax for type ...: "..."`）、
 * gateway の診断文に紛れ込む資格情報は、どの denylist パターンにも一致しないため
 * 素通りしてしまう。allowlist（tags 経路 = `TECHNICAL_CONTEXT_KEYS` 全体）に自由文を
 * 混ぜるのは、この tags 経路が他の技術的コンテキストと共有されている以上、危険度が高い。
 *
 * そのため `errorMessage` だけは **allowlist に完全一致した既知の静的メッセージのみ**を
 * 通し、それ以外は内容を一切送らず定数 `UNRECOGNIZED_ERROR_MESSAGE` に落とす
 * （default-closed）。拡張はパターン追加 = レビューを通る変更としてのみ行う。これにより
 * 「cast エラーの値引用・gateway 診断文・UUID 素通り」という class を個別パターンの
 * 追加ではなく構造的に閉じる。
 *
 * 通過ケースも `sanitizeString` + 200 字 truncate を重ねて belt-and-braces にする
 * （allowlist パターン自体に動的部分は無い設計だが、実装ミスの二重防御として残す）。
 */
const ERROR_MESSAGE_ALLOWLIST: readonly RegExp[] = [
  // assert_timeblock_service_role_request_v1 の静的 RAISE（動的部分なし）
  /^Access denied: service role required$/,
  // PostgREST の EXECUTE 拒否。関数名は識別子 charset（[A-Za-z0-9_]）に限定される
  /^permission denied for function [A-Za-z0-9_]+$/,
  // 40P01: PostgreSQL の固定文言、動的部分なし
  /^deadlock detected$/,
  // 57014: PostgreSQL の固定文言、動的部分なし
  /^canceling statement due to statement timeout$/,
  // 55P03: relation 名は識別子 charset に限定される
  /^could not obtain lock on row in relation "[A-Za-z0-9_]+"$/,
  // undici/node fetch 層の代表的例外 message。固定文言（AbortController の message は
  // Node バージョンで揺れがあるため、末尾の理由句は optional として許容する）
  /^fetch failed$/,
  /^terminated$/,
  /^The operation was aborted\.?( due to timeout\.?)?$/,
  // PGRST202（PostgREST が RPC 関数を schema cache 上で見つけられない）。関数シグネチャの
  // 文字種は PostgREST 自身の serialization 形式で識別子・記号に限定される
  /^Could not find the function [A-Za-z0-9_.(), =>]+ in the schema cache$/,
  // 注意: `invalid input syntax for type ... : "..."` 系は意図的に allowlist へ入れない。
  // メッセージ末尾に生の入力値がそのまま引用されるため（cast エラー）。呼び出し側は
  // SQLSTATE 22007 等の errorCode で識別する。
];

function sanitizeErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const isKnownSafe = ERROR_MESSAGE_ALLOWLIST.some((pattern) => pattern.test(trimmed));
  if (!isKnownSafe) return UNRECOGNIZED_ERROR_MESSAGE;

  return sanitizeString(trimmed).slice(0, SENTRY_TAG_VALUE_MAX_LENGTH);
}

function sanitizeTechnicalValue(key: string, value: unknown): unknown {
  const normalized = normalizedKey(key);
  if (normalized === 'requestid' || normalized === 'digest') {
    return sanitizeTechnicalIdentifier(value);
  }
  if (normalized === 'connectionid') {
    return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
  }
  if (normalized === 'route' || normalized === 'page') {
    return typeof value === 'string' ? sanitizeObservabilityUrl(value) : undefined;
  }
  if (normalized === 'componentstack') {
    return typeof value === 'string' ? sanitizeString(value) : undefined;
  }
  if (normalized === 'errormessage') {
    return sanitizeErrorMessage(value);
  }
  if (TECHNICAL_NUMBER_KEYS.has(normalized)) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  return sanitizeTechnicalLabel(value);
}

function sanitizePathSegment(segment: string): string {
  let decoded = segment;
  try {
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return REDACTED;
  }

  const sanitized = redactStringSecrets(decoded);
  if (!segment.includes('%') && sanitized === segment) return segment;

  return encodeURIComponent(sanitized).replaceAll('%5B', '[').replaceAll('%5D', ']');
}

function sanitizePathname(pathname: string): string {
  return pathname.split('/').map(sanitizePathSegment).join('/');
}

/** Retains only origin/pathname; query and fragment are never sent. */
export function sanitizeObservabilityUrl(value: string): string {
  const withoutQueryOrFragment = value.split(/[?#]/, 1)[0] ?? '';
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    return REDACTED;
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    return sanitizePathname(withoutQueryOrFragment);
  }

  try {
    const parsed = new URL(value);
    const pathname = sanitizePathname(parsed.pathname);
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return redactStringSecrets(withoutQueryOrFragment);
  }
}

export function sanitizeTechnicalContext(context: ObservabilityRecord): ObservabilityRecord {
  const sanitized: ObservabilityRecord = {};
  for (const [key, value] of Object.entries(context)) {
    const normalized = normalizedKey(key);
    if (!TECHNICAL_CONTEXT_KEYS.has(normalized)) continue;
    const sanitizedValue = sanitizeTechnicalValue(key, value);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

function sanitizeRequest(request: ObservabilityRecord): ObservabilityRecord {
  const sanitized: ObservabilityRecord = {};
  if (typeof request.url === 'string') sanitized.url = sanitizeObservabilityUrl(request.url);
  if (typeof request.method === 'string') sanitized.method = sanitizeString(request.method);

  return sanitized;
}

function sanitizeUser(user: ObservabilityRecord): ObservabilityRecord | undefined {
  if (
    typeof user.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(user.id)
  ) {
    return undefined;
  }
  return { id: user.id };
}

function sanitizeTags(tags: ObservabilityRecord): ObservabilityRecord {
  const sanitized: ObservabilityRecord = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!TECHNICAL_TAG_KEYS.has(key.toLowerCase()) && !TECHNICAL_TAG_KEYS.has(normalizedKey(key))) {
      continue;
    }
    const sanitizedValue = sanitizeTechnicalValue(key, value);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

function sanitizeBuiltInContextValue(
  contextKey: string,
  field: string,
  value: unknown,
): string | number | boolean | undefined {
  if (
    contextKey === 'csp' &&
    (field === 'blockedUri' || field === 'documentUri' || field === 'sourceFile')
  ) {
    return typeof value === 'string' ? sanitizeObservabilityUrl(value) : undefined;
  }
  if (
    (contextKey === 'trace' && ['trace_id', 'span_id', 'parent_span_id'].includes(field)) ||
    (contextKey === 'replay' && field === 'replay_id')
  ) {
    return typeof value === 'string' ? value : undefined;
  }
  if (BUILT_IN_NUMBER_FIELDS[contextKey]?.has(field)) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (BUILT_IN_BOOLEAN_FIELDS[contextKey]?.has(field)) {
    return typeof value === 'boolean' ? value : undefined;
  }
  return typeof value === 'string' ? sanitizeString(value) : undefined;
}

function sanitizeContexts(contexts: ObservabilityRecord): ObservabilityRecord {
  const sanitized: ObservabilityRecord = {};
  for (const [key, value] of Object.entries(contexts)) {
    if (!isRecord(value)) continue;
    const builtInFields = BUILT_IN_CONTEXT_FIELDS[key];
    if (builtInFields) {
      const context: ObservabilityRecord = {};
      for (const [field, fieldValue] of Object.entries(value)) {
        if (!builtInFields.has(field)) continue;
        const sanitizedValue = sanitizeBuiltInContextValue(key, field, fieldValue);
        if (sanitizedValue !== undefined) context[field] = sanitizedValue;
      }
      if (Object.keys(context).length > 0) sanitized[key] = context;
      continue;
    }

    if (!CUSTOM_CONTEXT_KEYS.has(key)) continue;
    const context = sanitizeTechnicalContext(value);
    if (Object.keys(context).length > 0) sanitized[key] = context;
  }
  return sanitized;
}

export function sanitizeSentryBreadcrumb<T extends ObservabilityRecord>(breadcrumb: T): T | null {
  if (breadcrumb.category === 'console') return null;

  const sanitized: ObservabilityRecord = {};
  for (const key of ['category', 'level', 'origin', 'type'] as const) {
    const value = sanitizeTechnicalLabel(breadcrumb[key]);
    if (value !== undefined) sanitized[key] = value;
  }
  if (typeof breadcrumb.timestamp === 'number' && Number.isFinite(breadcrumb.timestamp)) {
    sanitized.timestamp = breadcrumb.timestamp;
  }
  if (typeof breadcrumb.message === 'string') sanitized.message = REDACTED;

  if (isRecord(breadcrumb.data)) {
    const data: ObservabilityRecord = {};
    for (const [key, value] of Object.entries(breadcrumb.data)) {
      if (!SAFE_BREADCRUMB_DATA_KEYS.has(key.toLowerCase())) continue;
      const normalized = key.toLowerCase();
      let sanitizedValue: string | number | undefined;
      if ((normalized === 'url' || normalized === 'route') && typeof value === 'string') {
        sanitizedValue = sanitizeObservabilityUrl(value);
      } else if (normalized === 'status_code') {
        sanitizedValue = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      } else {
        sanitizedValue = sanitizeTechnicalLabel(value);
      }
      if (sanitizedValue !== undefined) data[key] = sanitizedValue;
    }
    if (Object.keys(data).length > 0) sanitized.data = data;
  }

  return Object.keys(sanitized).length > 0 ? (sanitized as T) : null;
}

const SAFE_STACK_FRAME_KEYS = new Set([
  'abs_path',
  'colno',
  'filename',
  'function',
  'image_addr',
  'in_app',
  'instruction_addr',
  'lineno',
  'module',
  'package',
  'platform',
  'raw_function',
  'symbol',
  'symbol_addr',
]);

const STACK_FRAME_NUMBER_KEYS = new Set(['colno', 'lineno']);
const STACK_FRAME_ADDRESS_KEYS = new Set(['image_addr', 'instruction_addr', 'symbol_addr']);

function sanitizeStacktrace(stacktrace: ObservabilityRecord): ObservabilityRecord | undefined {
  if (!Array.isArray(stacktrace.frames)) return undefined;

  const frames = stacktrace.frames.map((frame) => {
    if (!isRecord(frame)) return REDACTED;

    const sanitized: ObservabilityRecord = {};
    for (const [key, value] of Object.entries(frame)) {
      if (!SAFE_STACK_FRAME_KEYS.has(key)) continue;
      if ((key === 'filename' || key === 'abs_path') && typeof value === 'string') {
        sanitized[key] = sanitizeObservabilityUrl(value);
      } else if (STACK_FRAME_NUMBER_KEYS.has(key) && typeof value === 'number') {
        sanitized[key] = value;
      } else if (key === 'in_app' && typeof value === 'boolean') {
        sanitized[key] = value;
      } else if (STACK_FRAME_ADDRESS_KEYS.has(key) && typeof value === 'string') {
        sanitized[key] = sanitizeTechnicalIdentifier(value);
      } else if (typeof value === 'string') {
        sanitized[key] = sanitizeString(value);
      }
    }
    return sanitized;
  });

  return { frames };
}

function sanitizeException(exception: ObservabilityRecord): ObservabilityRecord | undefined {
  if (!Array.isArray(exception.values)) return undefined;

  const values = exception.values.map((value) => {
    if (!isRecord(value)) return REDACTED;

    const sanitized: ObservabilityRecord = {};
    if (typeof value.type === 'string') sanitized.type = sanitizeString(value.type);
    if (typeof value.value === 'string') sanitized.value = REDACTED;
    if (isRecord(value.stacktrace)) {
      const stacktrace = sanitizeStacktrace(value.stacktrace);
      if (stacktrace) sanitized.stacktrace = stacktrace;
    }
    if (isRecord(value.mechanism)) {
      const mechanism: ObservabilityRecord = {};
      for (const key of ['type', 'handled', 'synthetic', 'exception_id', 'parent_id'] as const) {
        const mechanismValue = value.mechanism[key];
        if (
          typeof mechanismValue === 'string' ||
          typeof mechanismValue === 'number' ||
          typeof mechanismValue === 'boolean'
        ) {
          mechanism[key] = sanitizePrimitiveValue(mechanismValue);
        }
      }
      if (Object.keys(mechanism).length > 0) sanitized.mechanism = mechanism;
    }
    return sanitized;
  });

  return { values };
}

function sanitizeThreads(threads: ObservabilityRecord): ObservabilityRecord | undefined {
  if (!Array.isArray(threads.values)) return undefined;

  const values = threads.values.map((value) => {
    if (!isRecord(value)) return REDACTED;

    const sanitized: ObservabilityRecord = {};
    for (const key of ['id', 'current', 'crashed', 'name'] as const) {
      const threadValue = value[key];
      if (
        typeof threadValue === 'string' ||
        typeof threadValue === 'number' ||
        typeof threadValue === 'boolean'
      ) {
        sanitized[key] = sanitizePrimitiveValue(threadValue);
      }
    }
    if (isRecord(value.stacktrace)) {
      const stacktrace = sanitizeStacktrace(value.stacktrace);
      if (stacktrace) sanitized.stacktrace = stacktrace;
    }
    return sanitized;
  });

  return { values };
}

function sanitizeSdk(sdk: ObservabilityRecord): ObservabilityRecord | undefined {
  const sanitized: ObservabilityRecord = {};
  for (const key of ['name', 'version'] as const) {
    if (typeof sdk[key] === 'string') sanitized[key] = sanitizeString(sdk[key]);
  }
  if (Array.isArray(sdk.integrations)) {
    sanitized.integrations = sdk.integrations
      .filter((value): value is string => typeof value === 'string')
      .map(sanitizeString);
  }
  if (Array.isArray(sdk.packages)) {
    sanitized.packages = sdk.packages.flatMap((value) => {
      if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
        return [];
      }
      return [{ name: sanitizeString(value.name), version: sanitizeString(value.version) }];
    });
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeDebugMeta(debugMeta: ObservabilityRecord): ObservabilityRecord | undefined {
  if (!Array.isArray(debugMeta.images)) return undefined;

  const images = debugMeta.images.flatMap((image) => {
    if (!isRecord(image)) return [];
    const sanitized: ObservabilityRecord = {};
    for (const key of [
      'type',
      'debug_id',
      'code_id',
      'image_addr',
      'image_size',
      'arch',
    ] as const) {
      const value = image[key];
      if (typeof value === 'string' || typeof value === 'number') {
        sanitized[key] =
          typeof value === 'string' && ['debug_id', 'code_id', 'image_addr'].includes(key)
            ? sanitizeTechnicalIdentifier(value)
            : sanitizePrimitiveValue(value);
      }
    }
    for (const key of ['code_file', 'debug_file'] as const) {
      const value = image[key];
      if (typeof value === 'string') sanitized[key] = sanitizeObservabilityUrl(value);
    }
    return Object.keys(sanitized).length > 0 ? [sanitized] : [];
  });

  return images.length > 0 ? { images } : undefined;
}

function sanitizeMeasurements(measurements: ObservabilityRecord): ObservabilityRecord {
  const sanitized: ObservabilityRecord = {};
  for (const [key, measurement] of Object.entries(measurements)) {
    if (!isRecord(measurement) || typeof measurement.value !== 'number') continue;
    sanitized[sanitizeString(key)] = {
      value: measurement.value,
      ...(typeof measurement.unit === 'string' && { unit: sanitizeString(measurement.unit) }),
    };
  }
  return sanitized;
}

function sanitizeSdkProcessingMetadata(
  metadata: ObservabilityRecord,
): ObservabilityRecord | undefined {
  const sanitized: ObservabilityRecord = {};

  if (typeof metadata.spanCountBeforeProcessing === 'number') {
    sanitized.spanCountBeforeProcessing = metadata.spanCountBeforeProcessing;
  }

  if (isRecord(metadata.dynamicSamplingContext)) {
    const source = metadata.dynamicSamplingContext;
    const dynamicSamplingContext: ObservabilityRecord = {};
    for (const key of [
      'trace_id',
      'public_key',
      'sample_rate',
      'release',
      'environment',
      'replay_id',
      'sampled',
      'sample_rand',
      'org_id',
    ] as const) {
      const value = source[key];
      if (typeof value === 'string') dynamicSamplingContext[key] = value;
    }
    if (typeof source.transaction === 'string') {
      dynamicSamplingContext.transaction = sanitizeObservabilityUrl(source.transaction);
    }
    if (Object.keys(dynamicSamplingContext).length > 0) {
      sanitized.dynamicSamplingContext = dynamicSamplingContext;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeCspFingerprint(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [category, directive] = value;
  if (
    category !== 'csp-violation' ||
    typeof directive !== 'string' ||
    !/^[a-z0-9-]{1,64}$/u.test(directive)
  ) {
    return undefined;
  }
  return [category, directive];
}

function sanitizeEventBase<T extends ObservabilityRecord>(event: T): T {
  const sanitized: ObservabilityRecord = {};

  for (const key of PROTOCOL_ID_KEYS) {
    const value = event[key];
    if (typeof value === 'string') sanitized[key] = value;
  }
  for (const key of ['timestamp', 'start_timestamp'] as const) {
    if (typeof event[key] === 'number') sanitized[key] = event[key];
  }
  for (const key of ['platform', 'level', 'type', 'logger', 'server_name'] as const) {
    if (typeof event[key] === 'string') sanitized[key] = sanitizeString(event[key]);
  }

  if (typeof event.message === 'string') sanitized.message = sanitizeEventMessage(event.message);
  if (isRecord(event.exception)) {
    const exception = sanitizeException(event.exception);
    if (exception) sanitized.exception = exception;
    else delete sanitized.exception;
  } else delete sanitized.exception;
  if (typeof event.transaction === 'string') {
    sanitized.transaction = sanitizeObservabilityUrl(event.transaction);
  }
  if (typeof event.culprit === 'string') sanitized.culprit = sanitizeString(event.culprit);
  if (isRecord(event.request)) {
    const request = sanitizeRequest(event.request);
    if (Object.keys(request).length > 0) sanitized.request = request;
  }
  if (isRecord(event.user)) {
    const user = sanitizeUser(event.user);
    if (user) sanitized.user = user;
    else delete sanitized.user;
  } else delete sanitized.user;
  if (isRecord(event.extra)) {
    const extra = sanitizeTechnicalContext(event.extra);
    if (Object.keys(extra).length > 0) sanitized.extra = extra;
  }
  if (isRecord(event.tags)) {
    const tags = sanitizeTags(event.tags);
    if (Object.keys(tags).length > 0) sanitized.tags = tags;
  }
  if (isRecord(event.contexts)) {
    const contexts = sanitizeContexts(event.contexts);
    if (Object.keys(contexts).length > 0) sanitized.contexts = contexts;
  }
  if (Array.isArray(event.breadcrumbs)) {
    const breadcrumbs: unknown[] = [];
    for (const breadcrumb of event.breadcrumbs) {
      if (!isRecord(breadcrumb)) {
        breadcrumbs.push(REDACTED);
        continue;
      }
      const sanitizedBreadcrumb = sanitizeSentryBreadcrumb(breadcrumb);
      if (sanitizedBreadcrumb) breadcrumbs.push(sanitizedBreadcrumb);
    }
    if (breadcrumbs.length > 0) sanitized.breadcrumbs = breadcrumbs;
  }
  if (isRecord(event.threads)) {
    const threads = sanitizeThreads(event.threads);
    if (threads) sanitized.threads = threads;
  }
  if (isRecord(event.sdk)) {
    const sdk = sanitizeSdk(event.sdk);
    if (sdk) sanitized.sdk = sdk;
  }
  if (isRecord(event.debug_meta)) {
    const debugMeta = sanitizeDebugMeta(event.debug_meta);
    if (debugMeta) sanitized.debug_meta = debugMeta;
  }
  if (Array.isArray(event.spans)) {
    sanitized.spans = event.spans.map((span) =>
      isRecord(span) ? sanitizeSentrySpan(span) : REDACTED,
    );
  }
  if (isRecord(event.measurements)) {
    sanitized.measurements = sanitizeMeasurements(event.measurements);
  }
  if (isRecord(event.transaction_info) && typeof event.transaction_info.source === 'string') {
    sanitized.transaction_info = { source: sanitizeString(event.transaction_info.source) };
  }
  if (isRecord(event.sdkProcessingMetadata)) {
    const metadata = sanitizeSdkProcessingMetadata(event.sdkProcessingMetadata);
    if (metadata) sanitized.sdkProcessingMetadata = metadata;
  }
  const fingerprint = sanitizeCspFingerprint(event.fingerprint);
  if (fingerprint) sanitized.fingerprint = fingerprint;

  return sanitized as T;
}

export function sanitizeSentryEvent<T extends ObservabilityRecord>(event: T): T {
  return sanitizeEventBase(event);
}

export function sanitizeSentryTransaction<T extends ObservabilityRecord>(event: T): T {
  return sanitizeEventBase(event);
}

const SAFE_SPAN_URL_ATTRIBUTES = new Set([
  'http.route',
  'http.target',
  'http.url',
  'url.full',
  'url.path',
]);
const SAFE_SPAN_STRING_ATTRIBUTES = new Set([
  'db.collection.name',
  'db.namespace',
  'db.operation',
  'db.operation.name',
  'db.system',
  'http.flavor',
  'http.method',
  'http.request.method',
  'http.scheme',
  'network.protocol.name',
  'network.protocol.version',
  'network.transport',
  'resource.delivery_type',
  'resource.render_blocking_status',
  'rpc.method',
  'rpc.service',
  'rpc.system',
  'sentry.op',
  'sentry.origin',
  'sentry.source',
  'server.address',
  'url.scheme',
]);
const SAFE_SPAN_NUMBER_ATTRIBUTES = new Set([
  'http.request.body.size',
  'http.response.body.size',
  'http.response.status_code',
  'http.status_code',
  'resource.decoded_body_size',
  'resource.encoded_body_size',
  'resource.transfer_size',
  'sentry.sample_rate',
  'server.port',
]);
const SAFE_SPAN_BOOLEAN_ATTRIBUTES = new Set(['cache.hit']);

function sanitizeSpanAttributes(attributes: ObservabilityRecord): ObservabilityRecord {
  const sanitized: ObservabilityRecord = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SAFE_SPAN_URL_ATTRIBUTES.has(key) && typeof value === 'string') {
      sanitized[key] = sanitizeObservabilityUrl(value);
    } else if (SAFE_SPAN_STRING_ATTRIBUTES.has(key) && typeof value === 'string') {
      sanitized[key] = sanitizeString(value);
    } else if (SAFE_SPAN_NUMBER_ATTRIBUTES.has(key) && typeof value === 'number') {
      sanitized[key] = value;
    } else if (SAFE_SPAN_BOOLEAN_ATTRIBUTES.has(key) && typeof value === 'boolean') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function sanitizeSentrySpan<T extends ObservabilityRecord>(span: T): T {
  const sanitized: ObservabilityRecord = {};
  for (const key of [
    'trace_id',
    'span_id',
    'parent_span_id',
    'segment_id',
    'profile_id',
  ] as const) {
    if (typeof span[key] === 'string') sanitized[key] = span[key];
  }
  for (const key of ['start_timestamp', 'timestamp', 'end_timestamp', 'exclusive_time'] as const) {
    if (typeof span[key] === 'number') sanitized[key] = span[key];
  }
  for (const key of ['op', 'origin', 'status'] as const) {
    if (typeof span[key] === 'string') sanitized[key] = sanitizeString(span[key]);
  }
  if (typeof span.is_segment === 'boolean') sanitized.is_segment = span.is_segment;

  for (const key of ['description', 'name'] as const) {
    const value = span[key];
    if (typeof value !== 'string') continue;
    const isHttpDescription = /^(?:[A-Z]+\s+)?(?:https?:\/\/|\/)/.test(value);
    sanitized[key] = isHttpDescription ? sanitizeObservabilityUrl(value) : REDACTED;
  }
  if (isRecord(span.data)) sanitized.data = sanitizeSpanAttributes(span.data);
  if (isRecord(span.attributes)) sanitized.attributes = sanitizeSpanAttributes(span.attributes);
  if (isRecord(span.measurements)) {
    sanitized.measurements = sanitizeMeasurements(span.measurements);
  }
  if (Array.isArray(span.links)) {
    sanitized.links = span.links.flatMap((link) => {
      if (
        !isRecord(link) ||
        typeof link.trace_id !== 'string' ||
        typeof link.span_id !== 'string'
      ) {
        return [];
      }
      const sanitizedLink: ObservabilityRecord = {
        trace_id: link.trace_id,
        span_id: link.span_id,
      };
      if (typeof link.sampled === 'boolean') sanitizedLink.sampled = link.sampled;
      if (isRecord(link.attributes) && typeof link.attributes['sentry.link.type'] === 'string') {
        sanitizedLink.attributes = {
          'sentry.link.type': sanitizeString(link.attributes['sentry.link.type']),
        };
      }
      return [sanitizedLink];
    });
  }
  return sanitized as T;
}
