#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * CCS Postinstall Script
 * Automatically creates config files in ~/.ccs/ after npm install
 *
 * Runs when: npm install -g @kaitranntt/ccs
 * Idempotent: Safe to run multiple times (won't overwrite existing configs)
 * Cross-platform: Works on Unix, macOS, Windows
 *
 * Test isolation: Set CCS_HOME env var to redirect all operations to a test directory
 */

/**
 * Get the CCS home directory (respects CCS_HOME env var for test isolation)
 * @returns {string} Home directory path
 */
function getCcsHome() {
  return process.env.CCS_HOME || os.homedir();
}

// Markers delimit the ccs-managed claude() function inside the user's shell rc.
// Idempotency and later updates/removal key off these exact lines.
const CLAUDE_FN_MARKER_START = '# >>> ccs custom claude (managed) >>>';
const CLAUDE_FN_MARKER_END = '# <<< ccs custom claude (managed) <<<';

// Folder-aware claude() wrapper: picks a ccs profile from ~/.ccs/config.yaml
// based on the current directory, then launches Claude through that profile.
// Single-quoted JS strings keep shell $vars/${...} literal; \\ emits a literal backslash.
const CLAUDE_FN_LINES = [
  CLAUDE_FN_MARKER_START,
  'claude() {',
  '  local cwd profile config',
  '  cwd=$(pwd)',
  '  config="$HOME/.ccs/config.yaml"',
  '  # No config (or yq missing) -> behave like plain claude',
  '  if [ ! -f "$config" ] || ! command -v yq >/dev/null 2>&1; then',
  '    command claude "$@"',
  '    return',
  '  fi',
  '  profile=$(yq -r \'.default\' "$config")',
  "  while IFS=$'\\t' read -r match rule_profile; do",
  '    local expanded_match="${match/#\\~/$HOME}"',
  '    if [[ "$cwd" == "$expanded_match"* ]]; then',
  '      profile="$rule_profile"',
  '      break',
  '    fi',
  '  done < <(yq -r \'.rules[] | [.match, .profile] | @tsv\' "$config")',
  '  if [ -z "$profile" ] || [ "$profile" = "null" ]; then',
  '    command claude "$@"',
  '  else',
  '    command ccs "$profile" "$@"',
  '  fi',
  '}',
  CLAUDE_FN_MARKER_END,
];

/**
 * Install the ccs-managed claude() function into the user's shell rc files.
 *
 * Idempotent and non-destructive:
 *   - Skips a file that already contains the managed block.
 *   - Skips (does not clobber) a file that defines its own claude() function.
 *   - Targets ~/.zshrc (created if absent) and ~/.bashrc (only if it exists).
 *
 * Opt out by setting CCS_NO_SHELL_INIT=1. Never throws - shell setup is
 * convenience, not a hard install dependency.
 *
 * @param {string} homedir - Home directory (respects CCS_HOME for test isolation)
 */
function installClaudeShellFunction(homedir) {
  if (process.env.CCS_NO_SHELL_INIT === '1' || process.env.CCS_NO_SHELL_INIT === 'true') {
    console.log('[i] Skipped claude() shell setup (CCS_NO_SHELL_INIT set)');
    return;
  }

  // Detects a user-defined `claude()` or `function claude` not managed by ccs.
  const ownFunctionPattern = /(^|\n)\s*(function\s+claude\b|claude\s*\(\s*\))/;
  const block = `\n${CLAUDE_FN_LINES.join('\n')}\n`;

  // Always ensure .zshrc (zsh is the default shell on macOS); only touch
  // .bashrc when it already exists so we never create stray rc files.
  const targets = [{ file: '.zshrc', create: true }];
  const bashrc = path.join(homedir, '.bashrc');
  if (fs.existsSync(bashrc)) {
    targets.push({ file: '.bashrc', create: false });
  }

  for (const target of targets) {
    const rcPath = path.join(homedir, target.file);
    try {
      const exists = fs.existsSync(rcPath);
      const content = exists ? fs.readFileSync(rcPath, 'utf8') : '';

      if (content.includes(CLAUDE_FN_MARKER_START)) {
        console.log(`[OK] claude() already installed: ~/${target.file} (preserved)`);
        continue;
      }

      if (ownFunctionPattern.test(content)) {
        console.log(`[!] Found your own claude() in ~/${target.file} - left untouched`);
        continue;
      }

      if (!exists && !target.create) {
        continue;
      }

      fs.appendFileSync(rcPath, block, 'utf8');
      console.log(`[OK] Added claude() function: ~/${target.file}`);
      console.log(`      Reload with: source ~/${target.file}`);
    } catch (err) {
      console.warn(`[!] Could not update ~/${target.file}: ${err.message}`);
    }
  }
}

/**
 * Check if path is a broken symlink and remove it if so
 * Fixes: ENOENT error when mkdir tries to create over a dangling symlink
 * @param {string} targetPath - Path to check
 * @returns {boolean} true if broken symlink was removed
 */
function removeIfBrokenSymlink(targetPath) {
  try {
    // lstatSync doesn't follow symlinks - it checks the link itself
    const stats = fs.lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      // Check if symlink target exists
      try {
        fs.statSync(targetPath); // This follows symlinks
        return false; // Symlink is valid
      } catch {
        // Target doesn't exist - broken symlink
        fs.unlinkSync(targetPath);
        console.log(`[!] Removed broken symlink: ${targetPath}`);
        return true;
      }
    }
    return false;
  } catch {
    // Path doesn't exist at all
    return false;
  }
}

/**
 * Validate created configuration files
 * @returns {object} { success: boolean, errors: string[], warnings: string[] }
 */
function validateConfiguration() {
  const homedir = getCcsHome();
  const errors = [];
  const warnings = [];

  // Check ~/.ccs/ directory
  const ccsDir = path.join(homedir, '.ccs');
  if (!fs.existsSync(ccsDir)) {
    errors.push('~/.ccs/ directory not found');
  }

  // Check for config file - prefer config.yaml, fallback to config.json
  const configYaml = path.join(ccsDir, 'config.yaml');
  const configJson = path.join(ccsDir, 'config.json');
  const hasConfig = fs.existsSync(configYaml) || fs.existsSync(configJson);

  if (!hasConfig) {
    errors.push('config.yaml (or config.json) not found');
  }

  // Check ~/.claude/settings.json (warning only, not critical)
  const claudeSettings = path.join(homedir, '.claude', 'settings.json');
  if (!fs.existsSync(claudeSettings)) {
    warnings.push('~/.claude/settings.json not found - run "claude /login"');
  }

  return { success: errors.length === 0, errors, warnings };
}

function createConfigFiles() {
  try {
    // Get user home directory (cross-platform, respects CCS_HOME for test isolation)
    const homedir = getCcsHome();
    const ccsDir = path.join(homedir, '.ccs');

    // Create ~/.ccs/ directory if missing
    if (fs.existsSync(ccsDir)) {
      // Check if it's a file instead of directory (edge case)
      const stats = fs.statSync(ccsDir);
      if (!stats.isDirectory()) {
        console.error('[X] ~/.ccs exists but is not a directory');
        console.error('    Remove or rename it: mv ~/.ccs ~/.ccs.bak');
        process.exit(1);
      }
    } else {
      fs.mkdirSync(ccsDir, { recursive: true, mode: 0o755 });
      console.log('[OK] Created directory: ~/.ccs/');
    }

    // Create ~/.ccs/shared/ directory structure (Phase 1)
    const sharedDir = path.join(ccsDir, 'shared');
    // Handle broken symlinks (common when upgrading from older versions)
    removeIfBrokenSymlink(sharedDir);
    if (!fs.existsSync(sharedDir)) {
      fs.mkdirSync(sharedDir, { recursive: true, mode: 0o755 });
      console.log('[OK] Created directory: ~/.ccs/shared/');
    }

    // Create shared subdirectories
    const sharedSubdirs = ['commands', 'skills', 'agents', 'plugins'];
    for (const subdir of sharedSubdirs) {
      const subdirPath = path.join(sharedDir, subdir);
      // Handle broken symlinks before creating directory
      removeIfBrokenSymlink(subdirPath);
      if (!fs.existsSync(subdirPath)) {
        fs.mkdirSync(subdirPath, { recursive: true, mode: 0o755 });
        console.log(`[OK] Created directory: ~/.ccs/shared/${subdir}/`);
      }
    }

    // Migrate from v3.1.1 to v3.2.0 (symlink architecture)
    console.log('');
    try {
      const SharedManager = require('../dist/management/shared-manager').default;
      const sharedManager = new SharedManager();
      sharedManager.migrateFromV311();
      sharedManager.ensureSharedDirectories();

      // Run v4.4 migration: Migrate instances to shared settings.json
      sharedManager.migrateToSharedSettings();
    } catch (err) {
      console.warn('[!] Migration warning:', err.message);
      console.warn('    Migration will retry on next run');
    }
    console.log('');

    // NOTE: .claude/ directory installation moved to "ccs sync" command
    // Users can run "ccs sync" to install CCS commands/skills to ~/.claude/
    // This gives users control over when to modify their Claude configuration

    // Create config.yaml if missing (primary format)
    // NOTE: gemini/codex profiles NOT included - they are added on-demand when user
    // runs `ccs gemini` or `ccs codex` for first time (requires OAuth auth first)
    // NOTE: GLM/Kimi profiles are now created via UI/CLI presets, not auto-created
    const configYamlPath = path.join(ccsDir, 'config.yaml');
    const legacyConfigPath = path.join(ccsDir, 'config.json');

    if (!fs.existsSync(configYamlPath)) {
      // Check for legacy config.json - autoMigrate() in ccs.ts will handle migration
      if (fs.existsSync(legacyConfigPath)) {
        // Validate legacy config.json before assuming migration will work
        try {
          const content = fs.readFileSync(legacyConfigPath, 'utf8');
          JSON.parse(content);
          console.log('[OK] Legacy config.json found - will migrate to config.yaml on first run');
        } catch {
          console.warn('[!] Legacy config.json is corrupted/invalid');
          console.warn('    Backup: mv ~/.ccs/config.json ~/.ccs/config.json.bak');
          console.warn('    Creating fresh config.yaml instead');
          // Fall through to create new config.yaml
          fs.renameSync(legacyConfigPath, `${legacyConfigPath}.bak`);
        }
      }

      // Create config.yaml if it doesn't exist (and legacy wasn't valid)
      if (!fs.existsSync(configYamlPath) && !fs.existsSync(legacyConfigPath)) {
        // Try to use unified config loader if dist is available
        try {
          const { saveUnifiedConfig } = require('../dist/config/unified-config-loader');
          const {
            createEmptyUnifiedConfig,
            UNIFIED_CONFIG_VERSION,
          } = require('../dist/config/unified-config-types');

          const config = createEmptyUnifiedConfig();
          config.version = UNIFIED_CONFIG_VERSION;
          saveUnifiedConfig(config);

          console.log('[OK] Created config: ~/.ccs/config.yaml');
        } catch (loaderErr) {
          // Dist not built yet (fresh clone) - create minimal config.yaml manually
          // Wrap js-yaml require in try-catch in case it's not available
          let yaml;
          try {
            yaml = require('js-yaml');
          } catch {
            // js-yaml not available - fallback to JSON
            console.warn('[!] js-yaml not available, creating legacy config.json');
            const fallbackConfig = { profiles: {} };
            const tmpPath = `${legacyConfigPath}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(fallbackConfig, null, 2) + '\n', 'utf8');
            fs.renameSync(tmpPath, legacyConfigPath);
            console.log('[OK] Created config: ~/.ccs/config.json (fallback)');
            yaml = null;
          }

          if (yaml) {
            const config = {
              version: '2.0',
              profiles: {},
              accounts: {},
              cliproxy: {
                variants: {},
                oauth_accounts: {},
              },
              cliproxy_server: {
                local: {
                  port: 8317,
                  auto_start: true,
                },
              },
            };

            try {
              const yamlContent = yaml.dump(config, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                sortKeys: false,
              });
              const tmpPath = `${configYamlPath}.tmp`;
              fs.writeFileSync(tmpPath, yamlContent, 'utf8');
              fs.renameSync(tmpPath, configYamlPath);
              console.log('[OK] Created config: ~/.ccs/config.yaml');
            } catch (yamlErr) {
              // Final fallback: create legacy config.json
              console.warn('[!] YAML write failed, creating legacy config.json');
              const fallbackConfig = { profiles: {} };
              const tmpPath = `${legacyConfigPath}.tmp`;
              fs.writeFileSync(tmpPath, JSON.stringify(fallbackConfig, null, 2) + '\n', 'utf8');
              fs.renameSync(tmpPath, legacyConfigPath);
              console.log('[OK] Created config: ~/.ccs/config.json (fallback)');
            }
          }
        }
      }
    } else {
      console.log('[OK] Config exists: ~/.ccs/config.yaml (preserved)');
    }

    // Warn if both config files exist (user may want to clean up)
    if (fs.existsSync(legacyConfigPath) && fs.existsSync(configYamlPath)) {
      console.log('[!] Both config.yaml and config.json exist');
      console.log('    config.json will be ignored - consider removing it');
    }

    // NOTE: GLM and Kimi profiles are NO LONGER auto-created during install
    // Users can create these via:
    //   - UI: Profile Create Dialog → Provider Presets
    //   - CLI: ccs api create --preset glm|km
    // This gives users control over which providers they want to use
    // Existing profiles are preserved for backward compatibility

    // Copy shell completion files to ~/.ccs/completions/
    const completionsDir = path.join(ccsDir, 'completions');
    const scriptsCompletionDir = path.join(__dirname, '../scripts/completion');

    if (!fs.existsSync(completionsDir)) {
      fs.mkdirSync(completionsDir, { recursive: true, mode: 0o755 });
    }

    const completionFiles = ['ccs.bash', 'ccs.zsh', 'ccs.fish', 'ccs.ps1'];
    completionFiles.forEach((file) => {
      const src = path.join(scriptsCompletionDir, file);
      const dest = path.join(completionsDir, file);

      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    });

    console.log('[OK] Installed shell completions: ~/.ccs/completions/');
    console.log('');
    console.log('  [i] Enable auto-completion:');
    console.log('      Run: ccs --shell-completion');
    console.log('');

    // Create ~/.claude/settings.json if missing (NEW)
    const claudeDir = path.join(homedir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o755 });
      console.log('[OK] Created directory: ~/.claude/');
    }

    if (!fs.existsSync(claudeSettingsPath)) {
      // Create empty settings (matches Claude CLI behavior)
      const tmpPath = `${claudeSettingsPath}.tmp`;
      fs.writeFileSync(tmpPath, '{}\n', 'utf8');
      fs.renameSync(tmpPath, claudeSettingsPath);

      console.log('[OK] Created default settings: ~/.claude/settings.json');
      console.log('');
      console.log('  [i] Configure Claude CLI:');
      console.log('      Run: claude /login');
      console.log('');
    } else {
      console.log('[OK] Claude settings exist: ~/.claude/settings.json (preserved)');
    }

    // Install folder-aware claude() shell function (idempotent, opt-out via CCS_NO_SHELL_INIT)
    console.log('');
    installClaudeShellFunction(homedir);

    // Validate configuration
    console.log('');
    console.log('[i] Validating configuration...');
    const validation = validateConfiguration();

    if (!validation.success) {
      console.error('');
      console.error('[X] Configuration validation failed:');
      validation.errors.forEach((err) => console.error(`    - ${err}`));
      console.error('');
      throw new Error('Configuration incomplete');
    }

    // Show warnings (non-critical)
    if (validation.warnings.length > 0) {
      console.warn('');
      console.warn('[!] Warnings:');
      validation.warnings.forEach((warn) => console.warn(`    - ${warn}`));
    }

    console.log('');
    console.log('[OK] CCS configuration ready!');
    console.log('  Run: ccs --version');
  } catch (err) {
    // Show error details
    console.error('');
    console.error('[X] CCS configuration failed');
    console.error(`    Error: ${err.message}`);
    console.error('');
    console.error('Recovery steps:');
    console.error('  1. Create directory manually:');
    console.error('     mkdir -p ~/.ccs ~/.claude');
    console.error('');
    console.error('  2. Create empty settings:');
    console.error('     echo "{}" > ~/.claude/settings.json');
    console.error('');
    console.error('  3. Retry installation:');
    console.error('     npm install -g @kaitranntt/ccs --force');
    console.error('');
    console.error('  4. If issue persists, report at:');
    console.error('     https://github.com/kaitranntt/ccs/issues');
    console.error('');

    // Exit with error code (npm will show warning)
    process.exit(1);
  }
}

// Run postinstall
createConfigFiles();
