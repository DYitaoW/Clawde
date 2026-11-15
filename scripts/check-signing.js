// Runs before `npm run build:dmg`.
// If notarization credentials are set (a release build), require a
// "Developer ID Application" certificate. Without one, electron-builder silently
// falls back to an "Apple Development" certificate, and Apple then rejects the
// upload minutes later with "not signed with a valid Developer ID certificate".
const { execFileSync } = require('child_process');

const releaseBuild = Boolean(
  process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_API_KEY || process.env.APPLE_ID
);
const certFromEnv = Boolean(process.env.CSC_LINK); // CI: certificate provided as a .p12

if (process.platform !== 'darwin' || certFromEnv) process.exit(0);

let identities = '';
try {
  identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
} catch {
  // If the check itself fails, let electron-builder report the problem
  process.exit(0);
}
const hasDeveloperId = identities.includes('Developer ID Application:');

if (releaseBuild && !hasDeveloperId) {
  console.error(`
✖ No "Developer ID Application" certificate found in your Keychain.

  Notarization only accepts apps signed with a Developer ID certificate.
  Create one: Xcode → Settings → Accounts → your paid team → Manage Certificates
  → + → Developer ID Application. Then check with:
    security find-identity -v -p codesigning
`);
  process.exit(1);
}

if (!releaseBuild && !hasDeveloperId) {
  console.warn('⚠ Local test build: not signed with Developer ID, so it will only open on this Mac.');
}
