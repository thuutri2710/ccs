/**
 * Rule Command Handler
 *
 * Manage folder-to-profile routing rules stored under `rules:` in
 * ~/.ccs/config.yaml. These rules drive the generated claude() shell wrapper,
 * which auto-selects a profile based on the directory Claude is launched from.
 *
 *   ccs rule add <profile> [path]   Route a folder (and subfolders) to a profile
 *   ccs rule remove [path]          Remove the rule for a folder
 *   ccs rule list                   Show all rules
 *
 * [path] defaults to the current directory. Matching is "longest path wins".
 */

import * as os from 'os';
import * as path from 'path';
import { initUI, ok, warn, info, header } from '../utils/ui';
import { dispatchNamedCommand, type NamedCommandRoute } from './named-command-router';
import { loadOrCreateUnifiedConfig, mutateUnifiedConfig } from '../config/unified-config-loader';
import { matchFolderRule } from '../config/schemas/rules';

const HELP_TOKENS = ['--help', '-h'];

function wantsHelp(args: string[]): boolean {
  return args.some((arg) => HELP_TOKENS.includes(arg));
}

function positionals(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-'));
}

/** Expand a leading ~ to the user's home directory. */
function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** Resolve a rule path argument to an absolute, normalized path (defaults to cwd). */
function resolveRulePath(input?: string): string {
  const raw = input && input.trim().length > 0 ? input.trim() : process.cwd();
  return path.resolve(expandHome(raw));
}

async function handleAdd(args: string[]): Promise<void> {
  await initUI();

  if (wantsHelp(args)) {
    await showHelp();
    return;
  }

  const pos = positionals(args);
  const profile = pos[0];
  if (!profile) {
    console.log(warn('Missing profile name'));
    console.log('');
    console.log('Usage: ccs rule add <profile> [path]');
    process.exit(1);
  }

  const rulePath = resolveRulePath(pos[1]);

  let existed = false;
  mutateUnifiedConfig((config) => {
    const rules = config.rules ? [...config.rules] : [];
    const index = rules.findIndex((rule) => rule.path === rulePath);
    if (index >= 0) {
      existed = true;
      rules[index] = { path: rulePath, profile };
    } else {
      rules.push({ path: rulePath, profile });
    }
    config.rules = rules;
  });

  console.log(ok(`${existed ? 'Updated' : 'Added'} rule: ${rulePath} -> ${profile}`));
}

async function handleRemove(args: string[]): Promise<void> {
  await initUI();

  if (wantsHelp(args)) {
    await showHelp();
    return;
  }

  const rulePath = resolveRulePath(positionals(args)[0]);

  let removed = false;
  mutateUnifiedConfig((config) => {
    const rules = config.rules ? [...config.rules] : [];
    const index = rules.findIndex((rule) => rule.path === rulePath);
    if (index >= 0) {
      rules.splice(index, 1);
      removed = true;
      config.rules = rules.length > 0 ? rules : undefined;
    }
  });

  if (removed) {
    console.log(ok(`Removed rule for: ${rulePath}`));
  } else {
    console.log(warn(`No rule found for: ${rulePath}`));
  }
}

async function handleList(): Promise<void> {
  await initUI();

  const config = loadOrCreateUnifiedConfig();
  const rules = config.rules ?? [];

  console.log('');
  console.log(header('Folder Routing Rules'));
  console.log('');

  if (rules.length === 0) {
    console.log(info('No rules configured'));
    console.log('');
    console.log('Add one with: ccs rule add <profile> [path]');
    return;
  }

  const winner = matchFolderRule(rules, process.cwd());
  // Sort longest path first so the listing mirrors match precedence.
  const sorted = [...rules].sort(
    (a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path)
  );
  const profileWidth = Math.max(...sorted.map((rule) => rule.profile.length));

  for (const rule of sorted) {
    const isWinner = winner?.path === rule.path && winner?.profile === rule.profile;
    const marker = isWinner ? '*' : ' ';
    const suffix = isWinner ? '  (matches current directory)' : '';
    console.log(`  ${marker} ${rule.profile.padEnd(profileWidth)}  ${rule.path}${suffix}`);
  }

  console.log('');
  console.log(info(`${rules.length} rule${rules.length === 1 ? '' : 's'} configured`));
}

async function showHelp(): Promise<void> {
  await initUI();
  console.log('');
  console.log(header('ccs rule - Folder-to-profile routing'));
  console.log('');
  console.log('Usage: ccs rule <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  add <profile> [path]   Route a folder (and its subfolders) to a profile');
  console.log('  remove [path]          Remove the rule for a folder');
  console.log('  list                   Show all routing rules');
  console.log('');
  console.log('Notes:');
  console.log('  - [path] defaults to the current directory when omitted.');
  console.log('  - Most specific (longest) matching path wins; no match runs plain claude.');
  console.log('  - The claude() shell wrapper uses these rules to auto-select a profile.');
  console.log('');
  console.log('Examples:');
  console.log('  ccs rule add glm                 Route the current folder to "glm"');
  console.log('  ccs rule add kimi ~/work/secret  Route a specific folder to "kimi"');
  console.log('  ccs rule remove                  Remove the current folder rule');
  console.log('  ccs rule list                    List all rules');
  console.log('');
}

const RULE_ROUTES: readonly NamedCommandRoute[] = [
  { name: 'add', handle: handleAdd },
  { name: 'remove', aliases: ['rm', 'delete'], handle: handleRemove },
  { name: 'list', aliases: ['ls'], handle: () => handleList() },
];

export async function handleRuleCommand(args: string[]): Promise<void> {
  await dispatchNamedCommand({
    args,
    routes: RULE_ROUTES,
    onHelp: showHelp,
    allowEmptyHelp: true,
    onUnknown: async (command) => {
      await initUI();
      console.log(warn(`Unknown rule command: ${command}`));
      await showHelp();
      process.exit(1);
    },
  });
}
