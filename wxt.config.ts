import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

const isE2E = process.env.WXT_E2E === '1';
const chromiumProfileDir = path.resolve('.wxt/chromium-profile');
fs.mkdirSync(chromiumProfileDir, { recursive: true });

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    chromiumProfile: chromiumProfileDir,
    keepProfileChanges: true,
  },
  manifest: () => {
    const productionManifest = {
      permissions: ['activeTab', 'scripting', 'storage', 'tabs'],
      host_permissions: [
        'https://openrouter.ai/*',
        'https://www.youtube.com/*',
        'https://youtube.com/*',
        'https://m.youtube.com/*',
        'https://music.youtube.com/*',
      ],
    };

    if (!isE2E) {
      return productionManifest;
    }

    return {
      permissions: ['scripting', 'tabs', 'storage'],
      host_permissions: [
        'http://*/*',
        'https://*/*',
        'https://openrouter.ai/*',
      ],
    };
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
