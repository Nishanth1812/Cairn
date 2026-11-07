export async function runHookSafely<T>(hook: () => T | Promise<T>, timeoutMs = 450, ceilingMs = 499): Promise<T | undefined> {
  const timeout = Math.min(Math.max(timeoutMs, 1), ceilingMs); // Hooks stay under 500 ms; only tests raise the ceiling.
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeout); });
  // Clear the timer: a live one keeps the hook process running until the work is done even after the work is done.
  return Promise.race([Promise.resolve().then(hook), expired]).finally(() => clearTimeout(timer));
}
