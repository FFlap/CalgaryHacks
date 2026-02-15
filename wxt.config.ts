import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve('.env') });
if (!process.env.WXT_GOOGLE_FACT_CHECK_API_KEY) {
  dotenv.config({ path: path.resolve('.env.example') });
}

const isE2E = process.env.WXT_E2E === '1';
const googleFactCheckApiKey = process.env.WXT_GOOGLE_FACT_CHECK_API_KEY ?? '';
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
        'https://api.gdeltproject.org/*',
        'https://factchecktools.googleapis.com/*',
        'https://en.wikipedia.org/*',
        'https://www.wikidata.org/*',
        'https://eutils.ncbi.nlm.nih.gov/*',
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
    define: {
      __GOOGLE_FACT_CHECK_API_KEY__: JSON.stringify(googleFactCheckApiKey),
    },
  }),
});
