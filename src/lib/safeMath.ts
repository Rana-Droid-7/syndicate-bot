import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { log } from "../core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the worker file the same way commandHandler/eventHandler
// do — check which extension actually exists on disk. Under
// `tsx watch` (dev) only mathWorker.ts exists; under the compiled
// build (dist/) only mathWorker.js exists.
function resolveWorkerPath(): { url: URL; isTypeScript: boolean } {
  const tsPath = path.join(__dirname, "..", "workers", "mathWorker.ts");
  const jsPath = path.join(__dirname, "..", "workers", "mathWorker.js");

  if (existsSync(jsPath)) {
    return { url: pathToFileURL(jsPath), isTypeScript: false };
  }
  if (existsSync(tsPath)) {
    return { url: pathToFileURL(tsPath), isTypeScript: true };
  }
  throw new Error(`Math worker file not found at ${tsPath} or ${jsPath}`);
}

// Fast-path rejection for known-dangerous patterns — catches the
// common cases (and the exact case that was empirically confirmed
// to hang the bot) instantly, without paying worker-spawn overhead.
// This is a CONVENIENCE, not the security boundary — see the
// worker-thread timeout below for the actual guarantee, since a
// name/pattern blocklist can never be complete (confirmed: mathjs's
// colon range operator, e.g. "1:10000000", produces the exact same
// hang and matches none of these function-call patterns).
const BLOCKED_FUNCTIONS = [
  "range", "ones", "zeros", "identity", "resize", "reshape", "concat",
  "kron", "map", "forEach", "filter", "reduce", "import", "evaluate",
  "parse", "compile", "simplify", "derivative", "rationalize",
];
const BLOCKED_FUNCTION_PATTERN = new RegExp(`\\b(${BLOCKED_FUNCTIONS.join("|")})\\s*\\(`, "i");
const COLON_RANGE_PATTERN = /\d\s*:\s*\d/; // mathjs's native range operator, e.g. "1:10000000"

const WORKER_TIMEOUT_MS = 3000;
const MAX_RESULT_LENGTH = 500;
const MAX_EXPRESSION_LENGTH = 200;

export interface SafeEvalResult {
  ok: boolean;
  resultText?: string;
  error?: string;
}

export async function safeEvaluate(expression: string): Promise<SafeEvalResult> {
  log.info("CALC", `Evaluation requested: ${JSON.stringify(expression)}`);

  if (expression.length > MAX_EXPRESSION_LENGTH) {
    log.warn("CALC", `Rejected — expression exceeds ${MAX_EXPRESSION_LENGTH} chars (${expression.length}).`);
    return { ok: false, error: `Expression is too long (max ${MAX_EXPRESSION_LENGTH} characters).` };
  }

  if (BLOCKED_FUNCTION_PATTERN.test(expression)) {
    log.warn("CALC", `Fast-path reject — blocked function name in: ${JSON.stringify(expression)}`);
    return {
      ok: false,
      error: "That expression uses a function that's disabled here (it can generate huge results). Stick to arithmetic, trig, sqrt, log, etc.",
    };
  }
  if (COLON_RANGE_PATTERN.test(expression)) {
    log.warn("CALC", `Fast-path reject — colon range operator in: ${JSON.stringify(expression)}`);
    return { ok: false, error: "Range syntax (e.g. `1:1000000`) is disabled here — it can generate huge results." };
  }

  // Real security boundary: evaluate in a separate worker thread
  // with a hard timeout. If it hangs for ANY reason — a pattern we
  // didn't think to blocklist, a future mathjs function, anything —
  // we kill the worker outright. This is the only way to actually
  // interrupt a hung synchronous computation in Node.js.
  return new Promise((resolve) => {
    let worker: Worker;
    let settled = false;

    try {
      const { url, isTypeScript } = resolveWorkerPath();
      log.debug("CALC", `Spawning worker (${isTypeScript ? "tsx/TypeScript" : "compiled JS"}): ${url.pathname}`);

      worker = new Worker(url, {
        workerData: { expression },
        // Belt-and-suspenders next to the 3s kill: memory bombs
        // (huge matrix/range literals) can OOM the process before
        // any timeout fires. A hard heap ceiling makes the worker
        // crash on allocation instead — surfaced as 'error' below.
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
        ...(isTypeScript ? { execArgv: ["--import", "tsx"] } : {}),
      });
    } catch (error) {
      log.error("CALC", "Failed to spawn math worker", error);
      resolve({ ok: false, error: "Calculator is temporarily unavailable." });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn("CALC", `Worker exceeded ${WORKER_TIMEOUT_MS}ms — terminating. Expression: ${JSON.stringify(expression)}`);
      worker.terminate().catch((err) => log.error("CALC", "Failed to terminate worker", err));
      resolve({ ok: false, error: "That expression took too long to evaluate and was cancelled." });
    }, WORKER_TIMEOUT_MS);

    worker.once("message", (msg: SafeEvalResult & { elapsedMs?: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => null);

      if (!msg.ok) {
        log.debug("CALC", `Worker reported evaluation error: ${msg.error}`);
        resolve({ ok: false, error: `Couldn't evaluate \`${expression}\`. Try something like \`(3 + 4) * 2\`, \`sqrt(16)\`, or \`2^10\`.` });
        return;
      }

      log.info("CALC", `Worker evaluated in ${msg.elapsedMs}ms, result length ${msg.resultText?.length}.`);

      if ((msg.resultText?.length ?? 0) > MAX_RESULT_LENGTH) {
        log.warn("CALC", `Result too large to display (${msg.resultText?.length} chars).`);
        resolve({ ok: false, error: "That result is too large to display here." });
        return;
      }

      resolve({ ok: true, resultText: msg.resultText });
    });

    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.error("CALC", "Worker thread error", error);
      resolve({ ok: false, error: "Something went wrong evaluating that expression." });
    });
  });
}
