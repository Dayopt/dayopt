/**
 * union の分岐を閉じる。`switch` の `default` で呼ぶと、case の漏れが型エラーになる。
 * 実行時に到達した場合（外部入力が型と食い違った場合）は値を含めて throw する。
 *
 * @see docs/engineering/conventions.md §正本と派生（判断と展開の分離）
 */
export function assertNever(value: never, context?: string): never {
  const label = context ? `${context}: ` : '';
  throw new Error(`Unhandled variant: ${label}${JSON.stringify(value)}`);
}
