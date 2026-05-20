/**
 * Tiny unified-diff helper used by `--check`.
 *
 * We deliberately don't pull in a 3rd-party diff library: the
 * generated output is small, so an O(n·m) line-level diff is fast
 * enough. The output format mimics `diff -u` closely enough that
 * a human can read it and tooling can rely on it for "is anything
 * different" decisions.
 */

export function unifiedDiff(
  oldText: string,
  newText: string,
  oldName = 'committed',
  newName = 'generated',
): string {
  if (oldText === newText) return '';
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = lcsDiff(oldLines, newLines);
  const out: string[] = [`--- ${oldName}`, `+++ ${newName}`];
  for (const op of ops) {
    if (op.kind === 'context') out.push(` ${op.line}`);
    else if (op.kind === 'add') out.push(`+${op.line}`);
    else out.push(`-${op.line}`);
  }
  return out.join('\n');
}

type Op =
  | { kind: 'context'; line: string }
  | { kind: 'add'; line: string }
  | { kind: 'del'; line: string };

function lcsDiff(a: readonly string[], b: readonly string[]): Op[] {
  const m = a.length;
  const n = b.length;
  // LCS length table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // Walk to produce edit ops.
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', line: a[i]! });
      i++;
    } else {
      out.push({ kind: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', line: a[i++]! });
  while (j < n) out.push({ kind: 'add', line: b[j++]! });
  return out;
}
