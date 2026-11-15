/** ES5 super calls must run real field initializers on the derived prototype. */
export function constructLegacy<T extends object>(
  base: new (...args: never[]) => T,
  receiver: T,
  args: ArrayLike<unknown>,
): T {
  if (!(receiver instanceof base))
    throw new TypeError("Legacy superclass calls require a derived receiver");
  return Reflect.construct(base, Array.from(args), receiver.constructor) as T;
}
