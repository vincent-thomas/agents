import repl from "node:repl";
import vm from "node:vm";
import { PassThrough } from "node:stream";
import { formatWithOptions } from "node:util";
import { createInterface } from "node:readline";
import { register } from "node:module";

const denyImportsSource = encodeURIComponent(
  'export async function resolve(specifier) { throw new Error("Dynamic import is disabled: " + specifier); }',
);
register(`data:text/javascript,${denyImportsSource}`, import.meta.url);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

let runtimeContext;
let replServer;
let maxOutputChars = 50_000;
let activeOutput;
let nextLlmCallId = 1;
const pendingLlmCalls = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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

function createLlm() {
  return safeFunction((prompt, childContext) => {
    if (typeof prompt !== "string") throw new TypeError("llm() prompt must be a string");
    if (childContext !== undefined && typeof childContext !== "string") {
      throw new TypeError("llm() context must be a string when provided");
    }

    const callId = nextLlmCallId++;
    const promise = new Promise((resolve, reject) => {
      pendingLlmCalls.set(callId, { resolve, reject });
      send({ type: "llm", callId, prompt, context: childContext });
    });
    return safeThenable(promise);
  });
}

function initialize(message) {
  if (runtimeContext) throw new Error("Runtime is already initialized");
  if (typeof message.context !== "string") throw new TypeError("context must be a string");
  if (!Number.isSafeInteger(message.maxOutputChars) || message.maxOutputChars <= 0) {
    throw new TypeError("maxOutputChars must be a positive integer");
  }
  maxOutputChars = message.maxOutputChars;

  const consoleCapability = Object.create(null);
  Object.defineProperties(consoleCapability, {
    log: { value: safeFunction((...values) => appendOutput("log", values)), enumerable: true },
    error: {
      value: safeFunction((...values) => appendOutput("error", values)),
      enumerable: true,
    },
  });
  Object.freeze(consoleCapability);

  const sandbox = Object.create(null);
  Object.defineProperties(sandbox, {
    context: { value: message.context, enumerable: true },
    llm: { value: createLlm(), enumerable: true },
    console: { value: consoleCapability, enumerable: true },
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
}

function execute(message) {
  if (!runtimeContext || !replServer) throw new Error("Runtime is not initialized");
  if (typeof message.code !== "string") throw new TypeError("code must be a string");
  if (activeOutput) throw new Error("Concurrent execution is not supported");

  activeOutput = { lines: [], length: 0, truncated: false };
  let finished = false;
  const finish = (error, value) => {
    if (finished) return;
    finished = true;
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

function settleLlm(message) {
  const pending = pendingLlmCalls.get(message.callId);
  if (!pending) return;
  pendingLlmCalls.delete(message.callId);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.result);
}

input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === "init") initialize(message);
    else if (message.type === "execute") execute(message);
    else if (message.type === "llmResult") settleLlm(message);
    else throw new Error(`Unknown message type: ${String(message.type)}`);
  } catch (error) {
    send({
      type: "fatal",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
});
