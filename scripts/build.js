// Release build: loads .env (gitignored), checks signing, runs electron-builder.
//   npm run build:dmg   build (+ notarize when .env has Apple credentials)
//   npm run release     same, then upload to a draft GitHub release (needs GH_TOKEN)
// Values already set in the shell win over .env.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1); // quoted: keep as-is
    else value = value.replace(/(^|\s+)#.*$/, '').trim();       // unquoted: drop trailing comment
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

const loaded = loadEnvFile(path.join(root, '.env'));
const env = process.env;

const method = env.APPLE_KEYCHAIN_PROFILE ? 'Keychain profile'
  : env.APPLE_API_KEY ? 'App Store Connect API key'
  : env.APPLE_ID ? 'Apple ID'
  : null;
console.log(`${loaded ? 'Loaded .env. ' : ''}Notarization: ${method || 'off (local test build)'}`);

if (env.APPLE_ID && !(env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)) {
  console.error('✖ APPLE_ID needs APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID too.');
  process.exit(1);
}
if (env.APPLE_API_KEY && !(env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)) {
  console.error('✖ APPLE_API_KEY needs APPLE_API_KEY_ID and APPLE_API_ISSUER too.');
  process.exit(1);
}

const publish = process.argv.includes('--publish');
if (publish && !env.GH_TOKEN) {
  console.error('✖ `npm run release` needs GH_TOKEN (in .env or the shell) to upload to GitHub.');
  process.exit(1);
}
if (publish && !method) {
  console.error('✖ Refusing to publish a build that is not notarized. Add Apple credentials to .env.');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env });
try {
  run(process.execPath, [path.join(__dirname, 'check-signing.js')]);
  run(path.join(root, 'node_modules', '.bin', 'electron-builder'),
    ['--mac', '--arm64', '--publish', publish ? 'always' : 'never']);
} catch (e) {
  process.exit(e.status || 1);
}

if (method) {
  // spctl prints its verdict to stderr
  const res = spawnSync('spctl', ['-a', '-vv', '-t', 'exec', path.join(root, 'dist', 'mac-arm64', 'Clawde.app')],
    { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0 && out.includes('Notarized Developer ID')) console.log('✔ Notarized Developer ID build');
  else console.warn('⚠ Gatekeeper check did not pass:', out || (res.error && res.error.message));
}
