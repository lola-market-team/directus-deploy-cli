// Split a SQL blob into individual statements. Respects:
//   -- line comments (up to newline)
//   /* block comments */
//   'single-quoted' strings (with '' escape)
//   $$ or $tag$ dollar-quoted blocks (Postgres)
//
// Naive splitters (e.g. `raw-query/execute`'s server-side one that we've been
// dodging all day) don't understand comments and blow up on any semicolon in
// a comment. We do it correctly here.
export function splitSql(input) {
    const out = [];
    let buf = "";
    let i = 0;
    const n = input.length;
    const push = () => {
        const trimmed = buf.trim();
        if (trimmed)
            out.push(trimmed);
        buf = "";
    };
    while (i < n) {
        const c = input[i];
        const c2 = input[i + 1] ?? "";
        // Line comment: --... until newline
        if (c === "-" && c2 === "-") {
            buf += c + c2;
            i += 2;
            while (i < n && input[i] !== "\n") {
                buf += input[i];
                i += 1;
            }
            continue;
        }
        // Block comment: /* ... */ (non-nested, per SQL spec's most common usage)
        if (c === "/" && c2 === "*") {
            buf += c + c2;
            i += 2;
            while (i < n && !(input[i] === "*" && input[i + 1] === "/")) {
                buf += input[i];
                i += 1;
            }
            if (i < n) {
                buf += "*/";
                i += 2;
            }
            continue;
        }
        // Single-quoted string: '...' with '' escape
        if (c === "'") {
            buf += c;
            i += 1;
            while (i < n) {
                const ch = input[i];
                buf += ch;
                i += 1;
                if (ch === "'") {
                    if (input[i] === "'") {
                        buf += "'";
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        // Dollar-quoted block: $tag$ ... $tag$ (tag can be empty)
        if (c === "$") {
            const tagEnd = input.indexOf("$", i + 1);
            // Consider it a dollar quote only if what's between the two $ is an
            // identifier-like tag (letters/digits/_) or empty AND the closing tag
            // appears later.
            if (tagEnd !== -1) {
                const tag = input.slice(i + 1, tagEnd);
                if (/^[A-Za-z0-9_]*$/.test(tag)) {
                    const closer = `$${tag}$`;
                    const closeAt = input.indexOf(closer, tagEnd + 1);
                    if (closeAt !== -1) {
                        buf += input.slice(i, closeAt + closer.length);
                        i = closeAt + closer.length;
                        continue;
                    }
                }
            }
            buf += c;
            i += 1;
            continue;
        }
        // Statement terminator
        if (c === ";") {
            buf += ";";
            i += 1;
            push();
            continue;
        }
        buf += c;
        i += 1;
    }
    push();
    return out;
}
//# sourceMappingURL=sql.js.map