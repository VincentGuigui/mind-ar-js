// FpsGovernor unit tests (pure logic, no DOM). Run: node testing/fps-governor.test.mjs

import {FpsGovernor} from '../src/image-target/fps-governor.js';

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail && !cond ? ' — ' + detail : ''));
  if (!cond) failures++;
};

const feed = (g, busyMs, frames) => {
  let fps;
  for (let i = 0; i < frames; i++) fps = g.sample(busyMs);
  return fps;
};

// starts at maxFps
{
  const g = new FpsGovernor(30);
  check('starts at maxFps', g.targetFps === 30 && Math.abs(g.frameBudgetMs - 33.33) < 0.1);
}

// cheap frames: never throttles
{
  const g = new FpsGovernor(30);
  feed(g, 5, 200);
  check('cheap frames keep maxFps', g.targetFps === 30);
}

// too-expensive frames: drops one rung (1/6 of maxFps) at a time until sustainable
{
  const g = new FpsGovernor(30);
  feed(g, 45, 15);        // 45ms busy > 33ms budget -> unsustainable at 30fps
  check('overload drops one rung (30 -> 25)', g.targetFps === 25);
  feed(g, 45, 15);        // still > 40ms budget of 25fps
  check('still overloaded -> 20', g.targetFps === 20);
  feed(g, 45, 400);       // 45ms fits 50ms budget of 20fps -> stays (0.9*50=45, not >)
  check('sustainable at 20 -> stays', g.targetFps === 20);
}

// extreme overload walks all the way down but never below the lowest rung
{
  const g = new FpsGovernor(30);
  feed(g, 500, 200);
  check('never drops below maxFps/6', g.targetFps === 5);
}

// recovery: sustained headroom climbs back one rung at a time
{
  const g = new FpsGovernor(30);
  feed(g, 45, 30);                       // -> 25 then still overloaded -> 20
  const throttled = g.targetFps;
  feed(g, 5, 200);                       // ample headroom for a while
  check(`recovers upward after headroom (was ${throttled})`, g.targetFps === 30);
}

// borderline headroom does NOT climb (hysteresis: needs < 60% of the higher rung's budget)
{
  const g = new FpsGovernor(30);
  feed(g, 45, 15);                       // -> 25 (40ms budget)
  check('setup: at 25', g.targetFps === 25);
  feed(g, 30, 300);                      // 30ms fits 25fps, but 30 > 0.6*33.3 of the 30fps rung
  check('borderline load does not oscillate back up', g.targetFps === 25);
}

// custom maxFps ladder (e.g. 24 -> rungs of 4)
{
  const g = new FpsGovernor(24);
  feed(g, 60, 15);
  check('ladder scales with maxFps (24 -> 20)', g.targetFps === 20);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
