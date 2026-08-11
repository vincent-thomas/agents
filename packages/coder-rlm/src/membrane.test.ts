import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { createReadOnlyContextFacade } from "./membrane.ts";

test("shadow views virtualize frozen properties and prototypes", () => {
  const source: any = {};
  Object.defineProperty(source, "fixed", {
    value: { root: source },
    configurable: false,
    writable: false,
    enumerable: true,
  });
  const prototype = { root: source };
  const nested = Object.create(prototype);
  source.nested = nested;
  const facade: any = createReadOnlyContextFacade(source);

  assert.equal(facade.fixed.root, facade);
  assert.equal(Reflect.getOwnPropertyDescriptor(facade, "fixed")?.value.root, facade);
  assert.equal(Reflect.getOwnPropertyDescriptor(facade.nested, "root"), undefined);
  assert.equal(facade.nested.root, facade);
  assert.equal(Object.getPrototypeOf(facade.nested).root, facade);
  assert.doesNotThrow(() => Reflect.getOwnPropertyDescriptor(facade.fixed, "root"));
  assert.throws(() => Object.freeze(facade.nested), /non-extensible/);
});

test("array shadows remain arrays, synchronize length, and forward mutation", () => {
  const source: any = { values: [{ n: 1 }] };
  const facade: any = createReadOnlyContextFacade(source);
  const values = facade.values;
  assert.equal(Array.isArray(values), true);
  assert.equal(values[0].n, 1);
  values.push({ n: 2 });
  values[0].n = 3;
  assert.equal(source.values.length, 2);
  assert.equal(source.values[0].n, 3);
  assert.equal(Object.getOwnPropertyDescriptor(values, "length")?.value, 2);
  assert.equal(values.map((item: any) => item.n).join(","), "3,2");
});

test("class private access and thrown values stay inside the membrane", async () => {
  class Secret {
    #value = 4;
    get doubled() {
      return this.#value * 2;
    }
    add(value: number) {
      return this.#value + value;
    }
  }
  const source: any = {};
  source.instance = new Secret();
  source.getter = Object.defineProperty({}, "value", {
    get() {
      throw { root: source, message: "getter" };
    },
  });
  source.thrower = () => {
    throw { root: source, message: "sync" };
  };
  source.fail = () => Promise.reject({ root: source, message: "async" });
  const facade: any = createReadOnlyContextFacade(source);

  assert.equal(facade.instance.doubled, 8);
  assert.equal(facade.instance.add(3), 7);
  assert.throws(
    () => facade.getter.value,
    (error: any) => error.root === facade,
  );
  assert.throws(
    () => facade.thrower(),
    (error: any) => error.root === facade,
  );
  await assert.rejects(facade.fail(), (error: any) => error.root === facade);
});

test("function views forward custom and static properties without allowing freezing", () => {
  function capability(this: any) {
    return this;
  }
  (capability as any).state = { count: 1 };
  class Factory {
    static make() {
      return { value: 3 };
    }
  }
  const source: any = { capability, Factory };
  const facade: any = createReadOnlyContextFacade(source);

  assert.equal(facade.capability(), facade);
  facade.capability.state.count = 2;
  assert.equal((capability as any).state.count, 2);
  facade.capability.extra = "live";
  assert.equal((capability as any).extra, "live");
  assert.equal(facade.Factory.make().value, 3);
  assert.throws(() => Object.freeze(facade.capability), /non-extensible/);
  assert.doesNotThrow(() => Object.getPrototypeOf(facade.capability));
});

suite("callback adaptation", () => {
  test("wraps callback values and unwraps callback results", () => {
    const source: any = { values: [{ root: undefined }] };
    source.values[0].root = source;
    const facade: any = createReadOnlyContextFacade(source);
    assert.equal(source.values.map((item: any) => item.root)[0], source);
    assert.equal(facade.values.map((item: any) => item.root === facade)[0], true);
  });
});
