import { fail } from "./errors.js";

/** Stack of active function builders; body() callbacks push/pop. */
const stack = [];

export function pushBuilder(b) {
  stack.push(b);
}

export function popBuilder() {
  stack.pop();
}

/** @returns {import('./builder.js').FunctionBuilder | null} */
export function currentBuilder() {
  return stack.length ? stack[stack.length - 1] : null;
}

export function requireBuilder(what) {
  const b = currentBuilder();
  if (!b) fail(`${what}: no active function body — expressions may only be built inside .body() callbacks`);
  return b;
}
