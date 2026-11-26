/**
 * Real-app check of resuming an on-device song run (experimental card, Stage IV, OPFS).
 *   A. Uninterrupted run → SHA-256 of each stem file.
 *   B. Same song, same threads: the page is hidden after window `--hide-after` (the card stops the run), the page
 *      reloads, Resume; then the renderer is crashed mid-run after window `--kill-after` (CDP Page.crash: a killed
 *      tab, no events run, the crash marker stays), a new tab acknowledges the interruption and resumes to the end.
 *      (A reload is not a kill: Chromium fires visibilitychange first, so the card stops cleanly.)
 *   B's stems must be byte-identical to A's, and the stored song must be gone afterwards.
 *
 * Serve a build with the Stage IV files at <base>/models/ (cross-origin isolated, e.g. `vite preview`).
 * Usage: node scripts/e2e/stage4-resume.mjs <preview-url> <clip.wav> [--threads 4] [--hide-after 2] [--kill-after 5] [--webkit]
 *   --webkit: Playwright WebKit in a persistent profile (a normal Safari-like tab). It has no CDP, so the kill is
 *   approximated by closing the whole browser mid-window (no clean stop runs in the worker either).
 */
import { createRequire } from 'node:module';
// Playwright is pre-installed globally in CI images (resolved via NODE_PATH, which ESM ignores).
const { chromium, webkit } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const useWebKit = args.includes('--webkit');
if (useWebKit) args.splice(args.indexOf('--webkit'), 1);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
};
const threads = option('--threads', 4);
const hideAfter = option('--hide-after', 2);
const killAfter = option('--kill-after', 5);
const [url, clip] = args;
if (!url || !clip) throw new Error('usage: stage4-resume.mjs <preview-url> <clip.wav> [--threads N] [--hide-after N] [--kill-after N]');

// One profile, so every tab sees the same OPFS. WebKit's OPFS needs a persistent (non-ephemeral) session.
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const profile = useWebKit ? mkdtempSync(join(tmpdir(), 'stage4-resume-')) : null;
const browser = useWebKit ? null : await chromium.launch();
let context = useWebKit ? await webkit.launchPersistentContext(profile) : await browser.newContext();
let page;
let card;
async function newTab() {
  page = await context.newPage();
  page.on('dialog', (d) => void d.accept());
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Experimental AI model test' }) });
}
await newTab();
const log = () => card.locator('pre').innerText();
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

/** Waits for `pattern` in the card's log; fails at once (with the log) when the run fails or stops instead. */
async function waitForLog(pattern, timeout = 1_200_000) {
  const failure = /FAIL|Worker error|Worker message error|Stopped:|Cancelled/;
  const outcome = await page.waitForFunction(
    ({ source, flags, fail }) => {
      const text = document.querySelector('section.card pre')?.textContent ?? '';
      // Only lines after the most recent "Starting"/"Resuming" count, so an earlier run's stop does not match.
      const lines = text.split('\n');
      let from = 0;
      lines.forEach((l, i) => { if (/Starting on-device|Resuming on-device/.test(l)) from = i; });
      const recent = lines.slice(from).join('\n');
      if (new RegExp(source, flags).test(recent)) return 'ok';
      return new RegExp(fail).test(recent) ? 'failed' : false;
    },
    { source: pattern.source, flags: pattern.flags, fail: failure.source },
    { timeout, polling: 250 },
  ).then((h) => h.jsonValue()).catch((e) => `timeout (${e.message.split('\n')[0]})`);
  if (outcome !== 'ok' && !(pattern.test('Stopped: page hidden') && outcome === 'failed')) {
    console.log(`waiting for ${pattern}: ${outcome}\n--- card log ---\n${await log()}`);
    await context.close();
    await browser?.close();
    process.exit(1);
  }
}

/** Opens the app; `afterKill` first acknowledges the interruption marker a killed tab leaves (it disables the card). */
async function open({ afterKill = false } = {}) {
  await page.goto(`${url.replace(/\/$/, '')}/#diagnostics`); // the experimental card lives on the diagnostics screen
  if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error('page is not cross-origin isolated');
  if (afterKill) {
    const ack = card.getByRole('button', { name: 'Acknowledge interruption' });
    const shown = await ack.waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (shown) await ack.click();
    else if (useWebKit) console.log('no interruption marker: closing WebKit ran the page-hidden stop first');
    else throw new Error('a crashed tab must leave the interruption marker');
  }
  await card.locator('select').selectOption(String(threads));
}

async function startSong() {
  await card.locator('input[type=file]').setInputFiles(clip);
  await card.getByText(/windows · about/).waitFor();
  await card.getByRole('button', { name: 'Separate this song on this device' }).click();
}

/** SHA-256 per stem file, and the names of every file in the run directory. */
async function storedDigests() {
  return page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('stage4-stems');
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    const digests = {};
    for (const name of names.filter((n) => n.endsWith('.wav')).sort()) {
      const bytes = await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      digests[name] = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return { names: names.sort(), digests };
  });
}

const heapLines = (text) => text.split('\n').filter((l) => /Window \d+\/\d+ done/.test(l)).map((l) => l.replace(/^\S+ /, ''));

// A: uninterrupted.
await open();
await startSong();
await waitForLog(/Song separation complete/);
const a = await storedDigests();
const aLog = await log();
console.log(`[${at()}] A done: ${heapLines(aLog).length} windows; last: ${heapLines(aLog).at(-1)}`);
console.log(`A files: ${a.names.join(', ')}`);

// B1: stopped by a hidden page.
await open();
await startSong();
await waitForLog(new RegExp(`Window ${hideAfter}/\\d+ done`));
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await waitForLog(/Stopped: page hidden/);
console.log(`[${at()}] B stopped by a hidden page after window ${hideAfter}`);

// B2: reload (the user comes back), Resume, then the tab is killed mid-run.
await open();
const offer = await card.getByText(/windows are finished; Resume continues/).innerText();
console.log(`after reload: ${offer.replace(/\s+/g, ' ')}`);
await card.getByRole('button', { name: /^Resume \(/ }).click();
await waitForLog(new RegExp(`Window ${killAfter}/\\d+ done`));
await page.waitForTimeout(1500); // inside the next window, so the worker is mid-run when the tab goes
const resumedOnce = await log();
console.log(`[${at()}] B resumed: ${resumedOnce.split('\n').filter((l) => l.includes('windows were finished')).at(-1).replace(/^\S+ /, '')}`);
if (useWebKit) {
  await context.close(); // the whole browser goes, worker included, mid-window
  context = await webkit.launchPersistentContext(profile);
  console.log(`[${at()}] B browser closed mid-window ${killAfter + 1}`);
} else {
  const cdp = await context.newCDPSession(page);
  const crashed = page.waitForEvent('crash', { timeout: 30_000 });
  void cdp.send('Page.crash').catch(() => {}); // never resolves once the renderer is gone: do not await it
  await crashed;
  await page.close().catch(() => {});
  console.log(`[${at()}] B renderer crashed mid-window ${killAfter + 1}`);
}

// B3: killed tab → a new tab acknowledges the interruption → Resume to the end.
await newTab();
await open({ afterKill: true });
console.log(`after kill: ${(await card.getByText(/windows are finished; Resume continues/).innerText()).replace(/\s+/g, ' ')}`);
await card.getByRole('button', { name: /^Resume \(/ }).click();
await waitForLog(/Resumed song separation complete/);
const b = await storedDigests();
const bLog = await log();
console.log(`[${at()}] B done: ${bLog.split('\n').filter((l) => l.includes('windows were finished')).at(-1).replace(/^\S+ /, '')}`);
console.log(`B files: ${b.names.join(', ')}`);

let ok = true;
for (const [name, digest] of Object.entries(a.digests)) {
  const same = b.digests[name] === digest;
  ok &&= same;
  console.log(`${name.padEnd(11)} ${same ? 'identical' : 'DIFFERENT'} ${digest.slice(0, 16)}…`);
}
if (Object.keys(a.digests).length !== 6) ok = false;
if (b.names.includes('input.f32')) {
  console.log('the stored song was not removed after completion');
  ok = false;
}
await context.close();
await browser?.close();
console.log(ok ? 'PASS: resumed stems are byte-identical to the uninterrupted run' : 'FAIL');
process.exit(ok ? 0 : 1);
