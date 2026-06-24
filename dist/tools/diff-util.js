/**
 * A compact, dependency-free line-based diff for previews (LCS).
 */
export function simpleDiff(before, after, label = 'file') {
    if (before === after)
        return `--- ${label}\n(no changes)`;
    const a = before.split('\n');
    const b = after.split('\n');
    const n = a.length;
    const m = b.length;
    // LCS table (kept small enough for typical files)
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const lines = [`--- ${label} (before)`, `+++ ${label} (after)`];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            lines.push(`  ${a[i]}`);
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            lines.push(`- ${a[i]}`);
            i++;
        }
        else {
            lines.push(`+ ${b[j]}`);
            j++;
        }
    }
    while (i < n)
        lines.push(`- ${a[i++]}`);
    while (j < m)
        lines.push(`+ ${b[j++]}`);
    // Trim very large diffs.
    if (lines.length > 400) {
        return lines.slice(0, 400).join('\n') + `\n... (${lines.length - 400} more lines)`;
    }
    return lines.join('\n');
}
