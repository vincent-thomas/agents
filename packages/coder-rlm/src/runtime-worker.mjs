import repl from "node:repl";
import vm from "node:vm";
import { PassThrough } from "node:stream";
import { formatWithOptions } from "node:util";
import { createInterface } from "node:readline";
import { register } from "node:module";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const denyImportsSource = encodeURIComponent(
  'export async function resolve(specifier) { throw new Error("Dynamic import is disabled: " + specifier); }',
);
register(`data:text/javascript,${denyImportsSource}`, import.meta.url);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

let runtimeContext;
let replServer;
let maxOutputChars = 50_000;
let activeOutput;
let nextRlmCallId = 1;
let rootDirectory;
let activeExecutionRequestId;
let heartbeatTimer;
let heartbeatIntervalMs = 250;
const pendingRlmCalls = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendHeartbeat() {
  const pending =
    activeExecutionRequestId === undefined
      ? []
      : [...pendingRlmCalls.values()].filter(
          ({ requestId }) => requestId === activeExecutionRequestId,
        );
  send({
    type: "heartbeat",
    requestId: activeExecutionRequestId,
    operation:
      pending.length > 0 && pending.every(({ op }) => op === "waitAll") ? "waitAll" : undefined,
    pendingRlmCalls: pending.length,
  });
}

function startHeartbeats() {
  heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
}

function safeFunction(fn) {
  Object.setPrototypeOf(fn, null);
  return Object.freeze(fn);
}

function safeThenable(promise) {
  const thenable = Object.create(null);
  const then = safeFunction((onFulfilled, onRejected) =>
    safeThenable(promise.then(onFulfilled, onRejected)),
  );
  Object.defineProperty(thenable, "then", {
    value: then,
    enumerable: true,
  });
  return Object.freeze(thenable);
}

function formatValue(value) {
  return formatWithOptions(
    {
      colors: false,
      compact: 3,
      depth: 5,
      maxArrayLength: 100,
      maxStringLength: Math.min(maxOutputChars, 20_000),
      breakLength: 100,
    },
    value,
  );
}

function appendOutputText(level, text) {
  if (!activeOutput || activeOutput.truncated) return;
  const prefix = level === "error" ? "[error] " : "";
  const prefixedText = `${prefix}${text}`;
  const separator = activeOutput.lines.length === 0 ? "" : "\n";
  const remaining = maxOutputChars - activeOutput.length - separator.length;
  if (remaining <= 0) {
    activeOutput.truncated = true;
    return;
  }
  activeOutput.lines.push(prefixedText.slice(0, remaining));
  activeOutput.length += separator.length + Math.min(prefixedText.length, remaining);
  if (prefixedText.length > remaining) activeOutput.truncated = true;
}

function appendOutput(level, values) {
  appendOutputText(level, values.map(formatValue).join(" "));
}

function outputText(value) {
  if (value !== undefined) appendOutputText("log", `[result] ${formatValue(value)}`);
  const text = activeOutput.lines.join("\n");
  if (!activeOutput.truncated) return text || "JavaScript completed with no output.";
  const marker = `\n[output truncated at ${maxOutputChars} characters]`;
  return `${text.slice(0, Math.max(0, maxOutputChars - marker.length))}${marker}`;
}

function createRlmCall(op, payload) {
  const callId = nextRlmCallId++;
  const promise = new Promise((resolve, reject) => {
    pendingRlmCalls.set(callId, {
      resolve,
      reject,
      requestId: activeExecutionRequestId,
      op,
    });
    send({ type: "rlm", op, callId, ...payload });
    sendHeartbeat();
  });
  return safeThenable(promise);
}

function createRlm() {
  const rlm = Object.create(null);
  Object.defineProperties(rlm, {
    spawn: {
      value: safeFunction((prompt, options) => {
        if (typeof prompt !== "string" || prompt.trim() === "") {
          throw new TypeError("ctx.rlm.spawn() prompt must be a non-empty string");
        }
        if (
          options !== undefined &&
          (typeof options !== "object" || options === null || Array.isArray(options))
        ) {
          throw new TypeError("ctx.rlm.spawn() options must be an object when provided");
        }
        if (options?.name !== undefined && typeof options.name !== "string") {
          throw new TypeError("ctx.rlm.spawn() name must be a string when provided");
        }
        if (options?.context !== undefined && typeof options.context !== "string") {
          throw new TypeError("ctx.rlm.spawn() context must be a string when provided");
        }
        return createRlmCall("spawn", { prompt, options });
      }),
      enumerable: true,
    },
    waitAll: {
      value: safeFunction((handles) => {
        if (!Array.isArray(handles)) throw new TypeError("ctx.rlm.waitAll() expects an array");
        return safeThenable(
          Promise.all(handles).then((resolvedHandles) =>
            createRlmCall("waitAll", { handles: resolvedHandles }),
          ),
        );
      }),
      enumerable: true,
    },
    result: {
      value: safeFunction((handle) =>
        safeThenable(
          Promise.resolve(handle).then((resolvedHandle) =>
            createRlmCall("result", { handle: resolvedHandle }),
          ),
        ),
      ),
      enumerable: true,
    },
    cancel: {
      value: safeFunction((handle) =>
        safeThenable(
          Promise.resolve(handle).then((resolvedHandle) =>
            createRlmCall("cancel", { handle: resolvedHandle }),
          ),
        ),
      ),
      enumerable: true,
    },
  });
  return Object.freeze(rlm);
}

function createFs(root) {
  const fsCapability = Object.create(null);
  Object.defineProperty(fsCapability, "read", {
    value: safeFunction((selector) => readFile(root, selector)),
    enumerable: true,
  });
  return Object.freeze(fsCapability);
}

function readFile(root, selector) {
  if (typeof selector !== "string") {
    throw new TypeError("ctx.fs.read() selector must be a string");
  }

  const match = /^(\.\/[^:\r\n]+?)(?::([1-9]\d*)(?:-([1-9]\d*))?)?$/.exec(selector);
  if (!match) {
    throw new Error(
      "ctx.fs.read() selector must be ./file or ./file:start[-end] with positive line numbers",
    );
  }
  const relativePath = match[1].slice(2);
  const start = match[2] === undefined ? undefined : Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (
    (start !== undefined && !Number.isSafeInteger(start)) ||
    (end !== undefined && !Number.isSafeInteger(end)) ||
    (start !== undefined && end !== undefined && end < start)
  ) {
    throw new Error("ctx.fs.read() line range must use positive safe integers in ascending order");
  }

  const requestedPath = resolve(root, relativePath);
  if (!isInside(root, requestedPath)) {
    throw new Error("ctx.fs.read() path is outside the working directory");
  }
  const descriptor = openSync(requestedPath, "r");
  try {
    const actualPath = realpathSync(requestedPath);
    if (!isInside(root, actualPath)) {
      throw new Error("ctx.fs.read() path is outside the working directory");
    }
    const openedFile = fstatSync(descriptor);
    const resolvedFile = statSync(actualPath);
    if (openedFile.dev !== resolvedFile.dev || openedFile.ino !== resolvedFile.ino) {
      throw new Error("ctx.fs.read() path changed while it was being opened");
    }

    const contents = readFileSync(descriptor, "utf8");
    if (start === undefined) return contents;
    return contents
      .split(/\r?\n/)
      .slice(start - 1, end)
      .join("\n");
  } finally {
    closeSync(descriptor);
  }
}

function isInside(root, candidate) {
  const pathRelation = relative(root, candidate);
  return (
    pathRelation === "" ||
    (pathRelation !== ".." && !pathRelation.startsWith(`..${sep}`) && !isAbsolute(pathRelation))
  );
}

function initialize(message) {
  if (runtimeContext) throw new Error("Runtime is already initialized");
  if (typeof message.context !== "string") throw new TypeError("context must be a string");
  if (typeof message.rootDirectory !== "string" || !isAbsolute(message.rootDirectory)) {
    throw new TypeError("rootDirectory must be an absolute path");
  }
  if (!Number.isSafeInteger(message.maxOutputChars) || message.maxOutputChars <= 0) {
    throw new TypeError("maxOutputChars must be a positive integer");
  }
  if (!Number.isSafeInteger(message.heartbeatIntervalMs) || message.heartbeatIntervalMs <= 0) {
    throw new TypeError("heartbeatIntervalMs must be a positive integer");
  }
  rootDirectory = realpathSync(message.rootDirectory);
  maxOutputChars = message.maxOutputChars;
  heartbeatIntervalMs = message.heartbeatIntervalMs;

  const consoleCapability = Object.create(null);
  Object.defineProperties(consoleCapability, {
    log: { value: safeFunction((...values) => appendOutput("log", values)), enumerable: true },
    error: {
      value: safeFunction((...values) => appendOutput("error", values)),
      enumerable: true,
    },
  });
  Object.freeze(consoleCapability);

  const ctx = Object.create(null);
  Object.defineProperties(ctx, {
    context: { value: message.context, enumerable: true },
    rlm: { value: createRlm(), enumerable: true },
    console: { value: consoleCapability, enumerable: true },
    fs: { value: createFs(rootDirectory), enumerable: true },
  });
  Object.freeze(ctx);

  const sandbox = Object.create(null);
  Object.defineProperties(sandbox, {
    ctx: { value: ctx, enumerable: true },
    context: { value: undefined },
    rlm: { value: undefined },
    console: { value: undefined },
  });
  runtimeContext = vm.createContext(sandbox, {
    name: "coder-rlm",
    codeGeneration: { strings: false, wasm: false },
  });

  replServer = new repl.REPLServer({
    input: new PassThrough(),
    output: new PassThrough(),
    terminal: false,
    useGlobal: false,
    ignoreUndefined: true,
  });
  send({ type: "ready" });
  startHeartbeats();
}

function execute(message) {
  if (!runtimeContext || !replServer) throw new Error("Runtime is not initialized");
  if (typeof message.code !== "string") throw new TypeError("code must be a string");
  if (activeOutput) throw new Error("Concurrent execution is not supported");

  activeOutput = { lines: [], length: 0, truncated: false };
  let finished = false;
  activeExecutionRequestId = message.requestId;
  const finish = (error, value) => {
    if (finished) return;
    finished = true;
    activeExecutionRequestId = undefined;
    replServer._domain.removeListener("error", onDomainError);
    const output = outputText(error ? undefined : value);
    activeOutput = undefined;
    if (error) {
      send({
        type: "executionResult",
        requestId: message.requestId,
        output,
        error: {
          name: error.name || "Error",
          message: error.message || String(error),
        },
      });
      return;
    }
    send({ type: "executionResult", requestId: message.requestId, output });
  };
  // REPL binds evaluation to an internal domain and reports runtime/rejected-await
  // failures there instead of invoking its callback. Capture that path so a normal
  // generated-code exception remains a recoverable tool result.
  const onDomainError = (error) => finish(error);
  replServer._domain.prependOnceListener("error", onDomainError);
  replServer.eval(message.code, runtimeContext, "coder-rlm", finish);
}

function settleRlm(message) {
  const pending = pendingRlmCalls.get(message.callId);
  if (!pending) return;
  pendingRlmCalls.delete(message.callId);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.result);
}

input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === "init") initialize(message);
    else if (message.type === "execute") execute(message);
    else if (message.type === "rlmResult") settleRlm(message);
    else throw new Error(`Unknown message type: ${String(message.type)}`);
  } catch (error) {
    send({
      type: "fatal",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
});
