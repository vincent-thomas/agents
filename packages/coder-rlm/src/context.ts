/**
 * The exact host object supplied as a custom RLM context. Custom contexts are
 * intentionally not JSON-like: prototypes, accessors, functions, cycles, and
 * mutations remain live in the in-process runtime.
 */
export type RLMContext = object;

const MAX_INVENTORY_LINES = 100;
const MAX_INVENTORY_DEPTH = 8;
const MAX_INVENTORY_LINE_LENGTH = 240;

/** Build a bounded inventory from descriptors without invoking getters. */
export function rlmContextInventory(ctx: RLMContext): string[] {
  const inventory: string[] = [];
  const seen = new Set<object>();
  let omitted = false;
  const append = (line: string): boolean => {
    if (inventory.length >= MAX_INVENTORY_LINES - 1) {
      omitted = true;
      return false;
    }
    inventory.push(
      line.length <= MAX_INVENTORY_LINE_LENGTH
        ? line
        : `${line.slice(0, MAX_INVENTORY_LINE_LENGTH - 1)}…`,
    );
    return true;
  };
  const describe = (value: unknown): string => {
    if (typeof value === "function") return "function";
    if (value === null) return "null";
    if (typeof value !== "object") return typeof value;
    return Array.isArray(value) ? "array" : "object";
  };
  const pathFor = (path: string, key: PropertyKey): string => {
    if (typeof key === "string") {
      const quoted = JSON.stringify(key).replace(
        /[\u0085\u2028\u2029]/g,
        (value) => `\\u${value.codePointAt(0)?.toString(16).padStart(4, "0")}`,
      );
      return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${quoted}]`;
    }
    return `${path}[<symbol>]`;
  };
  const visit = (value: unknown, path: string, depth: number): void => {
    if (!append(`${path}: ${describe(value)}`)) return;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    if (typeof value === "function") return;
    if (seen.has(value)) {
      append(`${path}: cycle`);
      return;
    }
    if (depth >= MAX_INVENTORY_DEPTH) {
      omitted = true;
      return;
    }
    seen.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        const child = pathFor(path, key);
        if ("value" in descriptor) visit(descriptor.value, child, depth + 1);
        else if (!append(`${child}: accessor`)) return;
        if (omitted) return;
      }
    } finally {
      seen.delete(value);
    }
  };
  visit(ctx, "ctx", 0);
  if (omitted) {
    if (inventory.length === MAX_INVENTORY_LINES) inventory.pop();
    inventory.push("… additional ctx entries omitted; inspect the exact live ctx from JavaScript");
  }
  return inventory;
}
