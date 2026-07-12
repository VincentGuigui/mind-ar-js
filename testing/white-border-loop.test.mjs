// End-to-end test of the white-border Controller loop: maxFps pacing, FpsGovernor
// runtime throttling, and the workerOffload path.
// Run: node testing/white-border-loop.test.mjs   (after `npm run build`; needs
// playwright-core + Chromium, see CHROMIUM_PATH)

import {createServer} from 'http';
import {readFile} from 'fs/promises';
import {extname, join, dirname} from 'path';
import {fileURLToPath} from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const {chromium} = await import('playwright-core');

const MIME = {'.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript'};
const server = createServer(async (req, res) => {
  try {
    const data = await readFile(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {'Content-Type': MIME[extname(req.url)] || 'application/octet-stream'});
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8126, r));

const browser = await chromium.launch({executablePath: CHROMIUM, headless: true});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));
await page.goto('http://localhost:8126/testing/white-border-loop.html');
await page.waitForFunction('window.__ready === true', null, {timeout: 20000});

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : ''));
  if (!cond) failures++;
};

const run = async (opts, ms) => {
  await page.evaluate((o) => window.__startLoop(o), opts);
  await page.waitForTimeout(ms);
  const stats = await page.evaluate(() => window.__stats());
  await page.evaluate(() => window.__stopLoop());
  return {...stats, rate: stats.processDone / (stats.elapsedMs / 1000)};
};

// 1. default settings: tracks the card, loop paced at <= ~30fps (default maxFps)
{
  const s = await run({}, 3000);
  check('default: target found and tracked', s.found > 20, `${s.found} matrix updates`);
  check('default: paced to <= 30fps', s.rate <= 33, `${s.rate.toFixed(1)} fps`);
  check('default: no throttling on a capable machine', s.currentTargetFps === 30 && s.fpsChanges.length === 0);
}

// 2. maxFps config actually limits the processing rate
{
  const s = await run({maxFps: 10}, 3000);
  check('maxFps=10: rate ~10fps', s.rate >= 7 && s.rate <= 12, `${s.rate.toFixed(1)} fps`);
  check('maxFps=10: still tracking', s.found > 10, `${s.found} matrix updates`);
}

// 3. workerOffload: same behavior through the worker path
{
  const s = await run({workerOffload: true}, 3000);
  check('workerOffload: target found and tracked', s.found > 20, `${s.found} matrix updates`);
  check('workerOffload: paced to <= 30fps', s.rate <= 33, `${s.rate.toFixed(1)} fps`);
}

// 4. graceful throttling: a device that burns ~50ms/frame cannot hold 30fps (33ms budget);
//    the governor must step the target down by 1/6 rungs until sustainable, and the loop
//    must actually keep running
{
  const s = await run({busyMs: 50}, 6000);
  check('overloaded: governor throttled below maxFps', s.currentTargetFps < 30, `now ${s.currentTargetFps} fps`);
  check('overloaded: stepped down in 1/6 rungs', s.fpsChanges.length > 0 && s.fpsChanges.every((f) => [25, 20, 15, 10, 5].includes(f)), JSON.stringify(s.fpsChanges));
  check('overloaded: still tracking through the throttle', s.found > 10, `${s.found} matrix updates`);
  check('overloaded: measured rate matches the throttled target', s.rate <= s.currentTargetFps * 1.25, `${s.rate.toFixed(1)} fps vs target ${s.currentTargetFps}`);
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
