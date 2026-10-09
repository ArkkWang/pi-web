/** Coalesce file notifications; never overlap reads or lose a change during IO. */
export function createSessionFileRefresh(options: {
  enabled(): boolean;
  refresh(): Promise<boolean>;
  delayMs?: number;
  retryMs?: number;
}) {
  let dirty = false;
  let running = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay = options.delayMs ?? 250) => {
    if (disposed || running || timer || !dirty || !options.enabled()) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  };
  const flush = async () => {
    if (disposed || !options.enabled()) return;
    dirty = false;
    running = true;
    let success = false;
    try { success = await options.refresh(); }
    catch { /* Keep the displayed snapshot; retry transient IO/network errors. */ }
    finally {
      running = false;
      if (!success) dirty = true;
      schedule(success ? options.delayMs ?? 250 : options.retryMs ?? 1000);
    }
  };
  return {
    invalidate() { dirty = true; schedule(); },
    dispose() { disposed = true; if (timer) clearTimeout(timer); },
  };
}
