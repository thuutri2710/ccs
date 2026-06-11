const assert = require('assert');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { createTestEnvironment } = require('../shared/fixtures/test-environment');

const CLAUDE_FN_MARKER = '# >>> ccs custom claude (managed) >>>';

describe('npm postinstall', () => {
  let testEnv;
  const postinstallScript = path.join(__dirname, '..', '..', 'scripts', 'postinstall.js');

  beforeEach(() => {
    // Create isolated test environment for each test
    testEnv = createTestEnvironment();
  });

  afterEach(() => {
    // Clean up test environment
    if (testEnv) {
      testEnv.cleanup();
    }
  });

  it('creates config.yaml (primary format)', () => {
    execSync(`node "${postinstallScript}"`, {
      stdio: 'ignore',
      env: { ...process.env, CCS_HOME: testEnv.testHome },
    });

    // config.yaml is now the primary format (v6.x+)
    assert(testEnv.fileExists('config.yaml'), 'config.yaml should be created');

    // Read YAML config and verify structure
    const yaml = require('js-yaml');
    const configContent = testEnv.readFile('config.yaml', false);
    const config = yaml.load(configContent);

    assert(config.profiles !== undefined, 'config.yaml should have profiles');
    assert(typeof config.profiles === 'object', 'profiles should be an object');
    // Profiles are now empty by default - users create via presets
    assert.deepStrictEqual(config.profiles, {}, 'profiles should be empty by default');
    assert(config.version, 'config.yaml should have version');
  });

  it('does NOT auto-create glm.settings.json (v6.0 - use presets instead)', () => {
    execSync(`node "${postinstallScript}"`, {
      stdio: 'ignore',
      env: { ...process.env, CCS_HOME: testEnv.testHome },
    });

    // GLM/Kimi profiles are NO LONGER auto-created during install.
    // Legacy glmt.settings.json files may still exist from older setups.
    // Users create supported API profiles via UI presets or CLI: ccs api create --preset glm
    assert(
      !testEnv.fileExists('glm.settings.json'),
      'glm.settings.json should NOT be auto-created'
    );
    assert(
      !testEnv.fileExists('glmt.settings.json'),
      'glmt.settings.json should NOT be auto-created'
    );
    assert(
      !testEnv.fileExists('kimi.settings.json'),
      'kimi.settings.json should NOT be auto-created'
    );
  });

  it('is idempotent', () => {
    const env = { ...process.env, CCS_HOME: testEnv.testHome };
    const yaml = require('js-yaml');

    // Run postinstall first time
    execSync(`node "${postinstallScript}"`, { stdio: 'ignore', env });

    // Create custom config.yaml to test preservation
    const customConfig = {
      version: '2.0',
      profiles: {
        custom: '~/.custom.json',
        glm: '~/.ccs/glm.settings.json',
      },
      accounts: {},
      cliproxy: { variants: {}, oauth_accounts: {} },
    };
    const yamlContent = yaml.dump(customConfig, { indent: 2 });
    testEnv.createFile('config.yaml', yamlContent);

    // Run postinstall again
    execSync(`node "${postinstallScript}"`, { stdio: 'ignore', env });

    // Verify custom config preserved
    const configContent = testEnv.readFile('config.yaml', false);
    const config = yaml.load(configContent);
    assert(config.profiles.custom, 'Custom profile should be preserved');
    assert.strictEqual(config.profiles.custom, '~/.custom.json');
  });

  it('uses ASCII symbols', () => {
    const output = execSync(`node "${postinstallScript}"`, {
      encoding: 'utf8',
      env: { ...process.env, CCS_HOME: testEnv.testHome },
    });

    // Check for ASCII symbols [OK], [!], [X], [i] - not emojis
    assert(/\[(OK|!|X|i)\]/.test(output), 'Should use ASCII symbols, not emojis');

    // Verify no emojis in output
    const emojiRegex =
      /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
    assert(!emojiRegex.test(output), 'Should not contain emojis');
  });

  it('handles existing directory gracefully', () => {
    // Create directory manually first
    testEnv.createFile('existing.txt', 'exists');

    // Run postinstall
    execSync(`node "${postinstallScript}"`, {
      stdio: 'ignore',
      env: { ...process.env, CCS_HOME: testEnv.testHome },
    });

    // Verify existing file still exists and new files are created
    assert(testEnv.fileExists('existing.txt'), 'Existing files should be preserved');
    assert(testEnv.fileExists('config.yaml'), 'config.yaml should be created');
    // GLM/Kimi are no longer auto-created. Legacy GLMT files remain untouched if present.
    assert(
      !testEnv.fileExists('glm.settings.json'),
      'glm.settings.json should NOT be auto-created'
    );
  });

  it('does not create VERSION file', () => {
    execSync(`node "${postinstallScript}"`, {
      stdio: 'ignore',
      env: { ...process.env, CCS_HOME: testEnv.testHome },
    });

    // The postinstall script doesn't create VERSION file (only native install does)
    assert(!testEnv.fileExists('VERSION'), 'VERSION file should NOT be created by npm postinstall');
  });

  describe('claude() shell function', () => {
    const homePath = (...parts) => path.join(testEnv.testHome, ...parts);
    const run = (extraEnv = {}) =>
      execSync(`node "${postinstallScript}"`, {
        stdio: 'ignore',
        env: { ...process.env, CCS_HOME: testEnv.testHome, ...extraEnv },
      });

    it('adds the managed claude() block to .zshrc (creating it)', () => {
      run();

      const zshrc = homePath('.zshrc');
      assert(fs.existsSync(zshrc), '.zshrc should be created');
      const content = fs.readFileSync(zshrc, 'utf8');
      assert(content.includes(CLAUDE_FN_MARKER), 'managed marker should be present');
      assert(content.includes('claude() {'), 'function definition should be present');
      assert(
        content.includes('config.yaml'),
        'function should reference config.yaml'
      );
    });

    it('is idempotent (no duplicate block on second run)', () => {
      run();
      run();

      const content = fs.readFileSync(homePath('.zshrc'), 'utf8');
      const occurrences = content.split(CLAUDE_FN_MARKER).length - 1;
      assert.strictEqual(occurrences, 1, 'managed block should appear exactly once');
    });

    it('does not clobber a user-defined claude() function', () => {
      const zshrc = homePath('.zshrc');
      const userFn = 'claude() {\n  echo "my own claude"\n}\n';
      fs.writeFileSync(zshrc, userFn, 'utf8');

      run();

      const content = fs.readFileSync(zshrc, 'utf8');
      assert(content.includes('echo "my own claude"'), 'user function should be preserved');
      assert(!content.includes(CLAUDE_FN_MARKER), 'managed block should NOT be added');
    });

    it('respects CCS_NO_SHELL_INIT opt-out', () => {
      run({ CCS_NO_SHELL_INIT: '1' });

      assert(!fs.existsSync(homePath('.zshrc')), '.zshrc should not be created when opted out');
    });

    it('updates an existing .bashrc but does not create one', () => {
      fs.writeFileSync(homePath('.bashrc'), '# existing bashrc\n', 'utf8');

      run();

      const bashrc = fs.readFileSync(homePath('.bashrc'), 'utf8');
      assert(bashrc.includes('# existing bashrc'), 'existing bashrc content preserved');
      assert(bashrc.includes(CLAUDE_FN_MARKER), 'managed block added to existing .bashrc');
    });
  });
});
