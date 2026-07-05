const fs = require('fs');
const path = require('path');

/**
 * Extends app.json dynamically so that Android FCM push (Phase 5b) works the
 * moment a free `google-services.json` is dropped into the project root, but
 * never breaks `expo prebuild`/`eas build` when it's absent (Expo throws if
 * `android.googleServicesFile` points at a missing file).
 */
module.exports = ({ config }) => {
  const googleServicesPath = path.join(__dirname, 'google-services.json');

  if (fs.existsSync(googleServicesPath)) {
    config.android = {
      ...config.android,
      googleServicesFile: './google-services.json',
    };
  }

  return config;
};
