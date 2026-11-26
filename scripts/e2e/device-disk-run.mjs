/**
 * Real-app check of the main app's disk path (Stage V step 2) on an emulated phone.
 *   1. Full scope, uninterrupted: six stems in OPFS, the stored song removed, stems still offered after a reload.
 *   2. Parity per stem against server-CLI references of the same clip (both scopes), which also checks the quick
 *      scope's projection (other = other + guitar + piano).
 *   3. Quick scope, uninterrupted, then quick again paused after window `--pause-after` → reload → Resume:
 *      byte-identical stems.
 *
 * Serve a build made with VITE_MODEL_MIRROR=/__models (graph + data hard-linked under dist/__models/<sha256>…), and
 * the references under dist/__ref/<scope>/<stem>.24bit.wav. Cross-origin isolated (vite preview).
 * Usage: node scripts/e2e/device-disk-run.mjs <preview-url> <clip.wav> [--webkit] [--pause-after 2]
 */
import { createRequire } from 'node:module';
// Playwright is pre-installed globally in CI images (resolved via NODE_PATH, which ESM ignores).
const { chromium, webkit, devices } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const useWebKit = args.includes('--webkit');
if (useWebKit) args.splice(args.indexOf('--webkit'), 1);
const pauseIdx = args.indexOf('--pause-after');
const pauseAfter = pauseIdx >= 0 ? Number(args.splice(pauseIdx, 2)[1]) : 2;
const [url, clip] = args;
if (!url || !clip) throw new Error('usage: device-disk-run.mjs <preview-url> <clip.wav> [--webkit] [--pause-after N]');

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const phone = devices['iPhone 15'];
// WebKit's OPFS needs a persistent (non-ephemeral) session, as a normal Safari tab has.
const context = useWebKit
  ? await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'disk-run-')), { ...phone })
  : await (await chromium.launch()).newContext({ ...phone });
const page = context.pages()[0] ?? (await context.newPage());
page.on('dialog', (d) => void d.accept());
page.on('pageerror', (e) => console.log('[page error]', e.message));
const t0 = Date.now();
const at = () => `[${((Date.now() - t0) / 1000).toFixed(0)} s]`;
const fail = async (msg) => {
  console.log(`FAIL: ${msg}\n--- page ---\n${(await page.locator('main').innerText()).slice(0, 3000)}`);
  await context.close();
  process.exit(1);
};

async function open() {
  await page.goto(url);
  if (!(await page.evaluate(() => crossOriginIsolated))) await fail('page is not cross-origin isolated');
}

/** Starts the run and waits until it has really begun (the working screen is up). */
async function separate() {
  await page.getByRole('button', { name: /^Separate into/ }).click();
  await page.waitForFunction(() => !document.querySelector('.stored-run') && document.querySelector('.working'), null, { timeout: 120_000, polling: 100 });
}

/** From the home screen: pick the clip, choose 4 or 6 stems, and check it plans a disk-path run on this phone. */
async function choose(scope) {
  await page.locator('.file-pick input[type=file]').setInputFiles(clip);
  await page.locator('.facts').waitFor();
  await page.locator('label.choice', { hasText: scope === 'quick' ? '4 stems' : '6 stems' }).click();
  const plan = (await page.locator('.screen').innerText()).replace(/\s+/g, ' ');
  if (!/Runs on This phone/.test(plan) || !/Keep this page open/.test(plan)) await fail(`not planned as a disk-path run on this phone: ${plan}`);
  return plan;
}

/** Waits for the stored-run panel: 'complete' (stems) or 'paused'. Fails fast on an error. */
async function waitFor(state, timeout = 1_500_000) {
  const done = await page.waitForFunction(
    (want) => {
      const text = document.querySelector('main')?.textContent ?? '';
      if (document.querySelector('.notice--problem')) return 'error';
      if (want === 'complete' && /Stems on this device/.test(text)) return 'ok';
      if (want === 'paused' && /Paused separation/.test(text)) return 'ok';
      return false;
    },
    state,
    { timeout, polling: 500 },
  ).then((h) => h.jsonValue(), (e) => `timeout: ${e.message.split('\n')[0]}`);
  if (done !== 'ok') await fail(`waiting for ${state}: ${done}`);
}

/** Files in the run directory, SHA-256 of each stem, and per-stem SNR against /__ref/<scope>/ (24-bit WAVs). */
async function inspect(scope) {
  return page.evaluate(async (scope) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('device-run');
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    const pcm = (buf) => {
      const v = new DataView(buf);
      let off = 12;
      let ch = 2;
      let bits = 24;
      while (off + 8 <= buf.byteLength) {
        const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
        const size = v.getUint32(off + 4, true);
        if (id === 'fmt ') { ch = v.getUint16(off + 10, true); bits = v.getUint16(off + 22, true); }
        if (id === 'data') {
          const bps = bits / 8;
          const n = Math.floor(size / bps);
          const out = new Float32Array(n);
          for (let i = 0, o = off + 8; i < n; i++, o += bps) {
            out[i] = bps === 3 ? (((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16)) << 8) >> 8) / 8388608 : v.getInt16(o, true) / 32768;
          }
          return { data: out, ch };
        }
        off += 8 + size + (size & 1);
      }
      throw new Error('no data chunk');
    };
    const result = { names: names.sort(), stems: {} };
    for (const name of names.filter((n) => n.endsWith('.wav')).sort()) {
      const buf = await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');
      const stem = name.replace(/\.wav$/, '');
      const ref = await fetch(`/__ref/${scope}/${stem}.24bit.wav`);
      let snr = null;
      if (ref.ok) {
        const a = pcm(await ref.arrayBuffer()).data;
        const b = pcm(buf).data;
        let s = 0;
        let e = 0;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) { s += a[i] * a[i]; e += (a[i] - b[i]) ** 2; }
        snr = { db: 10 * Math.log10(s / e), frames: n / 2, refFrames: a.length / 2, ownFrames: b.length / 2 };
      }
      result.stems[stem] = { hash, bytes: buf.byteLength, snr };
    }
    return result;
  }, scope);
}

const report = (label, r) => {
  console.log(`${at()} ${label}: files ${r.names.join(', ')}`);
  for (const [stem, s] of Object.entries(r.stems)) {
    console.log(`   ${stem.padEnd(7)} ${s.hash.slice(0, 12)}… ${(s.bytes / 1e6).toFixed(1)} MB` +
      (s.snr ? ` · vs server CLI ${s.snr.db.toFixed(1)} dB over ${s.snr.frames} frames${s.snr.refFrames !== s.snr.ownFrames ? ` (lengths ${s.snr.ownFrames} vs ${s.snr.refFrames})` : ''}` : ''));
  }
};

let ok = true;
const check = (cond, msg) => { if (!cond) { ok = false; console.log(`CHECK FAILED: ${msg}`); } };

// 1 + 2: full scope, uninterrupted.
await open();
console.log(`${at()} ${useWebKit ? 'WebKit' : 'Chromium'} as ${phone.userAgent.slice(13, 60)}…`);
console.log(`${at()} banner (full): ${(await choose('full')).slice(0, 400)}`);
await separate();
await waitFor('complete');
const full = await inspect('full');
report('full, uninterrupted', full);
check(Object.keys(full.stems).length === 6, 'six stems for full');
check(!full.names.includes('input.f32'), 'stored song removed after completion');
for (const [stem, s] of Object.entries(full.stems)) check(s.snr && s.snr.db >= 40, `${stem} parity vs server ≥ 40 dB`);
check((await page.locator('.stem-row').count()) === 6, 'six stem rows');
await open();
// After a reload the home screen lists the stored stems; opening them shows the six rows again.
await page.locator('button.row-card', { hasText: '6 stems' }).click({ timeout: 15_000 }).catch(() => { ok = false; console.log('CHECK FAILED: stems offered after a reload'); });
await page.getByText('Stems on this device').waitFor({ timeout: 15_000 }).catch(() => { ok = false; console.log('CHECK FAILED: stored stems open after a reload'); });
console.log(`${at()} after reload: stems still offered (${await page.locator('.stem-row').count()} rows)`);
await page.getByRole('button', { name: 'Back' }).click();

// 3: quick scope, uninterrupted, then paused + resumed.
await choose('quick');
await separate();
await waitFor('complete');
const quick = await inspect('quick');
report('quick, uninterrupted', quick);
check(Object.keys(quick.stems).sort().join() === 'bass,drums,other,vocals', 'four stems for quick');
for (const [stem, s] of Object.entries(quick.stems)) check(s.snr && s.snr.db >= 40, `${stem} (quick) parity vs server ≥ 40 dB`);

await open();
await choose('quick');
await separate();
const windows = Math.ceil(pauseAfter); // progress fraction after N of 8 windows
// Separation progress only (the model-download bar also uses <progress>).
await page.waitForFunction((n) => {
  const p = document.querySelector('.working[data-phase=local] progress');
  return p && Number(p.value) >= n / 8 - 1e-9;
}, windows, { timeout: 1_200_000, polling: 250 });
await page.getByRole('button', { name: /Pause/ }).click();
await waitFor('paused');
console.log(`${at()} paused: ${(await page.locator('.stored-run').innerText()).replace(/\s+/g, ' ')}`);
await open();
// After a reload the home screen offers the paused run with Resume.
const pausedRow = page.locator('.row-card', { hasText: 'Paused' });
await pausedRow.waitFor({ timeout: 15_000 });
console.log(`${at()} after reload: ${(await pausedRow.innerText()).replace(/\s+/g, ' ')}`);
await pausedRow.getByRole('button', { name: 'Resume', exact: true }).click();
// A tap that does nothing must fail fast, with the page, rather than after the full timeout.
await page.waitForFunction(() => document.querySelector('.working') !== null, null, { timeout: 120_000, polling: 250 })
  .catch(() => fail('Resume showed no progress within 2 min'));
console.log(`${at()} resume started`);
await waitFor('complete');
const resumed = await inspect('quick');
report('quick, paused + reloaded + resumed', resumed);
for (const [stem, s] of Object.entries(quick.stems)) check(resumed.stems[stem]?.hash === s.hash, `${stem} byte-identical after resume`);
check(!resumed.names.includes('input.f32'), 'stored song removed after the resumed run');

await context.close();
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
