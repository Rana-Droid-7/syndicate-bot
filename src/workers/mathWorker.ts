import { parentPort, workerData } from "node:worker_threads";
import { evaluate } from "mathjs";

// This runs in a completely separate thread/V8 isolate. If the
// expression hangs (huge ranges, matrices, whatever else mathjs's
// expression language allows that we didn't think to name), the
// main thread kills THIS THREAD via worker.terminate() after a
// timeout — which actually stops the computation, unlike anything
// we could do from within a single-threaded main process.
try {
  const start = Date.now();
  const result = evaluate(workerData.expression);
  const resultText = String(result);
  const elapsed = Date.now() - start;
  parentPort?.postMessage({ ok: true, resultText, elapsedMs: elapsed });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
