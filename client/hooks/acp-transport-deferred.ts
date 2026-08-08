/** Tiny deferred promise for socket handshake / ping waiters. */
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  settled: boolean;
};

export function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // Nobody may be awaiting when a generation is torn down.
  promise.catch(() => {});
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => {
      if (d.settled) return;
      d.settled = true;
      resolveFn(value);
    },
    reject: (err) => {
      if (d.settled) return;
      d.settled = true;
      rejectFn(err);
    },
  };
  return d;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
