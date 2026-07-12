/** Serializes async work so concurrent callers never interleave their read-modify-write JSON file access. DB swap replaces this with a real transaction. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
