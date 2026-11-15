// loginPreload.js - Runs before page scripts in login window
// Prevents Google from hanging on WebAuthn/Passkey prompts by signaling no platform passkey support,
// which prompts Google to seamlessly ask for standard Password / 2FA.

try {
  // If PublicKeyCredential is disabled, Google automatically uses password & 2FA instead of passkey prompt
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: undefined,
      configurable: false,
      writable: false
    });

    // Remove automation/webdriver indicators
    if (navigator.webdriver) {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    }

    // Ensure chrome runtime object exists
    if (!window.chrome) {
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };
    }
  }
} catch (e) {
  console.warn('[loginPreload] Error initializing preload flags:', e.message);
}
