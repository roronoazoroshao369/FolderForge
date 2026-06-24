/**
 * Secret detection and redaction.
 */
const RULES = [
    { name: 'OpenAI key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
    { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
    { name: 'Generic assignment', re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*['"]?[^\s'"]{6,}/gi },
    { name: 'Env secret', re: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|GITHUB_TOKEN)\s*=\s*\S+/g },
];
const NAMED_ENV = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN',
    'GOOGLE_API_KEY',
    'DATABASE_URL',
];
export class SecretPolicy {
    redact(text) {
        let out = text;
        for (const rule of RULES) {
            out = out.replace(rule.re, (m) => {
                if (rule.name === 'Generic assignment') {
                    const eq = m.search(/[=:]/);
                    return `${m.slice(0, eq + 1)} [REDACTED]`;
                }
                if (rule.name === 'Env secret') {
                    const eq = m.indexOf('=');
                    return `${m.slice(0, eq + 1)}[REDACTED]`;
                }
                return '[REDACTED]';
            });
        }
        return out;
    }
    redactEnv(env) {
        const out = {};
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined)
                continue;
            if (NAMED_ENV.includes(k) || /key|secret|token|password|passwd/i.test(k)) {
                out[k] = '[REDACTED]';
            }
            else {
                out[k] = v;
            }
        }
        return out;
    }
    scan(text) {
        const findings = [];
        const lines = text.split('\n');
        lines.forEach((line, i) => {
            for (const rule of RULES) {
                rule.re.lastIndex = 0;
                const m = rule.re.exec(line);
                if (m) {
                    findings.push({
                        rule: rule.name,
                        preview: m[0].slice(0, 12) + '...',
                        line: i + 1,
                    });
                }
            }
        });
        return findings;
    }
}
