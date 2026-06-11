import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { matchFolderRule, normalizeFolderRules } from '../../src/config/schemas/rules';

/** Capture console output produced by an action (no process.exit expected). */
async function capture(action: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await action();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

/** Capture output for an action expected to call process.exit(code). */
async function captureExit(action: () => Promise<void>, code: number): Promise<string> {
  const originalExit = process.exit;
  const originalLog = console.log;
  const lines: string[] = [];
  process.exit = ((c?: number) => {
    throw new Error(`process.exit(${c ?? 0})`);
  }) as typeof process.exit;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await expect(action()).rejects.toThrow(`process.exit(${code})`);
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
  }
  return lines.join('\n');
}

describe('rule matching (matchFolderRule)', () => {
  it('returns the longest matching path', () => {
    const rules = [
      { path: '/a/b', profile: 'outer' },
      { path: '/a/b/c', profile: 'inner' },
    ];
    expect(matchFolderRule(rules, '/a/b/c/d')?.profile).toBe('inner');
    expect(matchFolderRule(rules, '/a/b/x')?.profile).toBe('outer');
  });

  it('matches the exact path', () => {
    const rules = [{ path: '/a/b', profile: 'p' }];
    expect(matchFolderRule(rules, '/a/b')?.profile).toBe('p');
  });

  it('does not match across path boundaries', () => {
    const rules = [{ path: '/a/b', profile: 'p' }];
    expect(matchFolderRule(rules, '/a/bc')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    const rules = [{ path: '/x', profile: 'p' }];
    expect(matchFolderRule(rules, '/y/z')).toBeUndefined();
  });
});

describe('normalizeFolderRules', () => {
  it('drops malformed entries and returns undefined when empty', () => {
    expect(normalizeFolderRules(undefined)).toBeUndefined();
    expect(normalizeFolderRules([{ path: '' }, { profile: 'x' }, 42])).toBeUndefined();
    expect(normalizeFolderRules([{ path: '/a', profile: 'glm' }, { path: '/b' }])).toEqual([
      { path: '/a', profile: 'glm' },
    ]);
  });
});

describe('ccs rule command', () => {
  let tempRoot = '';
  let originalCcsHome: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-rule-'));
    fs.mkdirSync(path.join(tempRoot, '.ccs'), { recursive: true });
    originalCcsHome = process.env.CCS_HOME;
    originalNoColor = process.env.NO_COLOR;
    process.env.CCS_HOME = tempRoot;
    process.env.NO_COLOR = '1';
  });

  afterEach(() => {
    if (originalCcsHome !== undefined) process.env.CCS_HOME = originalCcsHome;
    else delete process.env.CCS_HOME;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function readRules() {
    // Re-import to read fresh config from disk (respects CCS_HOME).
    const { loadUnifiedConfig } = require('../../src/config/unified-config-loader');
    return loadUnifiedConfig()?.rules ?? [];
  }

  it('add stores an explicit path -> profile rule and persists in config.yaml', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');
    const target = path.join(tempRoot, 'work');

    const out = await capture(() => handleRuleCommand(['add', 'glm', target]));

    expect(out).toContain('Added rule');
    expect(out).toContain(target);
    expect(out).toContain('glm');

    const rules = readRules();
    expect(rules).toEqual([{ path: target, profile: 'glm' }]);

    // The serializer must actually emit the section (whitelist serializer).
    const raw = fs.readFileSync(path.join(tempRoot, '.ccs', 'config.yaml'), 'utf8');
    expect(raw).toContain('rules:');
    expect(raw).toContain(target);
  });

  it('add with no path defaults to the current directory', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');

    await capture(() => handleRuleCommand(['add', 'kimi']));

    const rules = readRules();
    expect(rules).toEqual([{ path: process.cwd(), profile: 'kimi' }]);
  });

  it('add expands a leading ~ to the home directory', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');

    await capture(() => handleRuleCommand(['add', 'glm', '~/proj']));

    const rules = readRules();
    expect(rules).toEqual([{ path: path.join(os.homedir(), 'proj'), profile: 'glm' }]);
  });

  it('add updates the profile when the path already has a rule', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');
    const target = path.join(tempRoot, 'work');

    await capture(() => handleRuleCommand(['add', 'glm', target]));
    const out = await capture(() => handleRuleCommand(['add', 'kimi', target]));

    expect(out).toContain('Updated rule');
    expect(readRules()).toEqual([{ path: target, profile: 'kimi' }]);
  });

  it('remove deletes a rule', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');
    const target = path.join(tempRoot, 'work');

    await capture(() => handleRuleCommand(['add', 'glm', target]));
    const out = await capture(() => handleRuleCommand(['remove', target]));

    expect(out).toContain('Removed rule');
    expect(readRules()).toEqual([]);
  });

  it('remove warns (does not error) when no rule exists', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');
    const out = await capture(() => handleRuleCommand(['remove', path.join(tempRoot, 'nope')]));
    expect(out).toContain('No rule found');
  });

  it('list shows configured rules and marks the current-directory match', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');
    const cwd = process.cwd();

    await capture(() => handleRuleCommand(['add', 'outer', cwd]));
    await capture(() => handleRuleCommand(['add', 'glm', path.join(tempRoot, 'elsewhere')]));

    const out = await capture(() => handleRuleCommand(['list']));
    expect(out).toContain('outer');
    expect(out).toContain('glm');
    expect(out).toContain('matches current directory');
  });

  it('list reports when no rules are configured', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');
    const out = await capture(() => handleRuleCommand(['list']));
    expect(out).toContain('No rules configured');
  });

  it('add without a profile exits with an error', async () => {
    const { handleRuleCommand } = await import('../../src/commands/rule-command');
    const out = await captureExit(() => handleRuleCommand(['add']), 1);
    expect(out).toContain('Missing profile name');
  });
});
