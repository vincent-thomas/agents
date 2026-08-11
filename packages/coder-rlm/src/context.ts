/** JSON-like data values exposed by a caller-provided RLM sandbox context. */
export type RLMContextJSONValue =
  | string
  | number
  | boolean
  | null
  | readonly RLMContextJSONValue[]
  | { readonly [key: string]: RLMContextJSONValue };

/** A host callback available from a custom sandbox context. */
export type RLMContextFunction = (
  ...args: RLMContextJSONValue[]
) => RLMContextJSONValue | Promise<RLMContextJSONValue>;

/** A recursive custom-context value, including callable capabilities. */
export type RLMContextValue =
  | string
  | number
  | boolean
  | null
  | readonly RLMContextValue[]
  | { readonly [key: string]: RLMContextValue }
  | RLMContextFunction;

/** The root record supplied as the literal replacement for the built-in ctx. */
export type RLMContext = { readonly [key: string]: RLMContextValue };

export type RLMContextDescriptor =
  | { kind: "value"; value: string | number | boolean | null }
  | { kind: "function"; functionId: number }
  | { kind: "array"; values: RLMContextDescriptor[] }
  | { kind: "record"; entries: { key: string; value: RLMContextDescriptor }[] };

export interface RegisteredRLMContextFunction {
  readonly functionId: number;
  readonly fn: (...args: unknown[]) => unknown;
}

export interface RLMContextRegistration {
  readonly descriptor: RLMContextDescriptor;
  readonly functions: ReadonlyMap<number, RegisteredRLMContextFunction>;
}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Validate and snapshot a custom context without invoking accessors. */
export function registerRLMContext(ctx: RLMContext): RLMContextRegistration {
  const functions = new Map<number, RegisteredRLMContextFunction>();
  let nextFunctionId = 1;
  const seen = new Set<object>();

  const visit = (value: unknown, path: string, owner: object | undefined): RLMContextDescriptor => {
    if (value === null) return { kind: "value", value: null };
    if (typeof value === "string" || typeof value === "boolean") {
      return { kind: "value", value };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must contain a finite number`);
      }
      return { kind: "value", value };
    }
    if (typeof value === "function") {
      const functionId = nextFunctionId++;
      // Binding at registration makes owner-this behavior explicit and prevents the
      // sandbox from choosing a host receiver.
      functions.set(functionId, { functionId, fn: value.bind(owner) });
      return { kind: "function", functionId };
    }
    if (typeof value === "undefined") {
      throw new TypeError(`${path} is unsupported (undefined is not JSON-like)`);
    }
    if (typeof value === "symbol") {
      throw new TypeError(`${path} is unsupported (symbols are not allowed)`);
    }
    if (typeof value === "bigint") {
      throw new TypeError(`${path} is unsupported (bigint is not allowed)`);
    }
    if (typeof value !== "object") {
      throw new TypeError(`${path} is unsupported`);
    }
    if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
    seen.add(value);
    try {
      if (Array.isArray(value)) return visitArray(value, path);
      if (!isPlainRecord(value)) {
        throw new TypeError(`${path} must be a plain record or array`);
      }
      return visitRecord(value, path);
    } finally {
      seen.delete(value);
    }
  };

  const visitArray = (value: unknown[], path: string): RLMContextDescriptor => {
    const names = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) throw new TypeError(`${path} contains unsupported symbol properties`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      throw new TypeError(`${path}.length must be a data property`);
    }
    const values: RLMContextDescriptor[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) throw new TypeError(`${path}[${index}] is a sparse array element`);
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}[${index}] must be an enumerable data property`);
      }
      values.push(visit(descriptor.value, `${path}[${index}]`, value));
    }
    for (const key of names) {
      if (key === "length") continue;
      if (!isArrayIndex(key, value.length)) {
        throw new TypeError(`${path}.${key} is an unsupported array property`);
      }
    }
    return { kind: "array", values };
  };

  const visitRecord = (value: Record<string, unknown>, path: string): RLMContextDescriptor => {
    const entries: { key: string; value: RLMContextDescriptor }[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${path} contains unsupported symbol properties`);
      }
      if (DANGEROUS_KEYS.has(key)) throw new TypeError(`${path}.${key} is a dangerous key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be a data property, not an accessor`);
      }
      if (!descriptor.enumerable) throw new TypeError(`${path}.${key} must be enumerable`);
      entries.push({ key, value: visit(descriptor.value, childPath(path, key), value) });
    }
    return { kind: "record", entries };
  };

  if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx) || !isPlainRecord(ctx)) {
    throw new TypeError("ctx must be a plain record when provided");
  }
  const descriptor = visit(ctx, "ctx", undefined);
  return { descriptor, functions };
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

const MAX_INVENTORY_LINES = 100;
const MAX_INVENTORY_DEPTH = 8;
const MAX_INVENTORY_LINE_LENGTH = 240;

export function rlmContextInventory(descriptor: RLMContextDescriptor): string[] {
  const inventory: string[] = [];
  let omitted = false;
  const append = (line: string): boolean => {
    // Reserve the final line for an explicit truncation marker.
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
  const visit = (value: RLMContextDescriptor, path: string, depth: number): void => {
    if (!append(`${path}: ${value.kind}`)) return;
    if (value.kind !== "array" && value.kind !== "record") return;
    if (depth >= MAX_INVENTORY_DEPTH) {
      omitted = true;
      return;
    }
    if (value.kind === "array") {
      for (let index = 0; index < value.values.length; index += 1) {
        visit(value.values[index], `${path}[${index}]`, depth + 1);
        if (omitted) break;
      }
    } else {
      for (const entry of value.entries) {
        visit(entry.value, childPath(path, entry.key), depth + 1);
        if (omitted) break;
      }
    }
  };
  visit(descriptor, "ctx", 0);
  if (omitted) {
    if (inventory.length === MAX_INVENTORY_LINES) inventory.pop();
    inventory.push("… additional ctx entries omitted; inspect ctx from JavaScript when needed");
  }
  return inventory;
}
