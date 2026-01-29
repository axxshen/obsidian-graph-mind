/**
 * Advanced Query Parser (Graph Mind-style)
 * Supports: ext:md, path:folder, -exclude, "exact match", #tags
 */

export interface ParsedQuery {
    text: string[];           // Normal search terms
    exactTerms: string[];     // "quoted exact matches"
    tags: string[];           // #tags to search
    extensions: string[];     // ext:md, ext:pdf
    pathIncludes: string[];   // path:folder/subfolder
    pathExcludes: string[];   // -path:exclude
    textExcludes: string[];   // -exclude terms
}

export function parseQuery(rawQuery: string): ParsedQuery {
    const parsed: ParsedQuery = {
        text: [],
        exactTerms: [],
        tags: [],
        extensions: [],
        pathIncludes: [],
        pathExcludes: [],
        textExcludes: []
    };

    let remaining = rawQuery;

    // 1. Extract quoted exact matches: "hello world"
    const quoteRegex = /"([^"]+)"/g;
    let match;
    while ((match = quoteRegex.exec(rawQuery)) !== null) {
        parsed.exactTerms.push(match[1].toLowerCase());
        remaining = remaining.replace(match[0], '');
    }

    // 2. Extract tags: #mytag
    const tagRegex = /#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
    while ((match = tagRegex.exec(remaining)) !== null) {
        parsed.tags.push(match[0]); // Keep # prefix
        remaining = remaining.replace(match[0], '');
    }

    // 3. Extract ext: filters
    const extRegex = /ext:(\w+)/gi;
    while ((match = extRegex.exec(remaining)) !== null) {
        parsed.extensions.push(match[1].toLowerCase());
        remaining = remaining.replace(match[0], '');
    }

    // 4. Extract path includes: path:folder/subfolder
    const pathIncludeRegex = /(?<!-)path:([^\s]+)/gi;
    while ((match = pathIncludeRegex.exec(remaining)) !== null) {
        parsed.pathIncludes.push(match[1].toLowerCase());
        remaining = remaining.replace(match[0], '');
    }

    // 5. Extract path excludes: -path:folder
    const pathExcludeRegex = /-path:([^\s]+)/gi;
    while ((match = pathExcludeRegex.exec(remaining)) !== null) {
        parsed.pathExcludes.push(match[1].toLowerCase());
        remaining = remaining.replace(match[0], '');
    }

    // 6. Extract text excludes: -word
    const excludeRegex = /-(\w+)/g;
    while ((match = excludeRegex.exec(remaining)) !== null) {
        parsed.textExcludes.push(match[1].toLowerCase());
        remaining = remaining.replace(match[0], '');
    }

    // 7. Remaining tokens are normal search terms
    parsed.text = remaining
        .split(/\s+/)
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);

    return parsed;
}

/**
 * Check if result matches advanced filters
 */
export function matchesFilters(
    result: any,
    parsed: ParsedQuery,
    docContent: string
): boolean {
    const path = (result.path || result.id || '').toLowerCase();
    const content = docContent.toLowerCase();

    // Extension filter
    if (parsed.extensions.length > 0) {
        const ext = path.split('.').pop() || '';
        if (!parsed.extensions.some(e => ext === e || ext.startsWith(e))) {
            return false;
        }
    }

    // Path includes
    if (parsed.pathIncludes.length > 0) {
        if (!parsed.pathIncludes.some(p => path.includes(p))) {
            return false;
        }
    }

    // Path excludes
    if (parsed.pathExcludes.length > 0) {
        if (parsed.pathExcludes.some(p => path.includes(p))) {
            return false;
        }
    }

    // Exact term matches (must be in content)
    if (parsed.exactTerms.length > 0) {
        if (!parsed.exactTerms.every(term => content.includes(term))) {
            return false;
        }
    }

    // Text excludes
    if (parsed.textExcludes.length > 0) {
        if (parsed.textExcludes.some(term => content.includes(term))) {
            return false;
        }
    }

    return true;
}
