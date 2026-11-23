/**
 * Headless-Chromium end-to-end check of the PWA.
 *   1. Device path: WASM inference in the real browser (no GPU in CI → WASM EP).
 *      The model is served from a same-origin sha256-addressed mirror (VITE_MODEL_MIRROR).
 *   2. Parity: browser vocals vs. server CLI vocals on the same clip (SNR, dB).
 *   3. Server path: forced-server job against a running `stemsplit serve`.
 *
 * Usage: node scripts/e2e/browser-smoke.mjs <preview-url> <clip.wav> <server-vocals.wav> [--server]
 */
import { readFileSync } from "node:fs";
import { createRequire } from 'node:module';
// Playwright is pre-installed globally in CI images (resolved via NODE_PATH, which ESM ignores).
const { chromium } = createRequire(import.meta.url)('playwright');

const [url, clip, serverVocals] = process.argv.slice(2);
const withServer = process.argv.includes('--server');

function decodeWav24or16(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, fmt, data;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { ch: v.getUint16(off + 10, true), bits: v.getUint16(off + 22, true) };
    if (id === 'data') { data = [off + 8, size]; break; }
    off += 8 + size + (size & 1);
  }
  const bps = fmt.bits / 8, frames = data[1] / (bps * fmt.ch), L = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = data[0] + i * bps * fmt.ch;
    L[i] = bps === 3 ? (((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) >> 8) / 8388608 : v.getInt16(o, true) / 32768;
  }
  return L;
}

function snr(ref, est) {
  let s = 0, e = 0;
  for (let i = 0; i < ref.length; i++) { s += ref[i] ** 2; e += (ref[i] - est[i]) ** 2; }
  return 10 * Math.log10(s / e);
}

const browser = await chromium.launch({ args: ['--enable-features=SharedArrayBuffer'] });
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('[page error]', m.text()));
page.on('crash', () => console.log('[page crashed]'));
// Build the app with VITE_MODEL_MIRROR=/__models and place <sha256>.onnx under dist/__models/.
await page.route('https://huggingface.co/**', (route) => route.abort());

await page.goto(`${url}/?debug=1`);
const isolated = await page.evaluate(() => crossOriginIsolated);
console.log(`crossOriginIsolated=${isolated}`);
await page.setInputFiles('input[type=file]', clip);
await page.waitForSelector('.banner');
console.log('banner:', (await page.textContent('.banner')).replace(/\s+/g, ' ').trim());

const t0 = Date.now();
await page.click('button.primary');
await page.waitForSelector('.mixer', { timeout: 600_000 });
console.log(`device path finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const stems = await page.$$eval('.channel__name', (els) => els.map((e) => e.textContent));
console.log('stems:', stems.join(', '));
const vocalsL = Float32Array.from(await page.evaluate(() => Array.from(globalThis.__stemsplit.player.channelData('vocals')[0])));
const ref = decodeWav24or16(readFileSync(serverVocals));
console.log(`parity browser-WASM vs server-CPU (vocals L): SNR ${snr(ref, vocalsL).toFixed(1)} dB over ${ref.length} frames`);

if (withServer) {
  await page.reload();
  await page.setInputFiles('input[type=file]', clip);
  await page.check('text=Always use the server');
  await page.click('text=Guitar focus');
  await page.waitForSelector('.banner--server');
  await page.click('button.primary');
  await page.waitForSelector('.mixer', { timeout: 600_000 });
  const s2 = await page.$$eval('.channel__name', (els) => els.map((e) => e.textContent));
  const warnings = await page.$$eval('.warning', (els) => els.map((e) => e.textContent));
  console.log('server path stems:', s2.join(', '));
  console.log('server warnings:', warnings.length);
}
await browser.close();
