const PATTERNS = [
    {
        // TypeScript: src/x.ts(12,5): error TS2345: msg
        tool: 'typescript',
        re: /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/,
        map: (m) => ({ tool: 'typescript', file: m[1], line: +m[2], column: +m[3], severity: m[4], message: m[5] }),
    },
    {
        // ESLint: /path:12:5  error  msg  rule
        tool: 'eslint',
        re: /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}[\w-/]+)?$/,
        map: (m) => ({ tool: 'eslint', line: +m[1], column: +m[2], severity: m[3], message: m[4] }),
    },
    {
        // Pytest: file.py:12: in test / AssertionError
        tool: 'pytest',
        re: /^(.+\.py):(\d+):\s+(.+)$/,
        map: (m) => ({ tool: 'pytest', file: m[1], line: +m[2], severity: 'error', message: m[3] }),
    },
    {
        // Ruff: file.py:12:5: E501 msg
        tool: 'ruff',
        re: /^(.+\.py):(\d+):(\d+):\s+(\w+\d+)\s+(.+)$/,
        map: (m) => ({ tool: 'ruff', file: m[1], line: +m[2], column: +m[3], severity: 'error', message: `${m[4]} ${m[5]}` }),
    },
    {
        // Go: ./file.go:12:5: msg
        tool: 'go',
        re: /^(.+\.go):(\d+):(\d+):\s+(.+)$/,
        map: (m) => ({ tool: 'go', file: m[1], line: +m[2], column: +m[3], severity: 'error', message: m[4] }),
    },
    {
        // Rust: error[E0382]: msg
        tool: 'rust',
        re: /^error(?:\[[A-Z]\d+\])?:\s+(.+)$/,
        map: (m) => ({ tool: 'rust', severity: 'error', message: m[1] }),
    },
    {
        // Vitest/Jest: FAIL path > test name
        tool: 'vitest',
        re: /^\s*(?:FAIL|✗|×)\s+(.+)$/,
        map: (m) => ({ tool: 'vitest', severity: 'error', message: m[1] }),
    },
];
export function parseErrors(output) {
    const errors = [];
    for (const line of output.split('\n')) {
        for (const p of PATTERNS) {
            const m = p.re.exec(line.trim());
            if (m) {
                errors.push(p.map(m));
                break;
            }
        }
    }
    return errors.slice(0, 100);
}
