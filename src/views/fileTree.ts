interface FolderLevel<T extends { path: string }> {
  dirs: string[];
  files: T[];
}

/**
 * One level of a path tree under `prefix` (posix, no trailing slash).
 * `prefix === ''` is the repo root. Works over anything path-shaped
 * (diff FileChange entries, plain explorer listings, …).
 */
export function childrenAtPrefix<T extends { path: string }>(
  files: T[],
  prefix: string,
): FolderLevel<T> {
  const dirSet = new Set<string>();
  const direct: T[] = [];
  const prefixWithSlash = prefix ? `${prefix}/` : '';

  for (const f of files) {
    if (prefix) {
      if (f.path === prefix || !f.path.startsWith(prefixWithSlash)) continue;
    }

    const rest = prefix ? f.path.slice(prefixWithSlash.length) : f.path;
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      direct.push(f);
    } else {
      dirSet.add(rest.slice(0, slash));
    }
  }

  const dirs = [...dirSet].sort((a, b) => a.localeCompare(b));
  direct.sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, files: direct };
}

export function joinPrefix(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

