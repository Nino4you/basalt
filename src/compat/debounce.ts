export interface Debouncer<Args extends unknown[], Result> {
  (...args: Args): Debouncer<Args, Result>;
  cancel(): Debouncer<Args, Result>;
  run(): Result | undefined;
}

/** Trailing callback, with either a fixed window or a timer reset on every invocation. */
export function debounce<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
  timeout = 0,
  resetTimer = false,
): Debouncer<Args, Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { args: Args; context: unknown } | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const run = (): Result | undefined => {
    clear();
    if (!pending) return;
    const invocation = pending;
    pending = undefined;
    return callback.apply(invocation.context, invocation.args);
  };
  const debounced = function (this: unknown, ...args: Args) {
    pending = { args, context: this };
    if (timer !== undefined && resetTimer) clear();
    if (timer === undefined) timer = setTimeout(run, Math.max(0, timeout));
    return debounced;
  } as Debouncer<Args, Result>;
  debounced.cancel = () => {
    clear();
    pending = undefined;
    return debounced;
  };
  debounced.run = run;
  return debounced;
}
