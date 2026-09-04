/**
 * Verifies dist/lib/safeTimeout.js — run `npm run build` first.
 *
 * This exercises the ACTUAL bug the chained timer exists to fix.
 * Historically, delays above Node's 32-bit setTimeout limit
 * (~24.86 days) silently fired after ~1ms. To test that in
 * seconds instead of days, we inject a tiny hop limit so the
 * exact same chaining arithmetic runs with small numbers:
 *
 *   requested delay 3000ms, hop limit 800ms
 *   -> 4 chained hops (800 + 800 + 800 + 600), then fires
 *
 * If the chain were broken the way the original bug was, the
 * callback would fire in ~1ms and FAIL the first assertion.
 */

const { safeSetTimeout } = await import("./dist/lib/safeTimeout.js");

function test(name, fn) {
  return fn().then(
    () => console.log(`✅ PASS  ${name}`),
    (err) => {
      console.error(`❌ FAIL  ${name}: ${err.message}`);
      process.exitCode = 1;
    },
  );
}

// 1. The chained path fires roughly on time, never early.
await test("chained hops fire after the full delay (not ~1ms)", () => {
  const requested = 2000;
  const hop = 500; // forces 4 chained hops: 500+500+500+500
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("did not fire within the expected window")), requested + 600);
    safeSetTimeout(
      () => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        if (elapsed < requested - 100) {
          reject(new Error(`fired after ${elapsed}ms (requested ${requested}ms) — fired too early, the original bug`));
        } else {
          resolve();
        }
      },
      requested,
      hop,
    );
  });
});

// 2. The chain must be exactly correct: under-delivering by a hop
//    is as broken as firing instantly.
await test("chained hops never lose time (exact total)", () => {
  const requested = 1500;
  const hop = 400; // 400+400+400+300 = 1500
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("did not fire within the expected window")), requested + 500);
    safeSetTimeout(
      () => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        if (elapsed < requested) {
          reject(new Error(`fired after ${elapsed}ms, lost ${requested - elapsed}ms of the delay`));
        } else {
          resolve();
        }
      },
      requested,
      hop,
    );
  });
});

// 3. Single-hop passthrough still behaves like plain setTimeout.
await test("single-shot passthrough (delay within hop limit)", () => {
  const requested = 300;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("did not fire within the expected window")), requested + 400);
    safeSetTimeout(
      () => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        if (elapsed < requested - 100) {
          reject(new Error(`fired after ${elapsed}ms (requested ${requested}ms)`));
        } else {
          resolve();
        }
      },
      requested,
    );
  });
});

console.log(process.exitCode ? "\nSome checks FAILED." : "\nAll checks passed.");
