/**
 * Process-level restart hook. index.ts owns the actual soft-restart
 * machinery (it has the boot sequence and signal handlers in scope);
 * /boot needs to trigger it without an import cycle with index.ts.
 *
 * The hook is registered once at the end of main() — if /boot is
 * somehow invoked before registration (it can't be: commands only
 * dispatch after login, which happens inside boot), the caller gets
 * a clear error instead of a silent no-op.
 */

type RestartFn = (reason: string, requestedBy: string) => void;

let hook: RestartFn | null = null;

export function registerRestartHook(fn: RestartFn): void {
  hook = fn;
}

export function triggerSoftRestart(reason: string, requestedBy: string): void {
  if (!hook) {
    throw new Error("Soft restart requested before the boot sequence registered the hook — this is a bug.");
  }
  hook(reason, requestedBy);
}

/** Test/introspection aid: is the hook armed? */
export function isRestartHookArmed(): boolean {
  return hook !== null;
}
