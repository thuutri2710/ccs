/**
 * Folder-to-profile routing rules.
 *
 * Used by the `ccs rule` command and the generated claude() shell wrapper to
 * pick a profile based on the directory the user launches Claude from.
 * Matching is "longest path wins": the most specific matching rule is used,
 * and when nothing matches the wrapper falls back to plain `claude`.
 */

export interface FolderRule {
  /** Absolute folder path this rule applies to (prefix match on path boundaries). */
  path: string;
  /** Profile name to launch when the current directory is inside `path`. */
  profile: string;
}

/**
 * Coerce arbitrary parsed YAML into a clean FolderRule[].
 * Drops malformed entries; returns undefined when nothing valid remains so the
 * serializer can omit an empty `rules:` block.
 */
export function normalizeFolderRules(value: unknown): FolderRule[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const rules: FolderRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const rulePath = typeof record.path === 'string' ? record.path.trim() : '';
    const profile = typeof record.profile === 'string' ? record.profile.trim() : '';
    if (rulePath && profile) {
      rules.push({ path: rulePath, profile });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Resolve the matching rule for a target path using "longest path wins".
 * A rule matches when the target equals its path or sits inside it on a path
 * boundary (so /a/b does not match /a/bc).
 */
export function matchFolderRule(
  rules: readonly FolderRule[],
  targetPath: string
): FolderRule | undefined {
  let best: FolderRule | undefined;
  let bestLength = -1;

  for (const rule of rules) {
    const base = rule.path;
    const withSep = base.endsWith('/') ? base : `${base}/`;
    if (targetPath === base || targetPath.startsWith(withSep)) {
      if (base.length > bestLength) {
        bestLength = base.length;
        best = rule;
      }
    }
  }

  return best;
}
