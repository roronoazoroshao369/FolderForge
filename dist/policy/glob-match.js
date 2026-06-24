/**
 * Minimal, dependency-free glob matcher supporting:
 *   *      -> any chars except '/'
 *   **     -> any chars including '/'
 *   ?      -> single char except '/'
 *   {a,b}  -> alternation
 *   .      -> literal dot
 * Patterns are matched against forward-slash paths.
 */
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // ** (optionally followed by /)
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                }
                else {
                    re += '.*';
                    i += 1;
                }
            }
            else {
                re += '[^/]*';
            }
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end > -1) {
                const parts = glob.slice(i + 1, end).split(',').map(escapeLiteral);
                re += `(?:${parts.join('|')})`;
                i = end;
            }
            else {
                re += '\\{';
            }
        }
        else {
            re += escapeLiteral(c ?? '');
        }
    }
    return new RegExp(`^${re}$`);
}
function escapeLiteral(s) {
    return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
const cache = new Map();
export default function picomatchLite(pattern, value) {
    let re = cache.get(pattern);
    if (!re) {
        re = globToRegExp(pattern);
        cache.set(pattern, re);
    }
    return re.test(value);
}
