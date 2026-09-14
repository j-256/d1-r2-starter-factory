import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { capture, outputPath } from './browser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = outputPath(root, 'Capture the actual document library with synthetic API responses.');
const documents = [
  { id: 'project-brief', name: 'Project brief.pdf', description: 'Goals, scope, and delivery notes for the next release.', contentType: 'application/pdf', size: 248320, createdAt: '2026-01-15T10:30:00.000Z' },
  { id: 'architecture-notes', name: 'Architecture notes.md', description: 'Storage boundaries and a guide to the document workflow.', contentType: 'text/markdown', size: 6842, createdAt: '2026-01-14T16:00:00.000Z' },
];
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' };
for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|CLOUDFLARE|API_KEY/.test(key)) delete env[key];
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const collect = data => { log = (log + stripVTControlCharacters(data.toString())).slice(-100_000); };
server.stdout.on('data', collect); server.stderr.on('data', collect);
try {
  const deadline = Date.now() + 90_000;
  let url;
  while (!(url = log.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0])) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Preview failed to start:\n${log}`);
    await delay(100);
  }
  const origin = new URL(url).origin;
  await capture({ output, url, colorScheme: 'light', viewport: { width: 1440, height: 1050 },
    async setup(page) {
      await page.route(`${origin}/**`, async route => {
        if (new URL(route.request().url()).pathname === '/api/documents') {
          assert.equal(route.request().method(), 'GET');
          await route.fulfill({ json: { documents } });
        } else await route.continue();
      });
    },
    async ready(page) {
      await page.getByRole('heading', { name: 'Project brief.pdf', exact: true }).waitFor({ timeout: 60_000 });
      assert.equal(await page.locator('.document-card').count(), documents.length);
    },
  });
} catch (error) { console.error(log); throw error; }
finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), delay(5000)]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await once(server, 'exit'); }
  }
}
