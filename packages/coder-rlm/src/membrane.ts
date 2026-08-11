import { inspect } from "node:util";
import type { RLMContext } from "./context.ts";

type MembraneObject = object | Function;
type View = object | Function;

/**
 * Build a live membrane over a caller-owned context. Every proxy target is a
 * shadow: the root is a null-prototype shadow which rejects writes, while
 * nested shadows forward writes to their source. This separation permits
 * virtual descriptors for frozen/non-configurable source properties.
 */
export function createReadOnlyContextFacade(source: RLMContext): RLMContext {
  if (typeof source !== "object" || source === null) {
    throw new TypeError("ctx must be a non-null object when provided");
  }

  const sourceToView = new WeakMap<MembraneObject, View>();
  const viewToSource = new WeakMap<MembraneObject, MembraneObject>();
  const accessorViews = new WeakMap<Function, WeakMap<object, Function>>();
  const rootTarget = Object.create(null) as Record<PropertyKey, unknown>;
  let rootProxy: RLMContext;

  const isObjectLike = (value: unknown): value is MembraneObject =>
    (typeof value === "object" || typeof value === "function") && value !== null;
  const unwrap = <T>(value: T): T => {
    if (!isObjectLike(value)) return value;
    return (viewToSource.get(value) as T | undefined) ?? value;
  };

  const wrap = <T>(value: T): T => {
    if (!isObjectLike(value)) return value;
    if (viewToSource.has(value)) return value;
    if (value === source) return rootProxy as T;
    const existing = sourceToView.get(value);
    if (existing) return existing as T;
    return (typeof value === "function" ? createFunctionView(value) : createObjectView(value)) as T;
  };
  const throwWrapped = (error: unknown): never => {
    throw wrap(error);
  };
  const wrapResult = (value: unknown): unknown => {
    try {
      if (isObjectLike(value) && typeof (value as { then?: unknown }).then === "function") {
        return Promise.resolve(value as PromiseLike<unknown>).then(
          (result) => wrap(result),
          (error) => throwWrapped(error),
        );
      }
      return wrap(value);
    } catch (error) {
      return throwWrapped(error);
    }
  };
  const marshalArgument = (value: unknown): unknown => {
    const unwrapped = unwrap(value);
    // Collection methods invoke callbacks with source values. Re-enter the
    // membrane for callback arguments, and unwrap callback results for the
    // host. A callback throw is crossing back to host code, so unwrap it.
    if (typeof unwrapped === "function" && !viewToSource.has(value as MembraneObject)) {
      return function adaptedCallback(this: unknown, ...args: unknown[]) {
        const callbackThis = isObjectLike(this) ? wrap(this) : this;
        try {
          const result = Reflect.apply(
            unwrapped,
            callbackThis,
            args.map((arg) => wrap(arg)),
          );
          if (isObjectLike(result) && typeof (result as { then?: unknown }).then === "function") {
            return Promise.resolve(result as PromiseLike<unknown>).then(
              (resolved) => unwrap(resolved),
              (error) => {
                throw unwrap(error);
              },
            );
          }
          return unwrap(result);
        } catch (error) {
          throw unwrap(error);
        }
      };
    }
    return unwrapped;
  };
  const invoke = (fn: Function, thisArg: unknown, args: readonly unknown[]): unknown => {
    try {
      return wrapResult(Reflect.apply(fn, unwrap(thisArg), args.map(marshalArgument)));
    } catch (error) {
      return throwWrapped(error);
    }
  };
  const isConstructable = (fn: Function): boolean => {
    try {
      Reflect.construct(String, [], fn);
      return true;
    } catch {
      return false;
    }
  };

  function createFunctionView(fn: Function): Function {
    const existing = sourceToView.get(fn);
    if (existing) return existing as Function;
    const constructable = isConstructable(fn);
    let view!: Function;
    view = function membraneFunction(this: unknown, ...args: unknown[]) {
      if (new.target !== undefined) {
        if (!constructable) return throwWrapped(new TypeError("function is not a constructor"));
        try {
          const newTarget =
            new.target === view || new.target === membraneView ? fn : unwrap(new.target);
          return wrap(Reflect.construct(fn, args.map(marshalArgument), newTarget as Function));
        } catch (error) {
          return throwWrapped(error);
        }
      }
      return invoke(fn, this, args);
    };
    const membraneView = new Proxy(view, {
      get(target, key) {
        try {
          const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (
            targetDescriptor &&
            !targetDescriptor.configurable &&
            "value" in targetDescriptor &&
            !targetDescriptor.writable
          ) {
            return targetDescriptor.value;
          }
          return wrap(Reflect.get(fn, key, fn));
        } catch (error) {
          return throwWrapped(error);
        }
      },
      set(target, key, value) {
        const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (
          targetDescriptor &&
          !targetDescriptor.configurable &&
          "value" in targetDescriptor &&
          !targetDescriptor.writable
        ) {
          throw new TypeError(`function property ${String(key)} is read-only`);
        }
        try {
          return Reflect.set(fn, key, unwrap(value), fn);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      defineProperty(target, key, descriptor) {
        if (Reflect.getOwnPropertyDescriptor(target, key)?.configurable === false) {
          throw new TypeError(`function property ${String(key)} cannot be redefined`);
        }
        try {
          const mapped = { ...descriptor };
          if ("value" in mapped) mapped.value = unwrap(mapped.value);
          if (mapped.get) mapped.get = unwrap(mapped.get);
          if (mapped.set) mapped.set = unwrap(mapped.set);
          return Reflect.defineProperty(fn, key, mapped);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      deleteProperty(target, key) {
        if (Reflect.getOwnPropertyDescriptor(target, key)?.configurable === false) return false;
        try {
          return Reflect.deleteProperty(fn, key);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      has: (_target, key) => Reflect.has(fn, key),
      ownKeys(target) {
        return [...new Set([...Reflect.ownKeys(fn), ...Reflect.ownKeys(target)])];
      },
      getOwnPropertyDescriptor(target, key) {
        const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (targetDescriptor?.configurable === false) return targetDescriptor;
        const descriptor = Reflect.getOwnPropertyDescriptor(fn, key);
        return descriptor ? mapDescriptor(descriptor, fn, false) : targetDescriptor;
      },
      getPrototypeOf: () => {
        try {
          const prototype = Reflect.getPrototypeOf(fn);
          return prototype === null ? null : wrap(prototype);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      setPrototypeOf: (_target, prototype) => {
        try {
          return Reflect.setPrototypeOf(fn, unwrap(prototype));
        } catch (error) {
          return throwWrapped(error);
        }
      },
      isExtensible: () => true,
      preventExtensions: () => {
        throw new TypeError("function membrane views cannot be made non-extensible");
      },
    });
    // Cache before reading prototype so recursive constructor references map.
    sourceToView.set(fn, membraneView);
    viewToSource.set(view, fn);
    viewToSource.set(membraneView, fn);
    try {
      Object.defineProperty(view, "name", {
        value: typeof fn.name === "string" ? fn.name : "",
        configurable: true,
      });
      Object.defineProperty(view, "length", {
        value: typeof fn.length === "number" ? fn.length : 0,
        configurable: true,
      });
      if (constructable) {
        const descriptor = Object.getOwnPropertyDescriptor(fn, "prototype");
        if (descriptor && "value" in descriptor) {
          Object.defineProperty(view, "prototype", {
            value: wrap(descriptor.value),
            writable: true,
            enumerable: false,
            configurable: false,
          });
        }
      }
    } catch {
      // Function custom reflection is intentionally omitted.
    }
    return membraneView;
  }

  function createAccessorView(fn: Function, owner: object): Function {
    let byOwner = accessorViews.get(fn);
    if (!byOwner) {
      byOwner = new WeakMap<object, Function>();
      accessorViews.set(fn, byOwner);
    }
    const existing = byOwner.get(owner);
    if (existing) return existing;
    const target = function membraneAccessor(this: unknown, ...args: unknown[]) {
      try {
        const receiver = isObjectLike(this) && viewToSource.has(this) ? unwrap(this) : owner;
        return wrapResult(Reflect.apply(fn, receiver, args.map(unwrap)));
      } catch (error) {
        return throwWrapped(error);
      }
    };
    const view = new Proxy(target, {
      getPrototypeOf: () => {
        try {
          const prototype = Reflect.getPrototypeOf(fn);
          return prototype === null ? null : wrap(prototype);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      setPrototypeOf: (_target, prototype) => {
        try {
          return Reflect.setPrototypeOf(fn, unwrap(prototype));
        } catch (error) {
          return throwWrapped(error);
        }
      },
      isExtensible: () => true,
      preventExtensions: () => {
        throw new TypeError("accessor membrane views cannot be made non-extensible");
      },
    });
    byOwner.set(owner, view);
    viewToSource.set(target, fn);
    viewToSource.set(view, fn);
    return view;
  }

  function mapDescriptor(
    descriptor: PropertyDescriptor,
    owner: object,
    root: boolean,
  ): PropertyDescriptor {
    if ("value" in descriptor) {
      return {
        ...descriptor,
        configurable: true,
        writable: root ? false : descriptor.writable,
        value: wrap(descriptor.value),
      };
    }
    return {
      ...descriptor,
      configurable: true,
      get: descriptor.get ? createAccessorView(descriptor.get, owner) : undefined,
      set: root
        ? undefined
        : descriptor.set
          ? createAccessorView(descriptor.set, owner)
          : undefined,
    };
  }

  function syncArrayShadow(target: unknown[], sourceArray: object): void {
    const sourceLength = Reflect.get(sourceArray, "length", sourceArray) as number;
    const sourceDescriptor = Reflect.getOwnPropertyDescriptor(sourceArray, "length");
    const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, "length");
    // Synchronize the value before mirroring a transition to non-writable;
    // once frozen, neither source nor shadow length can change again.
    if (target.length !== sourceLength && targetDescriptor?.writable !== false) {
      target.length = sourceLength;
    }
    if (targetDescriptor?.writable && sourceDescriptor && !sourceDescriptor.writable) {
      Object.defineProperty(target, "length", { writable: false });
    }
  }

  function createObjectView(sourceObject: object): object {
    const existing = sourceToView.get(sourceObject);
    if (existing) return existing;
    const isArray = Array.isArray(sourceObject);
    const target = isArray ? [] : Object.create(null);
    if (isArray) {
      const descriptor = Reflect.getOwnPropertyDescriptor(sourceObject, "length");
      Object.defineProperty(target, "length", {
        value: Reflect.get(sourceObject, "length", sourceObject),
        writable: descriptor?.writable !== false,
        enumerable: false,
        configurable: false,
      });
    }
    // node:util.inspect reads a Proxy's shadow target rather than all virtual
    // descriptors. Keep its diagnostic view useful without putting any source
    // value on the target or making the value reachable through the membrane.
    Object.defineProperty(target, inspect.custom, {
      configurable: true,
      value: () => {
        const snapshot: unknown[] | Record<PropertyKey, unknown> = isArray
          ? []
          : Object.create(null);
        if (isArray)
          (snapshot as unknown[]).length = Reflect.get(
            sourceObject,
            "length",
            sourceObject,
          ) as number;
        for (const key of Reflect.ownKeys(sourceObject)) {
          if (isArray && key === "length") continue;
          const descriptor = Reflect.getOwnPropertyDescriptor(sourceObject, key);
          if (!descriptor || !("value" in descriptor)) continue;
          if (isArray && typeof key === "string")
            (snapshot as unknown[])[Number(key)] = wrap(descriptor.value);
          else (snapshot as Record<PropertyKey, unknown>)[key] = wrap(descriptor.value);
        }
        return snapshot;
      },
    });
    const handler: ProxyHandler<object> = {
      get(_target, key) {
        try {
          if (key === inspect.custom) return Reflect.get(target, key, target);
          if (isArray && key === "length") syncArrayShadow(target as unknown[], sourceObject);
          return wrap(Reflect.get(sourceObject, key, sourceObject));
        } catch (error) {
          return throwWrapped(error);
        }
      },
      set(_target, key, value) {
        try {
          return Reflect.set(sourceObject, key, unwrap(value), sourceObject);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      defineProperty(_target, key, descriptor) {
        try {
          const mapped = { ...descriptor };
          if ("value" in mapped) mapped.value = unwrap(mapped.value);
          if (mapped.get) mapped.get = unwrap(mapped.get);
          if (mapped.set) mapped.set = unwrap(mapped.set);
          const result = Reflect.defineProperty(sourceObject, key, mapped);
          if (isArray) syncArrayShadow(target as unknown[], sourceObject);
          return result;
        } catch (error) {
          return throwWrapped(error);
        }
      },
      deleteProperty(_target, key) {
        try {
          return Reflect.deleteProperty(sourceObject, key);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      has(_target, key) {
        try {
          return Reflect.has(sourceObject, key);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      ownKeys() {
        try {
          if (isArray) syncArrayShadow(target as unknown[], sourceObject);
          return Reflect.ownKeys(sourceObject);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      getOwnPropertyDescriptor(_target, key) {
        try {
          if (isArray) syncArrayShadow(target as unknown[], sourceObject);
          const descriptor = Reflect.getOwnPropertyDescriptor(sourceObject, key);
          if (!descriptor) return undefined;
          if (isArray && key === "length") {
            return Reflect.getOwnPropertyDescriptor(target, "length")!;
          }
          return mapDescriptor(descriptor, sourceObject, false);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      getPrototypeOf() {
        try {
          const prototype = Reflect.getPrototypeOf(sourceObject);
          return prototype === null ? null : wrap(prototype);
        } catch (error) {
          return throwWrapped(error);
        }
      },
      setPrototypeOf(_target, prototype) {
        try {
          return Reflect.setPrototypeOf(sourceObject, unwrap(prototype));
        } catch (error) {
          return throwWrapped(error);
        }
      },
      // Keeping the shadow extensible is necessary for virtual descriptors;
      // rejecting this trap documents the unsupported nested freeze/seal API.
      isExtensible: () => true,
      preventExtensions: () => {
        throw new TypeError("nested membrane views cannot be made non-extensible");
      },
    };
    const view = new Proxy(target, handler);
    sourceToView.set(sourceObject, view);
    viewToSource.set(view, sourceObject);
    return view;
  }

  const rootHandler: ProxyHandler<Record<PropertyKey, unknown>> = {
    get(_target, key) {
      try {
        if (key === inspect.custom) return undefined;
        return Reflect.getOwnPropertyDescriptor(source, key)
          ? wrap(Reflect.get(source, key, source))
          : undefined;
      } catch (error) {
        return throwWrapped(error);
      }
    },
    set: () => {
      throw new TypeError("ctx is a read-only facade");
    },
    defineProperty: () => {
      throw new TypeError("ctx is a read-only facade");
    },
    deleteProperty: () => {
      throw new TypeError("ctx is a read-only facade");
    },
    setPrototypeOf: () => {
      throw new TypeError("ctx is a read-only facade");
    },
    preventExtensions: () => {
      throw new TypeError("ctx is a read-only facade");
    },
    has(_target, key) {
      try {
        return (
          Reflect.has(source, key) && Reflect.getOwnPropertyDescriptor(source, key) !== undefined
        );
      } catch (error) {
        return throwWrapped(error);
      }
    },
    ownKeys() {
      try {
        return Reflect.ownKeys(source);
      } catch (error) {
        return throwWrapped(error);
      }
    },
    getOwnPropertyDescriptor(_target, key) {
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        return descriptor ? mapDescriptor(descriptor, source, true) : undefined;
      } catch (error) {
        return throwWrapped(error);
      }
    },
    getPrototypeOf: () => null,
    isExtensible: () => true,
  };

  rootProxy = new Proxy(rootTarget, rootHandler) as RLMContext;
  sourceToView.set(source, rootProxy);
  viewToSource.set(rootProxy, source);
  return rootProxy;
}
