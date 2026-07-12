// Graceful frame-rate governor for the white-border tracking loop.
//
// The target frame rate lives on a ladder of maxFps * k/6 rungs (for maxFps=30:
// 30, 25, 20, 15, 10, 5). Each processed frame reports its busy time via sample();
// when the rolling average overruns the current rung's frame budget, the target drops
// one rung (reduce by 1/6 of maxFps), and keeps dropping until the device sustains it.
// When there is comfortable, sustained headroom for the rung above, the target climbs
// back one rung — so a transient load (scene loading, thermal spike) doesn't pin the
// tracking at a low rate forever. The hysteresis gap between the drop and climb
// thresholds prevents oscillation.
//
// Pure logic (no timers, no DOM) so it is unit-testable.

const LADDER_STEPS = 6;         // rungs = maxFps * k/6, k = 6..1
const WINDOW_SIZE = 30;         // rolling window of frame costs (~1s at 30fps)
const DROP_THRESHOLD = 0.9;     // drop a rung when avg cost > 90% of the current budget
const CLIMB_THRESHOLD = 0.6;    // climb when avg cost < 60% of the HIGHER rung's budget
const CLIMB_HOLD = WINDOW_SIZE; // ... sustained for a full window

class FpsGovernor {
  constructor(maxFps) {
    this.maxFps = maxFps;
    this.rung = LADDER_STEPS; // start at maxFps
    this.samples = [];
    this.sum = 0;
    this.climbStreak = 0;
  }

  get targetFps() {
    return this.maxFps * this.rung / LADDER_STEPS;
  }

  get frameBudgetMs() {
    return 1000 / this.targetFps;
  }

  // report the busy time of the frame just processed; returns the (possibly adjusted) target fps
  sample(busyMs) {
    this.samples.push(busyMs);
    this.sum += busyMs;
    if (this.samples.length > WINDOW_SIZE) {
      this.sum -= this.samples.shift();
    }
    const avg = this.sum / this.samples.length;

    // half a window of evidence is enough to react to overload
    if (this.samples.length >= WINDOW_SIZE / 2 && this.rung > 1 && avg > DROP_THRESHOLD * this.frameBudgetMs) {
      this.rung--;
      this.samples.length = 0;
      this.sum = 0;
      this.climbStreak = 0;
      return this.targetFps;
    }

    if (this.rung < LADDER_STEPS) {
      const higherBudget = 1000 / (this.maxFps * (this.rung + 1) / LADDER_STEPS);
      if (avg < CLIMB_THRESHOLD * higherBudget) {
        this.climbStreak++;
        if (this.climbStreak >= CLIMB_HOLD) {
          this.rung++;
          this.samples.length = 0;
          this.sum = 0;
          this.climbStreak = 0;
        }
      } else {
        this.climbStreak = 0;
      }
    }
    return this.targetFps;
  }
}

export {
  FpsGovernor,
}
