function __cf_cjs(esm) {
  const cjs = 'default' in esm ? esm.default : {};
	for (const [k, v] of Object.entries(esm)) {
		if (k !== 'default') {
			Object.defineProperty(cjs, k, {
				enumerable: true,
				value: v,
			});
		}
	}
	return cjs;
}
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};

// ../../home/user/node_modules/wrangler/_virtual_unenv_global_polyfill-clear$immediate.js
globalThis.clearImmediate = clearImmediateFallback;

// ../../home/user/node_modules/unenv/runtime/_internal/utils.mjs
function createNotImplementedError(name) {
  return new Error(`[unenv] ${name} is not implemented yet!`);
}
__name(createNotImplementedError, "createNotImplementedError");
function notImplemented(name) {
  const fn2 = /* @__PURE__ */ __name(() => {
    throw createNotImplementedError(name);
  }, "fn");
  return Object.assign(fn2, { __unenv__: true });
}
__name(notImplemented, "notImplemented");

// ../../home/user/node_modules/unenv/runtime/mock/noop.mjs
var noop_default = Object.assign(() => {
}, { __unenv__: true });

// ../../home/user/node_modules/unenv/runtime/node/timers/internal/immediate.mjs
var Immediate = class {
  _onImmediate;
  _timeout;
  constructor(callback, args) {
    this._onImmediate = callback;
    if ("setTimeout" in globalThis) {
      this._timeout = setTimeout(callback, 0, ...args);
    } else {
      callback(...args);
    }
  }
  ref() {
    this._timeout?.ref();
    return this;
  }
  unref() {
    this._timeout?.unref();
    return this;
  }
  hasRef() {
    return this._timeout?.hasRef() ?? false;
  }
  [Symbol.dispose]() {
    if ("clearTimeout" in globalThis) {
      clearTimeout(this._timeout);
    }
  }
};
__name(Immediate, "Immediate");

// ../../home/user/node_modules/unenv/runtime/node/timers/internal/set-immediate.mjs
function setImmediateFallbackPromises(value) {
  return new Promise((res) => {
    res(value);
  });
}
__name(setImmediateFallbackPromises, "setImmediateFallbackPromises");
function setImmediateFallback(callback, ...args) {
  return new Immediate(callback, args);
}
__name(setImmediateFallback, "setImmediateFallback");
setImmediateFallback.__promisify__ = setImmediateFallbackPromises;
function clearImmediateFallback(immediate) {
  immediate?.[Symbol.dispose]();
}
__name(clearImmediateFallback, "clearImmediateFallback");

// ../../home/user/node_modules/wrangler/_virtual_unenv_global_polyfill-set$immediate.js
globalThis.setImmediate = setImmediateFallback;

// ../../home/user/node_modules/unenv/runtime/node/console/index.mjs
import { Writable } from "node:stream";

// ../../home/user/node_modules/unenv/runtime/mock/proxy.mjs
var fn = /* @__PURE__ */ __name(function() {
}, "fn");
function createMock(name, overrides = {}) {
  fn.prototype.name = name;
  const props = {};
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "caller") {
        return null;
      }
      if (prop === "__createMock__") {
        return createMock;
      }
      if (prop === "__unenv__") {
        return true;
      }
      if (prop in overrides) {
        return overrides[prop];
      }
      return props[prop] = props[prop] || createMock(`${name}.${prop.toString()}`);
    },
    apply(_target, _this, _args) {
      return createMock(`${name}()`);
    },
    construct(_target, _args, _newT) {
      return createMock(`[${name}]`);
    },
    // @ts-ignore (ES6-only - removed in ES7)
    // https://github.com/tc39/ecma262/issues/161
    enumerate() {
      return [];
    }
  });
}
__name(createMock, "createMock");
var proxy_default = createMock("mock");

// ../../home/user/node_modules/unenv/runtime/node/console/index.mjs
var _console = globalThis.console;
var _ignoreErrors = true;
var _stderr = new Writable();
var _stdout = new Writable();
var log = _console?.log ?? noop_default;
var info = _console?.info ?? log;
var trace = _console?.trace ?? info;
var debug = _console?.debug ?? log;
var table = _console?.table ?? log;
var error = _console?.error ?? log;
var warn = _console?.warn ?? error;
var createTask = _console?.createTask ?? notImplemented("console.createTask");
var assert = notImplemented("console.assert");
var clear = _console?.clear ?? noop_default;
var count = _console?.count ?? noop_default;
var countReset = _console?.countReset ?? noop_default;
var dir = _console?.dir ?? noop_default;
var dirxml = _console?.dirxml ?? noop_default;
var group = _console?.group ?? noop_default;
var groupEnd = _console?.groupEnd ?? noop_default;
var groupCollapsed = _console?.groupCollapsed ?? noop_default;
var profile = _console?.profile ?? noop_default;
var profileEnd = _console?.profileEnd ?? noop_default;
var time = _console?.time ?? noop_default;
var timeEnd = _console?.timeEnd ?? noop_default;
var timeLog = _console?.timeLog ?? noop_default;
var timeStamp = _console?.timeStamp ?? noop_default;
var Console = _console?.Console ?? proxy_default.__createMock__("console.Console");

// ../../home/user/node_modules/unenv/runtime/node/console/$cloudflare.mjs
var workerdConsole = globalThis["console"];
var {
  assert: assert2,
  clear: clear2,
  // @ts-expect-error undocumented public API
  context,
  count: count2,
  countReset: countReset2,
  // @ts-expect-error undocumented public API
  createTask: createTask2,
  debug: debug2,
  dir: dir2,
  dirxml: dirxml2,
  error: error2,
  group: group2,
  groupCollapsed: groupCollapsed2,
  groupEnd: groupEnd2,
  info: info2,
  log: log2,
  profile: profile2,
  profileEnd: profileEnd2,
  table: table2,
  time: time2,
  timeEnd: timeEnd2,
  timeLog: timeLog2,
  timeStamp: timeStamp2,
  trace: trace2,
  warn: warn2
} = workerdConsole;
Object.assign(workerdConsole, {
  Console,
  _ignoreErrors,
  _stderr,
  _stderrErrorHandler: noop_default,
  _stdout,
  _stdoutErrorHandler: noop_default,
  _times: proxy_default
});
var cloudflare_default = workerdConsole;

// ../../home/user/node_modules/wrangler/_virtual_unenv_global_polyfill-console.js
globalThis.console = cloudflare_default;

// ../../home/user/node_modules/unenv/runtime/web/performance/_entry.mjs
var _supportedEntryTypes = [
  "event",
  // PerformanceEntry
  "mark",
  // PerformanceMark
  "measure",
  // PerformanceMeasure
  "resource"
  // PerformanceResourceTiming
];
var _PerformanceEntry = class {
  __unenv__ = true;
  detail;
  entryType = "event";
  name;
  startTime;
  constructor(name, options) {
    this.name = name;
    this.startTime = options?.startTime || performance.now();
    this.detail = options?.detail;
  }
  get duration() {
    return performance.now() - this.startTime;
  }
  toJSON() {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail
    };
  }
};
__name(_PerformanceEntry, "_PerformanceEntry");
var PerformanceEntry = globalThis.PerformanceEntry || _PerformanceEntry;
var _PerformanceMark = class extends _PerformanceEntry {
  entryType = "mark";
};
__name(_PerformanceMark, "_PerformanceMark");
var PerformanceMark = globalThis.PerformanceMark || _PerformanceMark;
var _PerformanceMeasure = class extends _PerformanceEntry {
  entryType = "measure";
};
__name(_PerformanceMeasure, "_PerformanceMeasure");
var PerformanceMeasure = globalThis.PerformanceMeasure || _PerformanceMeasure;
var _PerformanceResourceTiming = class extends _PerformanceEntry {
  entryType = "resource";
  serverTiming = [];
  connectEnd = 0;
  connectStart = 0;
  decodedBodySize = 0;
  domainLookupEnd = 0;
  domainLookupStart = 0;
  encodedBodySize = 0;
  fetchStart = 0;
  initiatorType = "";
  name = "";
  nextHopProtocol = "";
  redirectEnd = 0;
  redirectStart = 0;
  requestStart = 0;
  responseEnd = 0;
  responseStart = 0;
  secureConnectionStart = 0;
  startTime = 0;
  transferSize = 0;
  workerStart = 0;
};
__name(_PerformanceResourceTiming, "_PerformanceResourceTiming");
var PerformanceResourceTiming = globalThis.PerformanceResourceTiming || _PerformanceResourceTiming;

// ../../home/user/node_modules/unenv/runtime/web/performance/_performance.mjs
var _timeOrigin = Date.now();
var _Performance = class {
  __unenv__ = true;
  timeOrigin = _timeOrigin;
  eventCounts = /* @__PURE__ */ new Map();
  _entries = [];
  _resourceTimingBufferSize = 0;
  navigation = proxy_default.__createMock__("PerformanceNavigation");
  timing = proxy_default.__createMock__("PerformanceTiming");
  onresourcetimingbufferfull = null;
  now() {
    if (globalThis?.performance?.now && this.timeOrigin === _timeOrigin) {
      return globalThis.performance.now();
    }
    return Date.now() - this.timeOrigin;
  }
  clearMarks(markName) {
    this._entries = markName ? this._entries.filter((e) => e.name !== markName) : this._entries.filter((e) => e.entryType !== "mark");
  }
  clearMeasures(measureName) {
    this._entries = measureName ? this._entries.filter((e) => e.name !== measureName) : this._entries.filter((e) => e.entryType !== "measure");
  }
  clearResourceTimings() {
    this._entries = this._entries.filter(
      (e) => e.entryType !== "resource" || e.entryType !== "navigation"
    );
  }
  getEntries() {
    return this._entries;
  }
  getEntriesByName(name, type) {
    return this._entries.filter(
      (e) => e.name === name && (!type || e.entryType === type)
    );
  }
  getEntriesByType(type) {
    return this._entries.filter(
      (e) => e.entryType === type
    );
  }
  mark(name, options) {
    const entry = new _PerformanceMark(name, options);
    this._entries.push(entry);
    return entry;
  }
  measure(measureName, startOrMeasureOptions, endMark) {
    let start;
    let end;
    if (typeof startOrMeasureOptions === "string") {
      start = this.getEntriesByName(startOrMeasureOptions, "mark")[0]?.startTime;
      end = this.getEntriesByName(endMark, "mark")[0]?.startTime;
    } else {
      start = Number.parseFloat(startOrMeasureOptions?.start) || performance2.now();
      end = Number.parseFloat(startOrMeasureOptions?.end) || performance2.now();
    }
    const entry = new _PerformanceMeasure(measureName, {
      startTime: start,
      detail: { start, end }
    });
    this._entries.push(entry);
    return entry;
  }
  setResourceTimingBufferSize(maxSize) {
    this._resourceTimingBufferSize = maxSize;
  }
  toJSON() {
    return this;
  }
  addEventListener(type, listener, options) {
    throw createNotImplementedError("Performance.addEventListener");
  }
  removeEventListener(type, listener, options) {
    throw createNotImplementedError("Performance.removeEventListener");
  }
  dispatchEvent(event) {
    throw createNotImplementedError("Performance.dispatchEvent");
  }
};
__name(_Performance, "_Performance");
var Performance = globalThis.Performance || _Performance;
var performance2 = globalThis.performance || new Performance();

// ../../home/user/node_modules/unenv/runtime/web/performance/_observer.mjs
var _PerformanceObserver = class {
  __unenv__ = true;
  _callback = null;
  constructor(callback) {
    this._callback = callback;
  }
  takeRecords() {
    return [];
  }
  disconnect() {
    throw createNotImplementedError("PerformanceObserver.disconnect");
  }
  observe(options) {
    throw createNotImplementedError("PerformanceObserver.observe");
  }
};
__name(_PerformanceObserver, "_PerformanceObserver");
__publicField(_PerformanceObserver, "supportedEntryTypes", _supportedEntryTypes);
var PerformanceObserver = globalThis.PerformanceObserver || _PerformanceObserver;
var _PerformanceObserverEntryList = class {
  __unenv__ = true;
  getEntries() {
    return [];
  }
  getEntriesByName(_name, _type) {
    return [];
  }
  getEntriesByType(type) {
    return [];
  }
};
__name(_PerformanceObserverEntryList, "_PerformanceObserverEntryList");
var PerformanceObserverEntryList = globalThis.PerformanceObserverEntryList || _PerformanceObserverEntryList;

// ../../home/user/node_modules/unenv/runtime/polyfill/global-this.mjs
function getGlobal() {
  if (typeof globalThis !== "undefined") {
    return globalThis;
  }
  if (typeof self !== "undefined") {
    return self;
  }
  if (typeof window !== "undefined") {
    return window;
  }
  if (typeof global !== "undefined") {
    return global;
  }
  return {};
}
__name(getGlobal, "getGlobal");
var global_this_default = getGlobal();

// ../../home/user/node_modules/unenv/runtime/polyfill/performance.mjs
global_this_default.performance = global_this_default.performance || performance2;
global_this_default.Performance = global_this_default.Performance || Performance;
global_this_default.PerformanceEntry = global_this_default.PerformanceEntry || PerformanceEntry;
global_this_default.PerformanceMark = global_this_default.PerformanceMark || PerformanceMark;
global_this_default.PerformanceMeasure = global_this_default.PerformanceMeasure || PerformanceMeasure;
global_this_default.PerformanceObserver = global_this_default.PerformanceObserver || PerformanceObserver;
global_this_default.PerformanceObserverEntryList = global_this_default.PerformanceObserverEntryList || PerformanceObserverEntryList;
global_this_default.PerformanceResourceTiming = global_this_default.PerformanceResourceTiming || PerformanceResourceTiming;
var performance_default = global_this_default.performance;

// ../../home/user/node_modules/wrangler/_virtual_unenv_global_polyfill-performance.js
globalThis.performance = performance_default;

// ../../home/user/node_modules/unenv/runtime/mock/empty.mjs
var empty_default = Object.freeze(
  Object.create(null, {
    __unenv__: { get: () => true }
  })
);

// ../../home/user/node_modules/unenv/runtime/node/process/internal/env.mjs
var _envShim = /* @__PURE__ */ Object.create(null);
var _processEnv = globalThis.process?.env;
var _getEnv = /* @__PURE__ */ __name((useShim) => _processEnv || globalThis.__env__ || (useShim ? _envShim : globalThis), "_getEnv");
var env = new Proxy(_envShim, {
  get(_, prop) {
    const env22 = _getEnv();
    return env22[prop] ?? _envShim[prop];
  },
  has(_, prop) {
    const env22 = _getEnv();
    return prop in env22 || prop in _envShim;
  },
  set(_, prop, value) {
    const env22 = _getEnv(true);
    env22[prop] = value;
    return true;
  },
  deleteProperty(_, prop) {
    const env22 = _getEnv(true);
    delete env22[prop];
    return true;
  },
  ownKeys() {
    const env22 = _getEnv();
    return Object.keys(env22);
  }
});

// ../../home/user/node_modules/unenv/runtime/node/process/internal/time.mjs
var hrtime = Object.assign(
  /* @__PURE__ */ __name(function hrtime2(startTime) {
    const now = Date.now();
    const seconds = Math.trunc(now / 1e3);
    const nanos = now % 1e3 * 1e6;
    if (startTime) {
      let diffSeconds = seconds - startTime[0];
      let diffNanos = nanos - startTime[0];
      if (diffNanos < 0) {
        diffSeconds = diffSeconds - 1;
        diffNanos = 1e9 + diffNanos;
      }
      return [diffSeconds, diffNanos];
    }
    return [seconds, nanos];
  }, "hrtime2"),
  {
    bigint: /* @__PURE__ */ __name(function bigint() {
      return BigInt(Date.now() * 1e6);
    }, "bigint")
  }
);
var nextTick = globalThis.queueMicrotask ? (cb, ...args) => {
  globalThis.queueMicrotask(cb.bind(void 0, ...args));
} : _createNextTickWithTimeout();
function _createNextTickWithTimeout() {
  let queue = [];
  let draining = false;
  let currentQueue;
  let queueIndex = -1;
  function cleanUpNextTick() {
    if (!draining || !currentQueue) {
      return;
    }
    draining = false;
    if (currentQueue.length > 0) {
      queue = [...currentQueue, ...queue];
    } else {
      queueIndex = -1;
    }
    if (queue.length > 0) {
      drainQueue();
    }
  }
  __name(cleanUpNextTick, "cleanUpNextTick");
  function drainQueue() {
    if (draining) {
      return;
    }
    const timeout = setTimeout(cleanUpNextTick);
    draining = true;
    let len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex]();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = void 0;
    draining = false;
    clearTimeout(timeout);
  }
  __name(drainQueue, "drainQueue");
  const nextTick22 = /* @__PURE__ */ __name((cb, ...args) => {
    queue.push(cb.bind(void 0, ...args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue);
    }
  }, "nextTick2");
  return nextTick22;
}
__name(_createNextTickWithTimeout, "_createNextTickWithTimeout");

// ../../home/user/node_modules/unenv/runtime/node/process/internal/process.mjs
var title = "unenv";
var argv = [];
var version = "";
var versions = {
  ares: "",
  http_parser: "",
  icu: "",
  modules: "",
  node: "",
  openssl: "",
  uv: "",
  v8: "",
  zlib: ""
};
function noop() {
  return process;
}
__name(noop, "noop");
var on = noop;
var addListener = noop;
var once = noop;
var off = noop;
var removeListener = noop;
var removeAllListeners = noop;
var emit = /* @__PURE__ */ __name(function emit2(event) {
  if (event === "message" || event === "multipleResolves") {
    return process;
  }
  return false;
}, "emit2");
var prependListener = noop;
var prependOnceListener = noop;
var listeners = /* @__PURE__ */ __name(function(name) {
  return [];
}, "listeners");
var listenerCount = /* @__PURE__ */ __name(() => 0, "listenerCount");
var binding = /* @__PURE__ */ __name(function(name) {
  throw new Error("[unenv] process.binding is not supported");
}, "binding");
var _cwd = "/";
var cwd = /* @__PURE__ */ __name(function cwd2() {
  return _cwd;
}, "cwd2");
var chdir = /* @__PURE__ */ __name(function chdir2(dir3) {
  _cwd = dir3;
}, "chdir2");
var umask = /* @__PURE__ */ __name(function umask2() {
  return 0;
}, "umask2");
var getegid = /* @__PURE__ */ __name(function getegid2() {
  return 1e3;
}, "getegid2");
var geteuid = /* @__PURE__ */ __name(function geteuid2() {
  return 1e3;
}, "geteuid2");
var getgid = /* @__PURE__ */ __name(function getgid2() {
  return 1e3;
}, "getgid2");
var getuid = /* @__PURE__ */ __name(function getuid2() {
  return 1e3;
}, "getuid2");
var getgroups = /* @__PURE__ */ __name(function getgroups2() {
  return [];
}, "getgroups2");
var getBuiltinModule = /* @__PURE__ */ __name((_name) => void 0, "getBuiltinModule");
var abort = notImplemented("process.abort");
var allowedNodeEnvironmentFlags = /* @__PURE__ */ new Set();
var arch = "";
var argv0 = "";
var config = empty_default;
var connected = false;
var constrainedMemory = /* @__PURE__ */ __name(() => 0, "constrainedMemory");
var availableMemory = /* @__PURE__ */ __name(() => 0, "availableMemory");
var cpuUsage = notImplemented("process.cpuUsage");
var debugPort = 0;
var dlopen = notImplemented("process.dlopen");
var disconnect = noop;
var emitWarning = noop;
var eventNames = notImplemented("process.eventNames");
var execArgv = [];
var execPath = "";
var exit = notImplemented("process.exit");
var features = /* @__PURE__ */ Object.create({
  inspector: void 0,
  debug: void 0,
  uv: void 0,
  ipv6: void 0,
  tls_alpn: void 0,
  tls_sni: void 0,
  tls_ocsp: void 0,
  tls: void 0,
  cached_builtins: void 0
});
var getActiveResourcesInfo = /* @__PURE__ */ __name(() => [], "getActiveResourcesInfo");
var getMaxListeners = notImplemented(
  "process.getMaxListeners"
);
var kill = notImplemented("process.kill");
var memoryUsage = Object.assign(
  () => ({
    arrayBuffers: 0,
    rss: 0,
    external: 0,
    heapTotal: 0,
    heapUsed: 0
  }),
  { rss: () => 0 }
);
var pid = 1e3;
var platform = "";
var ppid = 1e3;
var rawListeners = notImplemented(
  "process.rawListeners"
);
var release = /* @__PURE__ */ Object.create({
  name: "",
  lts: "",
  sourceUrl: void 0,
  headersUrl: void 0
});
var report = /* @__PURE__ */ Object.create({
  compact: void 0,
  directory: void 0,
  filename: void 0,
  getReport: notImplemented("process.report.getReport"),
  reportOnFatalError: void 0,
  reportOnSignal: void 0,
  reportOnUncaughtException: void 0,
  signal: void 0,
  writeReport: notImplemented("process.report.writeReport")
});
var resourceUsage = notImplemented(
  "process.resourceUsage"
);
var setegid = notImplemented("process.setegid");
var seteuid = notImplemented("process.seteuid");
var setgid = notImplemented("process.setgid");
var setgroups = notImplemented("process.setgroups");
var setuid = notImplemented("process.setuid");
var setMaxListeners = notImplemented(
  "process.setMaxListeners"
);
var setSourceMapsEnabled = notImplemented("process.setSourceMapsEnabled");
var stdout = proxy_default.__createMock__("process.stdout");
var stderr = proxy_default.__createMock__("process.stderr");
var stdin = proxy_default.__createMock__("process.stdin");
var traceDeprecation = false;
var uptime = /* @__PURE__ */ __name(() => 0, "uptime");
var exitCode = 0;
var setUncaughtExceptionCaptureCallback = notImplemented("process.setUncaughtExceptionCaptureCallback");
var hasUncaughtExceptionCaptureCallback = /* @__PURE__ */ __name(() => false, "hasUncaughtExceptionCaptureCallback");
var sourceMapsEnabled = false;
var loadEnvFile = notImplemented(
  "process.loadEnvFile"
);
var mainModule = void 0;
var permission = {
  has: () => false
};
var channel = {
  ref() {
  },
  unref() {
  }
};
var throwDeprecation = false;
var assert3 = notImplemented("process.assert");
var openStdin = notImplemented("process.openStdin");
var _debugEnd = notImplemented("process._debugEnd");
var _debugProcess = notImplemented("process._debugProcess");
var _fatalException = notImplemented("process._fatalException");
var _getActiveHandles = notImplemented("process._getActiveHandles");
var _getActiveRequests = notImplemented("process._getActiveRequests");
var _kill = notImplemented("process._kill");
var _preload_modules = [];
var _rawDebug = notImplemented("process._rawDebug");
var _startProfilerIdleNotifier = notImplemented(
  "process._startProfilerIdleNotifier"
);
var _stopProfilerIdleNotifier = notImplemented(
  "process.__stopProfilerIdleNotifier"
);
var _tickCallback = notImplemented("process._tickCallback");
var _linkedBinding = notImplemented("process._linkedBinding");
var domain = proxy_default.__createMock__("process.domain");
var initgroups = notImplemented("process.initgroups");
var moduleLoadList = [];
var reallyExit = noop;
var _exiting = false;
var _events = [];
var _eventsCount = 0;
var _maxListeners = 0;
var process = {
  // @ts-expect-error
  _events,
  _eventsCount,
  _exiting,
  _maxListeners,
  _debugEnd,
  _debugProcess,
  _fatalException,
  _getActiveHandles,
  _getActiveRequests,
  _kill,
  _preload_modules,
  _rawDebug,
  _startProfilerIdleNotifier,
  _stopProfilerIdleNotifier,
  _tickCallback,
  domain,
  initgroups,
  moduleLoadList,
  reallyExit,
  exitCode,
  abort,
  addListener,
  allowedNodeEnvironmentFlags,
  hasUncaughtExceptionCaptureCallback,
  setUncaughtExceptionCaptureCallback,
  loadEnvFile,
  sourceMapsEnabled,
  throwDeprecation,
  mainModule,
  permission,
  channel,
  arch,
  argv,
  argv0,
  assert: assert3,
  binding,
  chdir,
  config,
  connected,
  constrainedMemory,
  availableMemory,
  cpuUsage,
  cwd,
  debugPort,
  dlopen,
  disconnect,
  emit,
  emitWarning,
  env,
  eventNames,
  execArgv,
  execPath,
  exit,
  features,
  getBuiltinModule,
  getegid,
  geteuid,
  getgid,
  getgroups,
  getuid,
  getActiveResourcesInfo,
  getMaxListeners,
  hrtime,
  kill,
  listeners,
  listenerCount,
  memoryUsage,
  nextTick,
  on,
  off,
  once,
  openStdin,
  pid,
  platform,
  ppid,
  prependListener,
  prependOnceListener,
  rawListeners,
  release,
  removeAllListeners,
  removeListener,
  report,
  resourceUsage,
  setegid,
  seteuid,
  setgid,
  setgroups,
  setuid,
  setMaxListeners,
  setSourceMapsEnabled,
  stderr,
  stdin,
  stdout,
  title,
  traceDeprecation,
  umask,
  uptime,
  version,
  versions
};

// ../../home/user/node_modules/unenv/runtime/node/process/$cloudflare.mjs
var unpatchedGlobalThisProcess = globalThis["process"];
var getBuiltinModule2 = unpatchedGlobalThisProcess.getBuiltinModule;
var workerdProcess = getBuiltinModule2("node:process");
var { env: env2, exit: exit2, nextTick: nextTick2, platform: platform2 } = workerdProcess;
var _process = {
  /**
   * manually unroll unenv-polyfilled-symbols to make it tree-shakeable
   */
  // @ts-expect-error (not typed)
  _debugEnd,
  _debugProcess,
  _events,
  _eventsCount,
  _exiting,
  _fatalException,
  _getActiveHandles,
  _getActiveRequests,
  _kill,
  _linkedBinding,
  _maxListeners,
  _preload_modules,
  _rawDebug,
  _startProfilerIdleNotifier,
  _stopProfilerIdleNotifier,
  _tickCallback,
  abort,
  addListener,
  allowedNodeEnvironmentFlags,
  arch,
  argv,
  argv0,
  assert: assert3,
  availableMemory,
  binding,
  chdir,
  config,
  constrainedMemory,
  cpuUsage,
  cwd,
  debugPort,
  dlopen,
  domain,
  emit,
  emitWarning,
  eventNames,
  execArgv,
  execPath,
  exit: exit2,
  exitCode,
  features,
  getActiveResourcesInfo,
  getMaxListeners,
  getegid,
  geteuid,
  getgid,
  getgroups,
  getuid,
  hasUncaughtExceptionCaptureCallback,
  hrtime,
  initgroups,
  kill,
  listenerCount,
  listeners,
  loadEnvFile,
  memoryUsage,
  moduleLoadList,
  off,
  on,
  once,
  openStdin,
  pid,
  platform: platform2,
  ppid,
  prependListener,
  prependOnceListener,
  rawListeners,
  reallyExit,
  release,
  removeAllListeners,
  removeListener,
  report,
  resourceUsage,
  setMaxListeners,
  setSourceMapsEnabled,
  setUncaughtExceptionCaptureCallback,
  setegid,
  seteuid,
  setgid,
  setgroups,
  setuid,
  sourceMapsEnabled,
  stderr,
  stdin,
  stdout,
  title,
  umask,
  uptime,
  version,
  versions,
  /**
   * manually unroll workerd-polyfilled-symbols to make it tree-shakeable
   */
  env: env2,
  getBuiltinModule: getBuiltinModule2,
  nextTick: nextTick2
};
var cloudflare_default2 = _process;

// ../../home/user/node_modules/wrangler/_virtual_unenv_global_polyfill-process.js
globalThis.process = cloudflare_default2;

// src/index.js
var APP = "whalechat";
var VERSION = "3.63.0";
var DO_NAME = "global:v12";
var PREV_DO_NAME = "global:v11";
var BUILD = "2026-11-23T04:10:00Z";
var COLLECTIONS = ["users", "vendors", "companyProducts", "products", "orders", "deposits", "withdrawals", "messages", "statuses", "notifications", "contacts", "blocks", "txs", "referrals", "purchases", "refunds", "vendorApplications", "reports", "bonuses", "bonusClaims", "emailCampaigns", "stocks", "holdings", "trades", "watchlist", "alerts", "audit", "portfolioAudit", "botAccounts", "botEvents", "traffic", "shareInvestments", "serviceRequests"];
var PRESENCE_STALE_MS = 35e3;
var CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400"
};
var json = /* @__PURE__ */ __name((data, code = 200) => new Response(JSON.stringify(data), {
  status: code,
  headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, CORS)
}), "json");
var frameOf = /* @__PURE__ */ __name((event, data) => `event: ${event}
data: ${JSON.stringify(data)}

`, "frameOf");
var enc = new TextEncoder();
var dec = new TextDecoder();
var b64u = /* @__PURE__ */ __name((buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++)
    s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}, "b64u");
var unb64u = /* @__PURE__ */ __name((str) => {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const raw = atob(s + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++)
    out[i] = raw.charCodeAt(i);
  return out;
}, "unb64u");
var concat = /* @__PURE__ */ __name((...parts) => {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}, "concat");
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
__name(hmac, "hmac");
async function hkdfExpand(prk, info3, len) {
  const blocks = [];
  let t = new Uint8Array(0);
  for (let i = 1; i <= 255; i++) {
    t = await hmac(prk, concat(t, info3, new Uint8Array([i])));
    blocks.push(t);
    if (blocks.reduce((a, b) => a + b.length, 0) >= len)
      break;
  }
  return concat(...blocks).slice(0, len);
}
__name(hkdfExpand, "hkdfExpand");
function previewText(m) {
  if (!m)
    return "New message";
  if (m.type === "image")
    return "\u{1F4F7} Photo";
  if (m.type === "video")
    return "\u{1F3A5} Video";
  if (m.type === "voice" || m.type === "audio")
    return "\u{1F3A4} Voice note";
  return String(m.text || "").slice(0, 140) || "New message";
}
__name(previewText, "previewText");
function yahooSymbol(asset) {
  if (!asset)
    return "";
  const ticker = String(asset.ticker || asset.displayTicker || "").toUpperCase();
  const display = String(asset.displayTicker || asset.finnhubSymbol || asset.ticker || "").toUpperCase();
  const cls = String(asset.assetClass || "").toLowerCase();
  if (cls === "crypto" || /USDT$/.test(ticker)) {
    if (/USDT$/.test(ticker))
      return ticker.slice(0, -4) + "-USD";
    if (/USD$/.test(ticker))
      return ticker.slice(0, -3) + "-USD";
    return ticker;
  }
  if (cls === "forex" || /^[A-Z]{6}$/.test(ticker) && /USD$/.test(ticker)) {
    if (ticker === "XAUUSD")
      return "GC=F";
    if (ticker === "XAGUSD")
      return "SI=F";
    return ticker + "=X";
  }
  const clean = display.replace(/^[A-Z]+:/, "");
  const m = /\.([A-Z]{1,3})$/.exec(clean);
  if (m && ["L", "DE", "T", "TO", "AX", "PA", "AS", "MI", "MC", "SW", "SI", "HK", "KS", "TW", "NS", "BO", "SA", "F", "V"].includes(m[1]))
    return clean;
  return clean.replace(/\./g, "-");
}
__name(yahooSymbol, "yahooSymbol");
/* =========================================================================
   Email delivery — Brevo Transactional API over HTTPS only.
   -------------------------------------------------------------------------
   There is no SMTP socket and no "sync server" mail transport to keep alive.
   A Cloudflare Worker never holds a long-lived connection, so a deploy, an
   idle hour or a cold start can never disconnect email again.
   ========================================================================= */
function maskEmailAddr(e) {
  return String(e || "").replace(/^(.{2}).*(@.*)$/, "$1***$2");
}
function emailCodeHtml(code) {
  return `<div style="background:#04101a;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#0b1723;border:1px solid #16303f;border-radius:18px;overflow:hidden">
      <div style="padding:22px 24px;background:linear-gradient(135deg,#0f766e,#0b3d5c)">
        <div style="font-size:12px;letter-spacing:.18em;color:#9fe9dd;font-weight:700">WHALECHAT</div>
        <h1 style="margin:8px 0 0;font-size:23px;color:#eaf6fb">Your verification code</h1>
      </div>
      <div style="padding:24px;color:#c7d8e2;font-size:14.5px;line-height:1.7">
        <p style="margin:0 0 6px">Enter this code to verify your WhaleChat account. It expires in 10 minutes.</p>
        <div style="margin:20px 0;text-align:center">
          <div style="display:inline-block;font-family:Menlo,Consolas,monospace;font-size:32px;letter-spacing:9px;font-weight:800;color:#eaf6fb;background:#04101a;border:1px dashed #2ee6c9;border-radius:12px;padding:14px 22px;user-select:all;-webkit-user-select:all">${code}</div>
        </div>
        <p style="font-size:12px;color:#63808f;margin:12px 0 0">If you did not request this, ignore this email and never share the code.</p>
      </div>
    </div>
  </div>`;
}
function brevoSender(env3) {
  return {
    email: String(env3.BREVO_SENDER_EMAIL || env3.BREVO_FROM || env3.MAIL_FROM || "whalechat1@gmail.com"),
    name: String(env3.BREVO_SENDER_NAME || env3.BREVO_FROM_NAME || env3.MAIL_FROM_NAME || "WhaleChat")
  };
}
async function brevoSendCode(env3, email, code, apiKey, senderOverride) {
  /* the key/sender saved in Admin → Servers & API win over the Worker secret */
  const apiKey2 = String(apiKey || env3.BREVO_API_KEY || "");
  if (!apiKey2)
    return { ok: false, error: "email_not_configured" };
  const payload = {
    sender: senderOverride || brevoSender(env3),
    to: [{ email }],
    subject: "Your WhaleChat verification code",
    htmlContent: emailCodeHtml(code),
    textContent: "Your WhaleChat verification code is " + code + ". It expires in 10 minutes."
  };
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey2, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.status === 201 || res.ok)
        return { ok: true, status: res.status };
      const txt = await res.text().catch(() => "");
      lastError = "Brevo " + res.status + ": " + String(txt).slice(0, 300);
      console.error("[email] " + lastError);
      /* A permanent 4xx (bad key, unverified sender, bad address) is not worth
         a retry; rate limits and 5xx are. */
      if (res.status >= 400 && res.status < 500 && res.status !== 429)
        return { ok: false, error: "email_failed", status: res.status };
    } catch (e) {
      lastError = String(e && e.message || e);
      console.error("[email] Brevo request failed: " + lastError);
    }
    if (attempt === 0)
      await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ok: false, error: "email_failed" };
}
var ChatHub = class {
  constructor(state, env3) {
    this.state = state;
    this.env = env3;
    this.db = null;
    this.rev = 0;
    this.updatedAt = 0;
    this.clients = /* @__PURE__ */ new Map();
    this.marketClients = /* @__PURE__ */ new Map();
    this.presence = /* @__PURE__ */ new Map();
    this.quotes = {};
    this.marketAt = 0;
    this.marketRefreshing = null;
    this.vapid = null;
    this.d1MirroredMessages = /* @__PURE__ */ new Set();
    this.d1TouchedMessages = /* @__PURE__ */ new Set();
    this.loaded = false;
    this.saveTimer = null;
    this.ready = this.load();
  }
  async load() {
    try {
      let meta = await this.state.storage.get("state:meta");
      if (!meta || !meta.chunks) {
        const fromD1 = await this.hydrateFromD1();
        if (fromD1)
          meta = await this.state.storage.get("state:meta");
      }
      if ((!meta || !meta.chunks) && PREV_DO_NAME && PREV_DO_NAME !== DO_NAME) {
        try {
          const prev = this.env.CHAT_HUB.get(this.env.CHAT_HUB.idFromName(PREV_DO_NAME));
          const res = await prev.fetch(new Request("https://do/api/state"));
          const st = await res.json();
          if (st && st.db) {
            this.db = st.db;
            this.rev = st.rev || 0;
            this.updatedAt = st.updatedAt || Date.now();
            await this.persistNow();
            meta = await this.state.storage.get("state:meta");
          }
        } catch (e) {
          console.error("[hub] previous state copy failed", e.message);
        }
      }
      if (meta && meta.chunks) {
        let s = "";
        for (let i = 0; i < meta.chunks; i++)
          s += await this.state.storage.get("state:" + i) || "";
        if (s) {
          const parsed = JSON.parse(s);
          this.db = parsed.db || null;
          this.rev = parsed.rev || 0;
          this.updatedAt = parsed.updatedAt || 0;
        }
      }
      const mkt = await this.state.storage.get("market:snapshot");
      if (mkt && mkt.quotes) {
        this.quotes = mkt.quotes;
        this.marketAt = mkt.at || 0;
      }
    } catch (e) {
      console.error("[hub] load failed", e.message);
    }
    this.loaded = true;
    if (this.db)
      this.scheduleD1();
    try {
      await this.state.storage.setAlarm(Date.now() + 15e3);
    } catch (e) {
    }
  }
  async alarm() {
    try {
      this.ping();
      this.sweepPresence();
      if (this.marketClients.size || this.marketAt && Date.now() - this.marketAt > 6e4) {
        try {
          await this.refreshMarket();
        } catch (e) {
        }
      }
    } finally {
      try {
        await this.state.storage.setAlarm(Date.now() + 2e4);
      } catch (e) {
      }
    }
  }
  async persistNow() {
    if (!this.db)
      return;
    try {
      const s = JSON.stringify({ db: this.db, rev: this.rev, updatedAt: this.updatedAt });
      const size = 8e4;
      const chunks = Math.ceil(s.length / size) || 1;
      const prev = await this.state.storage.get("state:meta");
      for (let i = 0; i < chunks; i++)
        await this.state.storage.put("state:" + i, s.slice(i * size, (i + 1) * size));
      await this.state.storage.put("state:meta", { chunks, rev: this.rev, updatedAt: this.updatedAt });
      if (prev && prev.chunks > chunks) {
        for (let i = chunks; i < prev.chunks; i++)
          await this.state.storage.delete("state:" + i);
      }
    } catch (e) {
      console.error("[hub] save failed", e.message);
    }
  }
  scheduleSave() {
    if (this.saveTimer)
      return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.state.waitUntil(this.persistNow());
      } catch (e) {
        this.persistNow();
      }
    }, 250);
    this.scheduleD1();
  }
  /* ------------------------------------------------------------------ *
   *  D1 mirror — the durable source of truth behind Durable Object      *
   * ------------------------------------------------------------------ */
  scheduleD1() {
    if (this.d1Timer)
      return;
    this.d1Timer = setTimeout(() => {
      this.d1Timer = null;
      try {
        this.state.waitUntil(this.mirrorD1());
      } catch (e) {
        this.mirrorD1().catch(() => {
        });
      }
    }, 2500);
  }
  async hydrateFromD1() {
    if (!this.env || !this.env.DB)
      return false;
    try {
      const rows = await this.env.DB.prepare("SELECT idx, chunk FROM app_state_chunks WHERE id = 1 AND rev = (SELECT MAX(rev) FROM app_state_chunks WHERE id = 1) ORDER BY idx").all();
      const chunks = (rows.results || []).map((r) => r.chunk || "");
      if (!chunks.length)
        return false;
      const parsed = JSON.parse(chunks.join(""));
      if (!parsed || !parsed.db || !Array.isArray(parsed.db.users))
        return false;
      this.db = parsed.db;
      this.rev = parsed.rev || 0;
      this.updatedAt = parsed.updatedAt || Date.now();
      try {
        await this.persistNow();
      } catch (e) {
      }
      console.log("[hub] hydrated from D1 \xB7 users", this.db.users.length);
      return true;
    } catch (e) {
      console.error("[hub] D1 hydrate failed", e.message);
      return false;
    }
  }
  async mirrorD1() {
    if (!this.env || !this.env.DB || !this.db)
      return;
    // Only the active Durable Object (the one the router serves) may write
    // to D1. Previous versioned objects keep running their alarms after a
    // publish and would otherwise overwrite fresh data with their old copy.
    try {
      const myName = this.state && this.state.id && this.state.id.name;
      if (myName && myName !== DO_NAME) {
        return;
      }
    } catch (e) {
    }
    try {
      const json2 = JSON.stringify({ db: this.db, rev: this.rev, updatedAt: this.updatedAt });
      const size = 7e4;
      const chunks = Math.ceil(json2.length / size) || 1;
      const rev = Number(this.rev) || 0;
      const stmts = [];
      for (let i = 0; i < chunks; i++)
        stmts.push(this.env.DB.prepare("INSERT INTO app_state_chunks (id, idx, chunk, rev) VALUES (1, ?, ?, ?) ON CONFLICT(id, idx) DO UPDATE SET chunk=excluded.chunk, rev=excluded.rev WHERE excluded.rev >= app_state_chunks.rev").bind(i, json2.slice(i * size, (i + 1) * size), rev));
      stmts.push(this.env.DB.prepare("DELETE FROM app_state_chunks WHERE id = 1 AND idx >= ?").bind(chunks));
      stmts.push(this.env.DB.prepare("DELETE FROM app_state_chunks WHERE id = 1 AND rev <> ?").bind(rev));
      await this.env.DB.batch(stmts);
      const users = (this.db.users || []).filter((u) => u && u.id && u.email);
      for (let i = 0; i < users.length; i += 40) {
        const part = users.slice(i, i + 40);
        await this.env.DB.batch(part.map((u) => this.env.DB.prepare(
          "INSERT INTO users (id, name, email, password_hash, phone, avatar, created_at, last_seen, username, data) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, password_hash=excluded.password_hash, phone=excluded.phone, avatar=excluded.avatar, last_seen=excluded.last_seen, username=excluded.username, data=excluded.data"
        ).bind(String(u.id), String(u.fullName || u.username || "WhaleChat user"), String(u.email).toLowerCase(), String(u.pass || ""), u.phone || null, u.avatar || null, Number(u.createdAt) || Date.now(), Number(u.lastSeen) || Date.now(), u.username || null, JSON.stringify(u))));
      }
      const allMsgs = (this.db.messages || []).filter((m) => m && m.id);
      const msgs = allMsgs.filter((m) => !this.d1MirroredMessages.has(m.id) || this.d1TouchedMessages.has(m.id)).slice(-200);
      for (let i = 0; i < msgs.length; i += 40) {
        const part = msgs.slice(i, i + 40);
        await this.env.DB.batch(part.map((m) => this.env.DB.prepare(
          "INSERT INTO messages (id, chat_id, sender_id, to_id, text, file_url, file_type, created_at, status, read_by, data) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, file_url=excluded.file_url, file_type=excluded.file_type, status=excluded.status, read_by=excluded.read_by, data=excluded.data"
        ).bind(String(m.id), String(m.chatId || ""), String(m.from || ""), m.to ? String(m.to) : null, m.text || null, m.mediaUrl || m.fileUrl || null, m.type || null, Number(m.createdAt) || Date.now(), m.status || "sent", JSON.stringify(m.readBy || []), JSON.stringify(m))));
      }
      msgs.forEach((m) => {
        this.d1MirroredMessages.add(m.id);
        this.d1TouchedMessages.delete(m.id);
      });
    } catch (e) {
      console.error("[hub] D1 mirror failed", e.message);
    }
  }
  ping() {
    for (const [id, c] of this.clients) {
      try {
        c.controller.enqueue(enc.encode(": ping\n\n"));
      } catch (e) {
        this.clients.delete(id);
      }
    }
    for (const [id, c] of this.marketClients) {
      try {
        c.enqueue(enc.encode(": ping\n\n"));
      } catch (e) {
        this.marketClients.delete(id);
      }
    }
  }
  online(userId) {
    for (const c of this.clients.values())
      if (c.user === userId)
        return true;
    return false;
  }
  countSockets(userId) {
    let n = 0;
    for (const c of this.clients.values())
      if (c.user === userId)
        n++;
    return n;
  }
  presenceView(userId) {
    const id = String(userId || "");
    const p = this.presence.get(id);
    const stored = this.db && this.db.presence && this.db.presence[id] || null;
    const online = !!(p && p.visible !== false && this.online(id));
    return {
      userId: id,
      online,
      lastSeen: online ? Date.now() : Math.max(Number(p && p.lastSeen) || 0, Number(stored && stored.lastSeen) || 0),
      currentChatWith: p && p.currentChatWith || stored && stored.currentChatWith || ""
    };
  }
  roomPeers(userId) {
    const out = /* @__PURE__ */ new Set();
    (this.db && this.db.sessionRooms || []).forEach((r) => {
      if (!r || !Array.isArray(r.members) || !r.members.includes(userId))
        return;
      r.members.forEach((id) => {
        if (id !== userId)
          out.add(String(id));
      });
    });
    return [...out];
  }
  presenceAudience(userId) {
    const ids = /* @__PURE__ */ new Set([String(userId)]);
    const db = this.db || {};
    (db.messages || []).forEach((m) => {
      if (!m)
        return;
      if (m.from === userId && m.to)
        ids.add(String(m.to));
      else if (m.to === userId && m.from)
        ids.add(String(m.from));
    });
    (db.contacts || []).forEach((c) => {
      if (!c)
        return;
      if (c.ownerId === userId && c.userId)
        ids.add(String(c.userId));
      else if (c.userId === userId && c.ownerId)
        ids.add(String(c.ownerId));
    });
    this.roomPeers(userId).forEach((id) => ids.add(id));
    return [...ids];
  }
  broadcastAll(event, data) {
    const frame = enc.encode(frameOf(event, data));
    for (const [id, c] of this.clients) {
      try {
        c.controller.enqueue(frame);
      } catch (e) {
        this.clients.delete(id);
      }
    }
    return this.clients.size;
  }
  broadcastTo(userIds, event, data) {
    const want = new Set((userIds || []).filter(Boolean));
    if (!want.size)
      return 0;
    const frame = enc.encode(frameOf(event, data));
    let n = 0;
    for (const [id, c] of this.clients) {
      if (!want.has(c.user))
        continue;
      try {
        c.controller.enqueue(frame);
        n++;
      } catch (e) {
        this.clients.delete(id);
      }
    }
    return n;
  }
  touchPresence(userId, patch) {
    const id = String(userId || "");
    if (!id)
      return null;
    const prev = this.presence.get(id) || { ts: 0, lastSeen: 0, currentChatWith: "", device: "", visible: true };
    const next = Object.assign({}, prev, patch || {}, { ts: Date.now() });
    this.presence.set(id, next);
    return this.broadcastPresence(id);
  }
  broadcastPresence(userId) {
    const view = this.presenceView(userId);
    this.broadcastTo(this.presenceAudience(userId), "presence", { presence: view, at: Date.now() });
    if (!this.db)
      return view;
    if (!this.db.presence)
      this.db.presence = {};
    this.db.presence[userId] = { lastSeen: view.lastSeen, currentChatWith: view.currentChatWith };
    this.scheduleSave();
    return view;
  }
  markOffline(userId) {
    const id = String(userId || "");
    if (!id)
      return;
    const p = this.presence.get(id) || { ts: 0, lastSeen: 0 };
    p.ts = 0;
    p.visible = false;
    p.lastSeen = Date.now();
    p.currentChatWith = "";
    this.presence.set(id, p);
    this.broadcastPresence(id);
  }
  sweepPresence() {
    const now = Date.now();
    this.presence.forEach((p, id) => {
      if (!p)
        return;
      if (now - Number(p.ts) >= PRESENCE_STALE_MS && (p.visible !== false || this.online(id))) {
        p.visible = false;
        p.lastSeen = now;
        p.currentChatWith = "";
        this.presence.set(id, p);
        this.broadcastPresence(id);
      }
    });
  }
  markDelivered(userId) {
    if (!this.db || !Array.isArray(this.db.messages))
      return 0;
    const changed = [];
    this.db.messages.forEach((m) => {
      if (!m || m.to !== userId || m.status === "seen" || m.status === "delivered")
        return;
      m.status = "delivered";
      m.deliveredAt = m.deliveredAt || Date.now();
      changed.push(m);
    });
    if (!changed.length)
      return 0;
    this.rev += 1;
    this.updatedAt = Date.now();
    this.scheduleSave();
    changed.forEach((m) => this.broadcastTo([m.from], "delivered", { chatId: m.chatId, userId, ids: [m.id], at: Date.now(), rev: this.rev }));
    return changed.length;
  }
  applyOps(ops) {
    const pushes = [];
    for (const op of ops || []) {
      if (!op || typeof op !== "object")
        continue;
      if (op.op === "set") {
        if (typeof op.key === "string" && !op.key.startsWith("__"))
          this.db[op.key] = op.value;
        continue;
      }
      if (!COLLECTIONS.includes(op.col))
        continue;
      if (!Array.isArray(this.db[op.col]))
        this.db[op.col] = [];
      const arr = this.db[op.col];
      if (op.op === "push" && op.item && op.item.id) {
        const i = arr.findIndex((x) => x && x.id === op.item.id);
        if (i >= 0)
          arr[i] = op.item;
        else
          arr.push(op.item);
        pushes.push({ col: op.col, item: op.item, isNew: i < 0 });
      } else if (op.op === "update" && op.id) {
        const i = arr.findIndex((x) => x && x.id === op.id);
        if (i >= 0)
          arr[i] = Object.assign({}, arr[i], op.patch || {});
        else if (op.patch && op.patch.id)
          arr.push(op.patch);
        if (i >= 0)
          pushes.push({ col: op.col, item: arr[i], isNew: false });
      } else if (op.op === "remove" && op.id) {
        const i = arr.findIndex((x) => x && x.id === op.id);
        if (i >= 0)
          arr.splice(i, 1);
      }
    }
    return { pushes };
  }
  roomByCode(code) {
    const c = String(code || "").trim().toUpperCase();
    return (this.db && this.db.sessionRooms || []).find((r) => r && r.code === c) || null;
  }
  rooms() {
    if (!this.db)
      return [];
    if (!Array.isArray(this.db.sessionRooms))
      this.db.sessionRooms = [];
    return this.db.sessionRooms;
  }
  code() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let k = 0; k < 40; k++) {
      let c = "";
      for (let i = 0; i < 6; i++)
        c += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (!this.roomByCode(c))
        return c;
    }
    return "R" + Date.now().toString(36).toUpperCase().slice(-6);
  }
  roomView(r) {
    return { code: r.code, name: r.name || "Internet session", ownerId: r.ownerId, members: (r.members || []).slice(), createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  roomBroadcast(room, event, data, except) {
    this.broadcastTo((room.members || []).filter((id) => id !== except), event, data);
  }
  /* ------------------------------------------------------------------ *
   *  D1 auth + users                                                    *
   * ------------------------------------------------------------------ */
  async hashPassword(password) {
    const data = enc.encode(String(password) + "whalechat-salt-2026");
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  safeUser(row) {
    if (!row)
      return null;
    let extra = {};
    try {
      extra = row.data ? JSON.parse(row.data) : {};
    } catch (e) {
    }
    const user = Object.assign({}, extra, {
      id: row.id,
      fullName: extra.fullName || row.name,
      username: extra.username || row.username,
      email: row.email,
      phone: row.phone || extra.phone || "",
      avatar: row.avatar || extra.avatar || null,
      role: extra.role || "user",
      createdAt: Number(extra.createdAt || row.created_at) || Date.now(),
      lastSeen: Number(row.last_seen) || 0
    });
    delete user.pass;
    delete user.password_hash;
    delete user.passwordHash;
    return user;
  }
  /* ================================================================== *
   * Servers & API — admin panel connection space
   *
   * The admin can connect, from the panel itself:
   *   · one or more WhaleChat app servers (sync servers) — each one is
   *     probed on /api/health before it is accepted, and the first one is
   *     marked primary so the app advertises it as the sync endpoint
   *   · the Brevo email server (API key + verified sender) — used by the
   *     verification codes, test emails and broadcasts
   *
   * Settings live in D1 (app_state → settings.connections), NOT in the
   * synced app database, so a client state re-merge, a redeploy or a new
   * browser can never wipe them.
   * ================================================================== */
  async loadConnections() {
    if (this.connectionsCache) return this.connectionsCache;
    let v = {};
    if (this.env && this.env.DB) {
      try {
        const row = await this.env.DB.prepare("SELECT v FROM app_state WHERE k = ?").bind("settings.connections").first();
        if (row && row.v) v = JSON.parse(row.v) || {};
      } catch (e) {
      }
    }
    if (!v.app) v.app = {};
    if (!Array.isArray(v.app.servers)) v.app.servers = [];
    if (!v.brevo) v.brevo = {};
    this.connectionsCache = v;
    return v;
  }
  async saveConnections(v) {
    v.updatedAt = Date.now();
    this.connectionsCache = v;
    if (this.env && this.env.DB) {
      try {
        await this.env.DB.prepare("INSERT INTO app_state (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind("settings.connections", JSON.stringify(v)).run();
      } catch (e) {
        console.error("[connections] save failed: " + (e && e.message));
      }
    }
    return v;
  }
  /* the key the email engine should actually use: the one the admin saved in
     the panel wins, the Worker secret is the fallback before anything is set */
  effectiveBrevoKey() {
    try {
      const c = this.connectionsCache || {};
      const stored = c.brevo && c.brevo.apiKey ? String(c.brevo.apiKey) : "";
      if (stored) return stored;
    } catch (e) {
    }
    return String((this.env && this.env.BREVO_API_KEY) || "");
  }
  effectiveBrevoSender() {
    let from = "", name = "";
    try {
      const c = this.connectionsCache || {};
      from = (c.brevo && c.brevo.from) || "";
      name = (c.brevo && c.brevo.name) || "";
    } catch (e) {
    }
    const s = brevoSender(this.env || {});
    return { email: from || s.email, name: name || s.name };
  }
  maskKey(k) {
    const v = String(k || "");
    if (!v) return "";
    if (v.length <= 10) return v.slice(0, 2) + "••••";
    return v.slice(0, 7) + "••••••" + v.slice(-4);
  }
  async adminOf(request, b) {
    const row = await this.authUser(request);
    if (row) {
      let u = row;
      try {
        if (row.data) u = Object.assign({}, row, JSON.parse(row.data) || {});
      } catch (e) {
      }
      if (u && u.role === "admin") return u;
    }
    const adminId = String((b && b.adminId) || "");
    if (!adminId) return null;
    return (this.db && this.db.users ? this.db.users : []).find((u) => u && u.id === adminId && u.role === "admin") || null;
  }
  async probeServer(rawUrl) {
    const started = Date.now();
    let target = String(rawUrl || "").trim();
    if (!target) return { ok: false, error: "url_required" };
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    target = target.replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/i.test(target)) return { ok: false, error: "invalid_url" };
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 7000) : null;
    try {
      const res = await fetch(target + "/api/health", { method: "GET", headers: { accept: "application/json" }, signal: ctl ? ctl.signal : undefined });
      const latencyMs = Date.now() - started;
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
      }
      if (timer) clearTimeout(timer);
      if (!res.ok) return { ok: false, url: target, status: res.status, latencyMs, error: "health_http_" + res.status };
      const looksWhalechat = !!(data && (data.app === "whalechat" || data.ok === true || data.version));
      return {
        ok: looksWhalechat,
        url: target,
        status: res.status,
        latencyMs,
        version: (data && (data.version || data.app)) || "",
        rev: (data && Number(data.rev)) || 0,
        users: (data && Number(data.users)) || 0,
        storage: (data && data.storage) || "",
        error: looksWhalechat ? "" : "not_a_whalechat_server"
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, url: target, latencyMs: Date.now() - started, error: String((e && e.message) || e).slice(0, 160) };
    }
  }
  async brevoVerify(key) {
    if (!key) return { ok: false, error: "key_required" };
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 8000) : null;
    try {
      const res = await fetch("https://api.brevo.com/v3/account", { method: "GET", headers: { "api-key": key, accept: "application/json" }, signal: ctl ? ctl.signal : undefined });
      if (timer) clearTimeout(timer);
      let d = null;
      try {
        d = await res.json();
      } catch (e) {
      }
      if (res.status === 401 || res.status === 403)
        return { ok: false, status: res.status, error: "key_rejected" };
      if (!res.ok)
        return { ok: false, status: res.status, error: "brevo_" + res.status };
      const senders = [];
      try {
        const sr = await fetch("https://api.brevo.com/v3/senders", { headers: { "api-key": key, accept: "application/json" } });
        const sd = await sr.json();
        (sd && sd.senders ? sd.senders : []).forEach((x) => { if (x && x.email) senders.push(String(x.email)); });
      } catch (e) {
      }
      return { ok: true, status: res.status, company: (d && d.companyName) || "", plan: (d && d.plan && (d.plan.type || "")) || "", senders };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
    }
  }
  async connectionsStatus(url) {
    const c = await this.loadConnections();
    const key = this.effectiveBrevoKey();
    const sender = this.effectiveBrevoSender();
    const self = (() => { try { return new URL(url).origin; } catch (e) { return ""; } })();
    const servers = (c.app.servers || []).map((x) => ({
      id: x.id, label: x.label || x.url, url: x.url, primary: !!x.primary,
      addedAt: x.addedAt || 0, checkedAt: x.checkedAt || 0, connected: !!x.connected,
      rev: x.rev || 0, version: x.version || "", latencyMs: x.latencyMs || 0, error: x.error || "",
      isSelf: x.url === self
    }));
    return {
      ok: true,
      app: {
        servers,
        selfUrl: self,
        primaryUrl: (servers.filter((x) => x.primary)[0] || {}).url || "",
        publicUrl: c.app.publicUrl || "",
        connected: servers.some((x) => x.connected)
      },
      brevo: {
        configured: !!key,
        source: (c.brevo && c.brevo.apiKey) ? "admin panel" : (this.env && this.env.BREVO_API_KEY ? "worker secret" : "none"),
        key: this.maskKey(key),
        from: sender.email,
        name: sender.name,
        verifiedAt: (c.brevo && c.brevo.verifiedAt) || 0,
        senders: (c.brevo && c.brevo.senders) || [],
        lastTest: (c.brevo && c.brevo.lastTest) || null
      },
      smtp: { configured: false, note: "Brevo HTTPS API only — no SMTP socket to disconnect" },
      storage: {
        backend: this.env && this.env.DB ? "cloudflare-d1" : "durable-object",
        table: "app_state · settings.connections",
        updatedAt: c.updatedAt || 0
      }
    };
  }
  async handleConnections(request, url, bodyFn) {
    const b = request.method === "POST" ? await bodyFn() : {};
    /* GET carries the admin in the query string (the panel always sends it) */
    if (!b.adminId && url) {
      try {
        b.adminId = url.searchParams.get("adminId") || "";
      } catch (e) {
      }
    }
    const admin = await this.adminOf(request, b);
    if (!admin)
      return json({ ok: false, error: "admin_only" }, 403);
    await this.loadConnections();
    if (request.method !== "POST")
      return json(await this.connectionsStatus(url));
    const c = await this.loadConnections();
    const applied = [];

    /* ---- app server ------------------------------------------------- */
    if (b.app && typeof b.app === "object") {
      const a = b.app;
      if (a.remove) {
        c.app.servers = (c.app.servers || []).filter((x) => x.id !== String(a.remove));
        if (!c.app.servers.some((x) => x.primary) && c.app.servers.length) c.app.servers[0].primary = true;
        applied.push("app-server-removed");
      } else if (a.url) {
        const probe = await this.probeServer(a.url);
        if (!probe.ok)
          return json({ ok: false, error: probe.error || "server_unreachable", probe, status: await this.connectionsStatus(url) }, 200);
        const norm = probe.url;
        let rec = (c.app.servers || []).filter((x) => x.url === norm)[0];
        if (!rec) {
          rec = { id: "srv_" + Math.random().toString(36).slice(2, 9), url: norm, addedAt: Date.now() };
          c.app.servers.unshift(rec);
        }
        rec.label = String(a.label || rec.label || norm).slice(0, 60);
        rec.connected = true;
        rec.rev = probe.rev || 0;
        rec.version = probe.version || "";
        rec.latencyMs = probe.latencyMs || 0;
        rec.checkedAt = Date.now();
        rec.error = "";
        if (a.primary === true || !c.app.servers.some((x) => x.primary)) {
          c.app.servers.forEach((x) => { x.primary = false; });
          rec.primary = true;
        }
        applied.push("app-server");
      } else if (a.primary) {
        c.app.servers.forEach((x) => { x.primary = x.id === String(a.primary); });
        applied.push("app-server-primary");
      }
      if (typeof a.publicUrl === "string") c.app.publicUrl = a.publicUrl.trim().slice(0, 300);
    }

    /* ---- brevo email server ---------------------------------------- */
    if (b.brevo && typeof b.brevo === "object") {
      const e = b.brevo;
      if (e.disconnect) {
        c.brevo = { apiKey: "", from: c.brevo.from || "", name: c.brevo.name || "", updatedAt: Date.now() };
        applied.push("brevo-disconnected");
      } else if (e.apiKey || e.from) {
        const key = String(e.apiKey || e.brevo || "").trim();
        if (key) {
          const check = await this.brevoVerify(key);
          if (!check.ok)
            return json({ ok: false, error: check.error === "key_rejected" ? "brevo_key_rejected" : (check.error || "brevo_check_failed"), probe: check, status: await this.connectionsStatus(url) }, 200);
          c.brevo.apiKey = key;
          c.brevo.verifiedAt = Date.now();
          c.brevo.company = check.company || "";
          c.brevo.senders = check.senders || [];
          applied.push("brevo");
        }
        if (typeof e.from === "string" && e.from.trim()) c.brevo.from = e.from.trim().slice(0, 160);
        if (typeof e.name === "string" && e.name.trim()) c.brevo.name = e.name.trim().slice(0, 60);
      }
    }

    await this.saveConnections(c);
    return json({ ok: true, applied, status: await this.connectionsStatus(url) });
  }
  async handleConnectionTest(request, url, bodyFn) {
    const b = (await bodyFn()) || {};
    if (!b.adminId && url) {
      try {
        b.adminId = url.searchParams.get("adminId") || "";
      } catch (e) {
      }
    }
    const admin = await this.adminOf(request, b);
    if (!admin)
      return json({ ok: false, error: "admin_only" }, 403);
    const c = await this.loadConnections();
    const which = String(b.which || "all");
    const results = {};

    if (which === "app" || which === "all") {
      const list = b.serverId ? (c.app.servers || []).filter((x) => x.id === String(b.serverId)) : (c.app.servers || []);
      const probes = [];
      for (const srv of list) {
        const probe = await this.probeServer(srv.url);
        srv.connected = !!probe.ok;
        srv.rev = probe.rev || srv.rev || 0;
        srv.version = probe.version || srv.version || "";
        srv.latencyMs = probe.latencyMs || 0;
        srv.checkedAt = Date.now();
        srv.error = probe.error || "";
        probes.push({ id: srv.id, url: srv.url, ok: !!probe.ok, latencyMs: probe.latencyMs || 0, error: probe.error || "", version: probe.version || "" });
      }
      if (!list.length) {
        const probe = await this.probeServer(url ? new URL(url).origin : "");
        probes.push({ id: "self", url: probe.url || "", ok: !!probe.ok, latencyMs: probe.latencyMs || 0, error: probe.error || "" });
      }
      await this.saveConnections(c);
      results.app = { ok: probes.some((p) => p.ok), servers: probes };
    }

    if (which === "brevo" || which === "all" || which === "app" && false) {
      const key = this.effectiveBrevoKey();
      const check = await this.brevoVerify(key);
      const out = { configured: !!key, ok: !!check.ok, error: check.error || "", senders: check.senders || [] };
      const to = String(b.to || (admin && admin.email) || "").trim();
      if (check.ok && to) {
        try {
          const sender = this.effectiveBrevoSender();
          const res = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              sender,
              to: [{ email: to, name: "WhaleChat test" }],
              subject: "WhaleChat email server connected",
              htmlContent: "<div style=\"font-family:system-ui,Arial,sans-serif\"><h2 style=\"color:#0f766e\">Email server connected ✓</h2><p>This test was sent from Admin → Servers &amp; API. Verification codes and account emails will now send through <b>" + String(sender.email) + "</b>.</p></div>",
              textContent: "WhaleChat email server connected. Test sent to " + to
            })
          });
          out.sent = !!res.ok;
          if (!res.ok) out.sendError = "Brevo " + res.status + ": " + String(await res.text()).slice(0, 160);
          out.to = to;
        } catch (e) {
          out.sent = false;
          out.sendError = String((e && e.message) || e);
        }
      }
      c.brevo.lastTest = { ok: !!(check.ok && (out.sent || !to)), at: Date.now(), to, error: out.error || out.sendError || "" };
      await this.saveConnections(c);
      results.brevo = out;
      results.email = out;
    }

    return json({ ok: true, which, results, status: await this.connectionsStatus(url) });
  }
  async authUser(request) {
    if (!this.env || !this.env.DB)
      return null;
    const raw = request.headers.get("authorization") || "";
    const token = raw.replace(/^Bearer\s+/i, "").trim();
    if (!token)
      return null;
    try {
      const row = await this.env.DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?").bind(token, Date.now()).first();
      return row || null;
    } catch (e) {
      return null;
    }
  }
  async createSession(userId) {
    const token = crypto.randomUUID();
    try {
      await this.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(Date.now()).run();
      await this.env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)").bind(token, userId, Date.now() + 30 * 864e5).run();
    } catch (e) {
    }
    return token;
  }
  d1UserToApp(row) {
    const u = this.safeUser(row);
    if (!u)
      return null;
    if (!Array.isArray(this.db.users))
      this.db.users = [];
    const i = this.db.users.findIndex((x) => x && (x.id === u.id || x.email && u.email && String(x.email).toLowerCase() === String(u.email).toLowerCase()));
    if (i >= 0)
      this.db.users[i] = Object.assign({}, this.db.users[i], u);
    else
      this.db.users.push(u);
    this.rev += 1;
    this.updatedAt = Date.now();
    this.scheduleSave();
    return this.db.users[i >= 0 ? i : this.db.users.length - 1];
  }
  quietNow(prefs) {
    if (!prefs || prefs.quietStart == null || prefs.quietEnd == null)
      return false;
    const start = Number(prefs.quietStart), end = Number(prefs.quietEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end)
      return false;
    const off2 = Number(prefs.tzOffset) || 0;
    const now = /* @__PURE__ */ new Date();
    const local = (now.getUTCHours() * 60 + now.getUTCMinutes() - off2 + 1440) % 1440;
    return start < end ? local >= start && local < end : local >= start || local < end;
  }
  notifyPrefsFor(userId, chatId) {
    try {
      const meta = this.db && this.db.chatsMeta && this.db.chatsMeta[chatId] || {};
      const per = meta.notify && meta.notify[userId] || {};
      const legacy = this.db && this.db.chatNotify && this.db.chatNotify[userId] && this.db.chatNotify[userId][chatId] || {};
      return Object.assign({}, legacy, per);
    } catch (e) {
      return {};
    }
  }
  /* ------------------------------------------------------------------ *
   *  Web Push (VAPID + RFC 8291 aes128gcm)                              *
   * ------------------------------------------------------------------ */
  async ensureVapid() {
    if (this.vapid)
      return this.vapid;
    if (this.db && this.db.pushVapid && this.db.pushVapid.jwk && this.db.pushVapid.pub) {
      this.vapid = this.db.pushVapid;
      return this.vapid;
    }
    let saved = null;
    try {
      saved = await this.state.storage.get("push:vapid");
    } catch (e) {
    }
    if (!saved || !saved.jwk || !saved.pub) {
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      saved = { jwk, pub: b64u(raw), at: Date.now() };
    }
    try {
      await this.state.storage.put("push:vapid", saved);
    } catch (e) {
    }
    if (this.db) {
      this.db.pushVapid = saved;
      this.scheduleSave();
    }
    this.vapid = saved;
    return saved;
  }
  async vapidAuthorization(endpoint) {
    const v = await this.ensureVapid();
    const aud = new URL(endpoint).origin;
    const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: "mailto:support@whalechat.app" })));
    const data = header + "." + payload;
    const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(data));
    return "vapid t=" + data + "." + b64u(new Uint8Array(sig)) + ", k=" + v.pub;
  }
  async encryptPush(subscription, payload) {
    const uaPub = unb64u(subscription.keys.p256dh);
    const auth = unb64u(subscription.keys.auth);
    const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
    const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
    const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPub, ephPub);
    const ikm = await hkdfExpand(await hmac(auth, shared), keyInfo, 32);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const prk = await hmac(salt, ikm);
    const cek = await hkdfExpand(prk, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
    const nonce = await hkdfExpand(prk, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);
    const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, concat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]))));
    const rs = new Uint8Array(4);
    new DataView(rs.buffer).setUint32(0, 4096);
    return concat(salt, rs, new Uint8Array([65]), ephPub, ct);
  }
  async sendPushTo(subscription, payload) {
    try {
      if (!subscription || !subscription.endpoint || !subscription.keys)
        return false;
      const body = await this.encryptPush(subscription, payload);
      const auth = await this.vapidAuthorization(subscription.endpoint);
      const res = await fetch(subscription.endpoint, {
        method: "POST",
        headers: {
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          "TTL": String(payload.ttl || 86400),
          "Urgency": payload.urgency || "high",
          "Authorization": auth
        },
        body
      });
      if (res.status === 404 || res.status === 410)
        return "gone";
      return res.ok ? true : "retry";
    } catch (e) {
      return "retry";
    }
  }
  async pushMessage(msg) {
    if (!msg || !msg.to || msg.to === msg.from)
      return 0;
    const prefs = this.notifyPrefsFor(msg.to, msg.chatId);
    const meta = this.db && this.db.chatsMeta && this.db.chatsMeta[msg.chatId] || {};
    const muted = prefs.muted === true || Array.isArray(meta.muted) && meta.muted.includes(msg.to);
    if (muted)
      return 0;
    if (this.quietNow(prefs))
      return 0;
    const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s && s.userId === msg.to);
    if (!subs.length)
      return 0;
    const sender = (this.db.users || []).find((u) => u && u.id === msg.from) || {};
    const mode = prefs.preview || "full";
    const payload = {
      title: mode === "hidden" ? "WhaleChat" : sender.fullName || sender.username || "WhaleChat",
      body: mode === "full" ? previewText(msg) : "New message",
      link: "#/chat/" + msg.from,
      tag: "wc-msg-" + (msg.chatId || msg.from),
      icon: "./assets/logo-192.png",
      badge: "./assets/badge-72.png",
      requireInteraction: true,
      renotify: true,
      ts: Date.now()
    };
    let sent = 0;
    const gone = [];
    for (const sub of subs) {
      const r = await this.sendPushTo(sub, payload);
      if (r === true)
        sent++;
      else if (r === "gone")
        gone.push(sub.endpoint);
    }
    if (gone.length) {
      this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => !gone.includes(s.endpoint));
      this.scheduleSave();
    }
    return sent;
  }
  async pushRoomMessage(room, msg) {
    if (!room || !msg)
      return 0;
    const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s && s.userId && s.userId !== msg.from && (room.members || []).includes(s.userId));
    const sender = (this.db.users || []).find((u) => u && u.id === msg.from) || {};
    const payloadBase = {
      link: "#/session/" + room.code,
      tag: "wc-room-" + room.code,
      icon: "./assets/logo-192.png",
      badge: "./assets/badge-72.png",
      requireInteraction: true,
      renotify: true,
      ts: Date.now()
    };
    let sent = 0;
    for (const sub of subs) {
      const prefs = this.notifyPrefsFor(sub.userId, room.code);
      if (prefs.muted === true || this.quietNow(prefs))
        continue;
      const mode = prefs.preview || "full";
      const payload = Object.assign({}, payloadBase, {
        title: mode === "hidden" ? "WhaleChat" : sender.fullName || sender.username || "WhaleChat",
        body: mode === "full" ? previewText(msg) : "New message"
      });
      if (await this.sendPushTo(sub, payload) === true)
        sent++;
    }
    return sent;
  }
  /* ------------------------------------------------------------------ *
   *  Market quotes (public Yahoo Finance spark + Binance fallback)      *
   * ------------------------------------------------------------------ */
  marketStatus() {
    const quotes = this.quotes || {};
    const priced = Object.keys(quotes).filter((t) => quotes[t] && quotes[t].price > 0).length;
    return {
      mode: "live",
      source: "yahoo",
      refreshSec: 30,
      tickers: priced,
      unpriced: Math.max(0, (this.db && this.db.stocks || []).length - priced),
      lastRealAt: this.marketAt,
      lastTickAt: this.marketAt,
      marketOpen: true,
      alwaysOpen: true,
      notice: "Live quotes \xB7 Yahoo Finance public feed (stocks, ETFs, FX, crypto)"
    };
  }
  marketSnapshot() {
    const st = this.marketStatus();
    return { ok: true, at: Date.now(), source: "live", marketOpen: true, alwaysOpen: true, notice: st.notice, status: st, quotes: this.quotes || {} };
  }
  async fetchSpark(symbols, interval) {
    if (!symbols.length)
      return {};
    const url = "https://query1.finance.yahoo.com/v8/finance/spark?symbols=" + encodeURIComponent(symbols.join(",")) + "&interval=" + interval + "&range=1d";
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; WhaleChat/3.58.2)", accept: "application/json" } });
    if (!res.ok)
      throw new Error("yahoo " + res.status);
    return await res.json();
  }
  async refreshMarket() {
    if (this.marketRefreshing)
      return this.marketRefreshing;
    this.marketRefreshing = (async () => {
      try {
        const assets = (this.db && Array.isArray(this.db.stocks) ? this.db.stocks : []).filter((a) => a && a.ticker);
        if (!assets.length)
          return this.marketSnapshot();
        const map = /* @__PURE__ */ new Map();
        assets.forEach((a) => {
          const y = yahooSymbol(a);
          if (y)
            map.set(y, a.ticker);
        });
        const symbols = [...map.keys()];
        const now = Date.now();
        const next = {};
        for (let i = 0; i < symbols.length; i += 20) {
          const chunk = symbols.slice(i, i + 20);
          let data = {};
          try {
            data = await this.fetchSpark(chunk, "1d");
          } catch (e) {
            continue;
          }
          Object.keys(data || {}).forEach((sym) => {
            const row = data[sym];
            if (!row)
              return;
            const closes = Array.isArray(row.close) ? row.close.filter((n) => Number(n) > 0) : [];
            const price = Number(row.fulldayPrice || closes[closes.length - 1] || 0);
            if (!(price > 0))
              return;
            const ticker = map.get(sym) || sym;
            const prevClose = Number(row.chartPreviousClose || row.previousClose || price);
            const prev = this.quotes[ticker] || {};
            next[ticker] = {
              ticker,
              price: Math.round(price * 1e4) / 1e4,
              prevClose: Math.round(prevClose * 1e4) / 1e4,
              open: Math.round(prevClose * 1e4) / 1e4,
              dayHigh: Math.max(Number(prev.dayHigh) || price, price),
              dayLow: Math.min(Number(prev.dayLow) || price, price),
              vol: 0,
              dir: price > (Number(prev.price) || price) ? 1 : price < (Number(prev.price) || price) ? -1 : 0,
              updatedAt: now,
              source: "yahoo",
              real: true
            };
            const q = next[ticker];
            q.changeUsd = Math.round((q.price - q.prevClose) * 1e4) / 1e4;
            q.changePct = q.prevClose ? Math.round(q.changeUsd / q.prevClose * 1e4) / 100 : 0;
          });
        }
        if (Object.keys(next).length) {
          this.quotes = next;
          this.marketAt = now;
          try {
            this.state.waitUntil(this.state.storage.put("market:snapshot", { at: now, quotes: next }));
          } catch (e) {
          }
          const frame = enc.encode(frameOf("snapshot", this.marketSnapshot()));
          for (const [id, c] of this.marketClients) {
            try {
              c.enqueue(frame);
            } catch (e) {
              this.marketClients.delete(id);
            }
          }
        }
      } catch (e) {
        console.error("[market] refresh failed", e.message);
      } finally {
        this.marketRefreshing = null;
      }
      return this.marketSnapshot();
    })();
    return this.marketRefreshing;
  }
  async historyFor(tickers, limit) {
    const assets = this.db && Array.isArray(this.db.stocks) ? this.db.stocks : [];
    const map = /* @__PURE__ */ new Map();
    tickers.forEach((t) => {
      const a = assets.find((x) => x && (x.ticker === t || x.displayTicker === t)) || { ticker: t };
      const y = yahooSymbol(a);
      if (y)
        map.set(y, t);
    });
    const out = {};
    const symbols = [...map.keys()];
    for (let i = 0; i < symbols.length; i += 20) {
      const chunk = symbols.slice(i, i + 20);
      let data = {};
      try {
        data = await this.fetchSpark(chunk, "1m");
      } catch (e) {
        continue;
      }
      Object.keys(data || {}).forEach((sym) => {
        const row = data[sym];
        const ticker = map.get(sym);
        if (!row || !ticker)
          return;
        const ts = Array.isArray(row.timestamp) ? row.timestamp : [];
        const closes = Array.isArray(row.close) ? row.close : [];
        const points = [];
        for (let k = 0; k < ts.length; k++) {
          const p = Number(closes[k]);
          if (Number(ts[k]) > 0 && p > 0)
            points.push({ t: Number(ts[k]) * 1e3, p });
        }
        out[ticker] = points.slice(-Math.min(900, Number(limit) || 240));
      });
    }
    return out;
  }
  /* Issue a 6-digit code, store it in D1 and email it through Brevo HTTPS.
     Returns { status, body } so both the new and legacy routes share it. */
  async issueEmailCode(rawEmail) {
    const email = String(rawEmail || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return { status: 400, body: { success: false, ok: false, error: "invalid_email", message: "Enter a valid email address" } };
    if (!this.env || !this.env.DB)
      return { status: 503, body: { success: false, ok: false, error: "database_unavailable" } };
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 10 * 60 * 1000;
    try {
      await this.env.DB.prepare("CREATE TABLE IF NOT EXISTS email_codes (email TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0)").run();
      await this.env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
      await this.env.DB.prepare("INSERT INTO email_codes (email, code, expires_at, attempts) VALUES (?,?,?,0)").bind(email, code, expiresAt).run();
    } catch (e) {
      console.error("[email] code store failed: " + e.message);
      return { status: 500, body: { success: false, ok: false, error: "code_store_failed" } };
    }
    try { await this.loadConnections(); } catch (e) {}
    const sent = await brevoSendCode(this.env, email, code, this.effectiveBrevoKey(), this.effectiveBrevoSender());
    if (!sent.ok) {
      const notConfigured = sent.error === "email_not_configured";
      return {
        status: notConfigured ? 503 : 502,
        body: {
          success: false,
          ok: false,
          error: notConfigured ? "email_not_configured" : "email_failed",
          message: notConfigured ? "Email is not configured on the server" : "Couldn't send code. Tap resend."
        }
      };
    }
    return { status: 200, body: { success: true, ok: true, to: maskEmailAddr(email), expiresIn: 600, attemptsLeft: 6 } };
  }
  /* Verify a code from D1, mark the account verified and create a session.
     Only D1 + the Worker are involved — the frontend never needs an email
     server connection to complete verification. */
  async confirmEmailCode(rawEmail, rawCode) {
    const email = String(rawEmail || "").trim().toLowerCase();
    let code = String(rawCode == null ? "" : rawCode);
    try { code = code.normalize("NFKC"); } catch (e) {}
    code = code.replace(/[^0-9]/g, "").slice(0, 6);
    if (!email || code.length !== 6)
      return { status: 400, body: { success: false, ok: false, error: "invalid", message: "Enter the 6-digit code from the email" } };
    if (!this.env || !this.env.DB)
      return { status: 503, body: { success: false, ok: false, error: "database_unavailable" } };
    let row = null;
    try {
      await this.env.DB.prepare("CREATE TABLE IF NOT EXISTS email_codes (email TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0)").run();
      row = await this.env.DB.prepare("SELECT email, code, expires_at, attempts FROM email_codes WHERE email = ? AND code = ? AND expires_at > ?").bind(email, code, Date.now()).first();
    } catch (e) {
      console.error("[email] code read failed: " + e.message);
      return { status: 500, body: { success: false, ok: false, error: "code_store_failed" } };
    }
    if (!row) {
      try {
        await this.env.DB.prepare("UPDATE email_codes SET attempts = COALESCE(attempts, 0) + 1 WHERE email = ?").bind(email).run();
      } catch (e) {}
      return { status: 400, body: { success: false, ok: false, error: "invalid", message: "That code is not correct" } };
    }
    try {
      await this.env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
    } catch (e) {}
    const now = Date.now();
    let user = null;
    if (this.db && Array.isArray(this.db.users))
      user = this.db.users.find((u) => u && String(u.email || "").trim().toLowerCase() === email) || null;
    let d1row = null;
    try {
      d1row = await this.env.DB.prepare("SELECT id, name, email, username, data FROM users WHERE lower(email) = ?").bind(email).first();
    } catch (e) {}
    if (!user && d1row) {
      let extra = {};
      try { extra = JSON.parse(d1row.data || "{}") || {}; } catch (e) {}
      user = Object.assign({ id: d1row.id, name: d1row.name, email: d1row.email, username: d1row.username }, extra);
      if (this.db && Array.isArray(this.db.users))
        this.db.users.push(user);
    }
    const userId = (user && user.id) || (d1row && d1row.id) || null;
    if (user) {
      user.verified = true;
      user.emailVerified = true;
      user.verifiedAt = now;
      user.verificationMethod = "email_code";
      delete user.emailVerifyRequired;
    }
    if (d1row) {
      let data = {};
      try { data = JSON.parse(d1row.data || "{}") || {}; } catch (e) {}
      data.verified = true;
      data.emailVerified = true;
      data.verifiedAt = now;
      data.verificationMethod = "email_code";
      delete data.emailVerifyRequired;
      try {
        await this.env.DB.prepare("UPDATE users SET data = ? WHERE id = ?").bind(JSON.stringify(data), d1row.id).run();
      } catch (e) {}
    }
    if (user) {
      this.rev += 1;
      this.updatedAt = now;
      this.scheduleSave();
    }
    const token = userId ? await this.createSession(userId) : null;
    return { status: 200, body: { success: true, ok: true, verified: true, verifiedAt: now, userId, username: user && user.username || "", role: user && user.role || "user", token } };
  }
  async fetch(request) {
    await this.ready;
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    const q = url.searchParams;
    const body = /* @__PURE__ */ __name(async () => {
      try {
        return await request.json();
      } catch (e) {
        return {};
      }
    }, "body");
    /* Session rooms were removed from the app. Old links and cached clients
       get a clean 404 instead of opening a room. */
    if (path === "/api/rooms" || path.indexOf("/api/rooms/") === 0)
      return json({ ok: false, error: "not_found", path }, 404);
    if (path === "/api/health") {
      let conns = {};
      try {
        conns = await this.loadConnections();
      } catch (e) {
      }
      const brevoConfigured = !!this.effectiveBrevoKey();
      return json({ ok: true, app: APP, version: VERSION, build: BUILD, uptimeSec: 0, rev: this.rev, users: this.db && this.db.users ? this.db.users.length : 0, clients: this.clients.size, push: false, publicUrl: (conns.app && conns.app.publicUrl) || null, appServers: ((conns.app && conns.app.servers) || []).length, storage: this.env.DB ? "d1+durable-object" : "durable-object", d1: this.env.DB ? "whalechat_db" : "unbound", email: brevoConfigured, emailProvider: brevoConfigured ? "brevo" : "none", brevoConfigured, market: { mode: "offline", source: "offline", marketOpen: true, alwaysOpen: true, tickers: 0 } });
    }
    /* ---- email verification: Brevo API only, codes in D1 -----------------
       No SMTP, no nodemailer and no "sync server" mail connection. These
       endpoints are the only path used by the Verify Email screen. */
    if (path === "/api/send-code" && request.method === "POST") {
      const b = await body();
      const r = await this.issueEmailCode(b && b.email);
      return json(r.body, r.status);
    }
    if (path === "/api/verify-code" && request.method === "POST") {
      const b = await body();
      const r = await this.confirmEmailCode(b && b.email, b && b.code);
      return json(r.body, r.status);
    }
    /* Legacy aliases kept so an installed app or cached page still verifies
       against the same D1 codes during the rollout. */
    if (path === "/api/verify/signup/send" && request.method === "POST") {
      const b = await body();
      const r = await this.issueEmailCode(b && b.email);
      return json(r.body, r.status);
    }
    if (path === "/api/verify/signup/confirm" && request.method === "POST") {
      const b = await body();
      const r = await this.confirmEmailCode(b && b.email, b && b.code);
      return json(r.body, r.status);
    }
    if (path === "/api/release")
      return json({ ok: true, version: VERSION, build: BUILD, users: this.db && this.db.users ? this.db.users.length : 0 });
    if (path === "/api/state" && request.method === "GET")
      return json({ rev: this.rev, db: this.db, updatedAt: this.updatedAt });
    if (path === "/api/state/init" && request.method === "POST") {
      if (this.db)
        return json({ ok: false, error: "already_initialised", rev: this.rev }, 409);
      const b = await body();
      if (!b || !b.db || !Array.isArray(b.db.users))
        return json({ ok: false, error: "invalid_db" }, 400);
      this.db = b.db;
      this.rev = Math.max(1, Number(b.rev) || 1);
      this.updatedAt = Date.now();
      this.scheduleSave();
      return json({ ok: true, rev: this.rev });
    }
    if (path === "/api/state/merge" && request.method === "POST") {
      if (!this.db)
        return json({ ok: false, error: "not_initialised" }, 409);
      const b = await body();
      const local = b && b.db;
      if (!local || !Array.isArray(local.users))
        return json({ ok: false, error: "invalid_db" }, 400);
      const added = {};
      COLLECTIONS.forEach((col) => {
        if (!Array.isArray(local[col]))
          return;
        if (!Array.isArray(this.db[col]))
          this.db[col] = [];
        const have = new Set(this.db[col].map((x) => x && x.id).filter(Boolean));
        let n = 0;
        local[col].forEach((item) => {
          if (!item || !item.id || have.has(item.id))
            return;
          this.db[col].push(item);
          have.add(item.id);
          n++;
        });
        if (n)
          added[col] = n;
      });
      ["settings", "chatsMeta", "presence"].forEach((key) => {
        if (!local[key] || typeof local[key] !== "object" || Array.isArray(local[key]))
          return;
        if (!this.db[key] || typeof this.db[key] !== "object")
          this.db[key] = {};
        Object.keys(local[key]).forEach((k) => {
          if (this.db[key][k] === void 0)
            this.db[key][k] = local[key][k];
        });
      });
      this.rev += 1;
      this.updatedAt = Date.now();
      await this.persistNow();
      return json({ ok: true, rev: this.rev, added, db: this.db });
    }
    if (path === "/api/ops" && request.method === "POST") {
      if (!this.db)
        return json({ ok: false, error: "not_initialised" }, 409);
      const b = await body();
      const result = this.applyOps(Array.isArray(b.ops) ? b.ops : []);
      this.rev += 1;
      this.updatedAt = Date.now();
      this.scheduleSave();
      const onlyMessages = Array.isArray(b.ops) && b.ops.length > 0 && b.ops.every((o) => o && o.col === "messages");
      this.broadcastAll("change", { rev: this.rev, source: b.clientId || null, at: this.updatedAt, messagesOnly: onlyMessages });
      if (onlyMessages) {
        result.pushes.forEach((p) => {
          const m = p.item;
          if (!m || !m.id || !m.chatId)
            return;
          this.d1TouchedMessages.add(m.id);
          this.broadcastTo([m.from, m.to].filter(Boolean), "message", { message: m, rev: this.rev, at: Date.now() });
          if (p.isNew && m.to && m.from !== m.to) {
            try {
              this.state.waitUntil(this.pushMessage(m));
            } catch (e) {
              this.pushMessage(m).catch(() => {
              });
            }
          }
        });
      }
      return json({ ok: true, rev: this.rev });
    }
    if (path === "/api/events" && request.method === "GET") {
      return this.events(request, String(q.get("user") || ""));
    }
    if (path === "/api/presence" && request.method === "POST") {
      const b = await body();
      const userId = String(b.userId || "");
      if (!userId)
        return json({ ok: false, error: "userId_required" }, 400);
      this.touchPresence(userId, { currentChatWith: b.currentChatWith == null ? void 0 : String(b.currentChatWith || ""), device: b.device == null ? void 0 : String(b.device || "").slice(0, 120), visible: b.visible === void 0 ? void 0 : !!b.visible });
      return json({ ok: true, presence: this.presenceView(userId), online: this.online(userId) });
    }
    if (path === "/api/presence/offline" && request.method === "POST") {
      const b = await body();
      if (b.userId)
        this.markOffline(String(b.userId));
      return json({ ok: true });
    }
    if (path === "/api/presence/state" && request.method === "GET") {
      const ids = String(q.get("users") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 200);
      const out = {};
      ids.forEach((id) => {
        out[id] = this.presenceView(id);
      });
      return json({ ok: true, at: Date.now(), presence: out });
    }
    if (path === "/api/typing" && request.method === "POST") {
      const b = await body();
      const userId = String(b.userId || "");
      const to = String(b.to || "");
      const chatId = String(b.chatId || "");
      if (!userId || !chatId)
        return json({ ok: false, error: "invalid_typing" }, 400);
      const payload = { chatId, from: userId, to, isTyping: !!b.isTyping, at: Date.now() };
      this.broadcastTo([to, userId].filter(Boolean), "typing", payload);
      return json({ ok: true, at: payload.at });
    }
    if (path === "/api/messages/send" && request.method === "POST") {
      if (!this.db)
        return json({ ok: false, error: "not_initialised" }, 409);
      const b = await body();
      const msg = b && b.message;
      if (!msg || !msg.id || !msg.chatId || !msg.from)
        return json({ ok: false, error: "invalid_message" }, 400);
      if (!Array.isArray(this.db.messages))
        this.db.messages = [];
      const existing = this.db.messages.find((m) => m && m.id === msg.id);
      if (existing)
        return json({ ok: true, duplicate: true, id: msg.id, rev: this.rev, status: existing.status || "sent" });
      const sender = (this.db.users || []).find((u) => u.id === msg.from);
      if (!sender)
        return json({ ok: false, error: "unknown_sender" }, 403);
      const clean = Object.assign({}, msg, { id: String(msg.id).slice(0, 120), chatId: String(msg.chatId).slice(0, 200), status: "sent", serverAt: Date.now(), deleted: false, readBy: Array.isArray(msg.readBy) ? msg.readBy : [] });
      delete clean.tempId;
      delete clean.queuedAt;
      delete clean.attempts;
      this.db.messages.push(clean);
      this.d1TouchedMessages.add(clean.id);
      if (clean.to && clean.from !== clean.to && this.online(clean.to)) {
        clean.status = "delivered";
        clean.deliveredAt = Date.now();
      }
      this.rev += 1;
      this.updatedAt = Date.now();
      this.scheduleSave();
      this.broadcastTo([clean.from, clean.to].filter(Boolean), "message", { message: clean, rev: this.rev, at: Date.now() });
      if (clean.status === "delivered")
        this.broadcastTo([clean.from], "delivered", { chatId: clean.chatId, userId: clean.to, ids: [clean.id], at: Date.now(), rev: this.rev });
      try {
        this.state.waitUntil(this.pushMessage(clean));
      } catch (e) {
        this.pushMessage(clean).catch(() => {
        });
      }
      return json({ ok: true, id: clean.id, rev: this.rev, status: clean.status });
    }
    if (path === "/api/messages/list" && request.method === "GET") {
      if (!this.db)
        return json({ ok: false, error: "not_initialised" }, 409);
      const chatId = String(q.get("chatId") || "");
      const userId = String(q.get("user") || "");
      const limit = Math.min(500, Math.max(1, Number(q.get("limit")) || 100));
      const since = Number(q.get("since")) || 0;
      let rows = (this.db.messages || []).filter((m) => m && (!chatId || m.chatId === chatId) && (Number(m.createdAt) || 0) > since);
      if (userId)
        rows = rows.filter((m) => m.from === userId || m.to === userId);
      rows = rows.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
      return json({ ok: true, at: Date.now(), rev: this.rev, messages: rows.slice(-limit) });
    }
    if (path === "/api/messages/ack" && request.method === "POST") {
      if (!this.db)
        return json({ ok: false, error: "not_initialised" }, 409);
      const b = await body();
      const chatId = String(b.chatId || "");
      const userId = String(b.userId || "");
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
      const kind = b.kind === "read" ? "read" : "delivered";
      if (!chatId || !userId)
        return json({ ok: false, error: "invalid_ack" }, 400);
      const changed = [];
      (this.db.messages || []).forEach((m) => {
        if (!m || m.chatId !== chatId || !ids.includes(m.id))
          return;
        if (kind === "read") {
          m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
          if (!m.readBy.includes(userId))
            m.readBy.push(userId);
          if (m.to === userId)
            m.status = "seen";
          m.seenAt = m.seenAt || Date.now();
        } else if (m.status !== "seen") {
          m.status = "delivered";
          m.deliveredAt = m.deliveredAt || Date.now();
        }
        changed.push(m);
      });
      if (!changed.length)
        return json({ ok: true, changed: 0 });
      changed.forEach((m) => this.d1TouchedMessages.add(m.id));
      this.rev += 1;
      this.updatedAt = Date.now();
      this.scheduleSave();
      const targets = /* @__PURE__ */ new Set();
      changed.forEach((m) => {
        if (m.from !== userId)
          targets.add(m.from);
      });
      this.broadcastTo([...targets], kind === "read" ? "read" : "delivered", { chatId, userId, ids: changed.map((m) => m.id), at: Date.now(), rev: this.rev });
      return json({ ok: true, changed: changed.length, rev: this.rev });
    }
    if (path === "/api/rooms/create" && request.method === "POST") {
      if (!this.db)
        return json({ ok: false, error: "not_initialised" }, 409);
      const b = await body();
      const userId = String(b.userId || "");
      if (!userId)
        return json({ ok: false, error: "userId_required" }, 400);
      const known = new Set((this.db.users || []).map((u) => u && u.id));
      if (!known.has(userId))
        return json({ ok: false, error: "unknown_user" }, 403);
      const members = /* @__PURE__ */ new Set([userId]);
      (Array.isArray(b.members) ? b.members : []).forEach((id) => {
        if (id && known.has(String(id)))
          members.add(String(id));
      });
      let room = b.code ? this.roomByCode(b.code) : null;
      if (room && !room.members.includes(userId))
        return json({ ok: false, error: "not_a_member" }, 403);
      if (room)
        members.forEach((id) => {
          if (!room.members.includes(id))
            room.members.push(id);
        });
      else {
        room = { code: b.code ? String(b.code).toUpperCase() : this.code(), name: String(b.name || "Internet session").slice(0, 60), ownerId: userId, members: [...members], messages: [], createdAt: Date.now(), updatedAt: Date.now() };
        this.rooms().push(room);
      }
      room.updatedAt = Date.now();
      this.rev += 1;
      this.updatedAt = Date.now();
      this.scheduleSave();
      const view = this.roomView(room);
      room.members.forEach((id) => {
        this.broadcastTo([id], "room-invite", { room: view, at: Date.now(), rev: this.rev });
        this.broadcastPresence(id);
      });
      return json({ ok: true, room: view });
    }
    if (path === "/api/rooms/join" && request.method === "POST") {
      const b = await body();
      const userId = String(b.userId || "");
      const room = this.roomByCode(b.code);
      if (!userId)
        return json({ ok: false, error: "userId_required" }, 400);
      if (!room)
        return json({ ok: false, error: "room_not_found" }, 404);
      if (!room.members.includes(userId)) {
        room.members.push(userId);
        room.updatedAt = Date.now();
        this.rev += 1;
        this.updatedAt = Date.now();
        this.scheduleSave();
        this.roomBroadcast(room, "room-update", { room: this.roomView(room), at: Date.now() });
        this.broadcastTo([userId], "room-invite", { room: this.roomView(room), at: Date.now(), rev: this.rev });
        room.members.forEach((id) => this.broadcastPresence(id));
      }
      return json({ ok: true, room: this.roomView(room), messages: (room.messages || []).slice(-200) });
    }
    if (path === "/api/rooms/list" && request.method === "GET") {
      const userId = String(q.get("user") || "");
      const rooms = this.rooms().filter((r) => r && Array.isArray(r.members) && r.members.includes(userId)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50).map((r) => Object.assign(this.roomView(r), { last: (r.messages || [])[(r.messages || []).length - 1] || null }));
      return json({ ok: true, rooms });
    }
    if (path === "/api/rooms/get" && request.method === "GET") {
      const userId = String(q.get("user") || "");
      const room = this.roomByCode(q.get("code"));
      if (!room)
        return json({ ok: false, error: "room_not_found" }, 404);
      if (!room.members.includes(userId))
        return json({ ok: false, error: "not_a_member" }, 403);
      const presence = {};
      room.members.forEach((id) => {
        presence[id] = this.presenceView(id);
      });
      return json({ ok: true, room: this.roomView(room), messages: (room.messages || []).slice(-200), presence, at: Date.now() });
    }
    if (path === "/api/rooms/message" && request.method === "POST") {
      const b = await body();
      const userId = String(b.userId || "");
      const room = this.roomByCode(b.code);
      if (!userId)
        return json({ ok: false, error: "userId_required" }, 400);
      if (!room)
        return json({ ok: false, error: "room_not_found" }, 404);
      if (!room.members.includes(userId))
        return json({ ok: false, error: "not_a_member" }, 403);
      if (!Array.isArray(room.messages))
        room.messages = [];
      const msg = { id: String(b.id || "").slice(0, 120) || "rm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), from: userId, text: String(b.text || "").slice(0, 4e3), createdAt: Number(b.createdAt) || Date.now(), status: "sent", readBy: [], deliveredTo: [] };
      const existing = room.messages.find((m) => m && m.id === msg.id);
      if (!existing) {
        room.members.forEach((id) => {
          if (id !== userId && this.online(id))
            msg.deliveredTo.push(id);
        });
        if (msg.deliveredTo.length)
          msg.status = "delivered";
        room.messages.push(msg);
        if (room.messages.length > 2e3)
          room.messages = room.messages.slice(-2e3);
        room.updatedAt = Date.now();
        this.rev += 1;
        this.updatedAt = Date.now();
        this.scheduleSave();
        this.roomBroadcast(room, "room-message", { code: room.code, message: msg, at: Date.now(), rev: this.rev });
        try {
          this.state.waitUntil(this.pushRoomMessage(room, msg));
        } catch (e) {
          this.pushRoomMessage(room, msg).catch(() => {
          });
        }
      }
      return json({ ok: true, id: msg.id, message: existing || msg, rev: this.rev });
    }
    /* ---- offline / room sync -------------------------------------------
       Pulls only the *other* member's messages into this user's chat and
       accepts this device's queued messages in the same round trip. This is
       the webhook the offline outbox drains through: A's messages come back
       to B and B's messages come back to A, never a member's own copy.
    ------------------------------------------------------------------- */
    const memberRoom = (code, userId) => {
      const room2 = this.roomByCode(code);
      if (!room2)
        return { error: json({ ok: false, error: "room_not_found" }, 404) };
      if (!userId || !room2.members.includes(userId))
        return { error: json({ ok: false, error: "not_a_member" }, 403) };
      return { room: room2 };
    };
    const pullFor = (room2, userId, since, limit) => {
      const after = Number(since) || 0;
      const list = (room2.messages || []).filter((m) => m && m.from !== userId && Number(m.createdAt || 0) > after);
      const msgs = list.slice(-Math.max(1, Math.min(Number(limit) || 200, 500)));
      let touched = false;
      msgs.forEach((m) => {
        if (!Array.isArray(m.deliveredTo))
          m.deliveredTo = [];
        if (!m.deliveredTo.includes(userId)) {
          m.deliveredTo.push(userId);
          touched = true;
        }
        if (m.from !== userId && m.status === "sent" && m.deliveredTo.length)
          m.status = "delivered";
      });
      if (touched) {
        this.rev += 1;
        this.updatedAt = Date.now();
        this.scheduleSave();
      }
      return msgs;
    };
    const ingestRoomMessage = (room2, userId, b) => {
      if (!Array.isArray(room2.messages))
        room2.messages = [];
      const msg = {
        id: String(b && b.id || "").slice(0, 120) || "rm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        from: userId,
        text: String(b && b.text || "").slice(0, 4e3),
        createdAt: Number(b && b.createdAt) || Date.now(),
        status: "sent",
        readBy: [],
        deliveredTo: []
      };
      const existing = room2.messages.find((m) => m && m.id === msg.id);
      if (existing)
        return { msg: existing, created: false };
      room2.members.forEach((id) => {
        if (id !== userId && this.online(id))
          msg.deliveredTo.push(id);
      });
      if (msg.deliveredTo.length)
        msg.status = "delivered";
      room2.messages.push(msg);
      if (room2.messages.length > 2e3)
        room2.messages = room2.messages.slice(-2e3);
      room2.updatedAt = Date.now();
      this.rev += 1;
      this.updatedAt = Date.now();
      this.scheduleSave();
      this.roomBroadcast(room2, "room-message", { code: room2.code, message: msg, at: Date.now(), rev: this.rev });
      try {
        this.state.waitUntil(this.pushRoomMessage(room2, msg));
      } catch (e) {
        this.pushRoomMessage(room2, msg).catch(() => {
        });
      }
      return { msg, created: true };
    };
    if (path === "/api/rooms/pull" && request.method === "GET") {
      const userId = String(q.get("user") || "");
      const got = memberRoom(q.get("code"), userId);
      if (got.error)
        return got.error;
      const since = Number(q.get("since")) || 0;
      const messages = pullFor(got.room, userId, since, q.get("limit"));
      return json({
        ok: true,
        code: got.room.code,
        rev: this.rev,
        serverTime: Date.now(),
        room: this.roomView(got.room),
        members: (got.room.members || []).slice(),
        messages
      });
    }
    if (path === "/api/rooms/sync" && request.method === "POST") {
      const b = await body();
      const userId = String(b && b.userId || "");
      const got = memberRoom(b && b.code, userId);
      if (got.error)
        return got.error;
      const room2 = got.room;
      const incoming = Array.isArray(b && b.outbox) ? b.outbox.slice(0, 50) : [];
      const accepted = [];
      for (const item of incoming) {
        const text = String(item && item.text || "").trim();
        if (!text)
          continue;
        const r = ingestRoomMessage(room2, userId, item);
        accepted.push(r.msg.id);
      }
      const since = Number(b && b.since) || 0;
      const messages = pullFor(room2, userId, since, b && b.limit);
      return json({
        ok: true,
        code: room2.code,
        rev: this.rev,
        serverTime: Date.now(),
        accepted,
        room: this.roomView(room2),
        members: (room2.members || []).slice(),
        messages
      });
    }
    if (path === "/api/rooms/read" && request.method === "POST") {
      const b = await body();
      const userId = String(b.userId || "");
      const room = this.roomByCode(b.code);
      if (!room || !room.members.includes(userId))
        return json({ ok: false, error: "not_a_member" }, 403);
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
      const changed = [];
      (room.messages || []).forEach((m) => {
        if (!m || !ids.includes(m.id) || m.from === userId)
          return;
        if (!Array.isArray(m.readBy))
          m.readBy = [];
        if (!m.readBy.includes(userId)) {
          m.readBy.push(userId);
          changed.push(m.id);
        }
      });
      if (changed.length) {
        this.rev += 1;
        this.updatedAt = Date.now();
        this.scheduleSave();
        this.roomBroadcast(room, "room-read", { code: room.code, userId, ids: changed, at: Date.now(), rev: this.rev });
      }
      return json({ ok: true, changed: changed.length });
    }
    if (path === "/api/rooms/typing" && request.method === "POST") {
      const b = await body();
      const userId = String(b.userId || "");
      const room = this.roomByCode(b.code);
      if (!room || !room.members.includes(userId))
        return json({ ok: false }, 200);
      this.roomBroadcast(room, "room-typing", { code: room.code, from: userId, isTyping: !!b.isTyping, at: Date.now() }, userId);
      return json({ ok: true, at: Date.now() });
    }
    if (path === "/api/verify/send" && request.method === "POST")
      return json({ ok: true, delivered: false, autoVerified: true });
    if (path === "/api/verify/check" && request.method === "POST")
      return json({ ok: true, verified: true });
    if (path === "/api/email/status") {
      try {
        await this.loadConnections();
      } catch (e) {
      }
      const configured = !!this.effectiveBrevoKey();
      return json({ ok: true, configured, provider: configured ? "brevo" : "none", from: this.effectiveBrevoSender().email, host: "api.brevo.com", port: 443, queued: 0, sent: 0, lastError: "" });
    }
    if (path.startsWith("/api/email/"))
      return json({ ok: false, error: "email_not_configured" }, 200);
    if (path === "/api/connections")
      return await this.handleConnections(request, url, body);
    if (path === "/api/connections/test" && request.method === "POST")
      return await this.handleConnectionTest(request, url, body);
    if (path === "/api/signup" && request.method === "POST") {
      if (!this.env.DB)
        return json({ ok: false, error: "database_unavailable" }, 503);
      const b = await body();
      const name = String(b.name || "").trim();
      const email = String(b.email || "").trim().toLowerCase();
      const password = String(b.password || "");
      const phone = String(b.phone || "").trim();
      if (!name || !email || !password)
        return json({ ok: false, error: "missing_fields", message: "Name, email and password are required" }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
        return json({ ok: false, error: "bad_email", message: "Enter a valid email" }, 400);
      if (password.length < 6)
        return json({ ok: false, error: "weak_password", message: "Password must be at least 6 characters" }, 400);
      const exists = await this.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (exists)
        return json({ ok: false, error: "email_exists", message: "An account with this email already exists" }, 400);
      const id = String(b.id || crypto.randomUUID());
      const username = String(b.username || email.split("@")[0]).slice(0, 30);
      const hash = await this.hashPassword(password);
      const createdAt = Date.now();
      const appUser = Object.assign({}, b.data && typeof b.data === "object" ? b.data : {}, {
        id,
        fullName: name,
        username,
        email,
        phone,
        role: "user",
        createdAt,
        verified: true,
        emailVerified: true
      });
      try {
        await this.env.DB.prepare("INSERT INTO users (id, name, email, password_hash, phone, avatar, created_at, last_seen, username, data) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id, name, email, hash, phone || null, appUser.avatar || null, createdAt, createdAt, username, JSON.stringify(appUser)).run();
      } catch (e) {
        return json({ ok: false, error: "email_exists", message: e.message }, 400);
      }
      if (!Array.isArray(this.db.users))
        this.db.users = [];
      const i = this.db.users.findIndex((u) => u && u.id === id);
      if (i >= 0)
        this.db.users[i] = Object.assign({}, this.db.users[i], appUser);
      else
        this.db.users.push(appUser);
      this.rev += 1;
      this.updatedAt = Date.now();
      this.scheduleSave();
      const token = await this.createSession(id);
      return json({ ok: true, user: this.safeUser(appUser), token });
    }
    if (path === "/api/login" && request.method === "POST") {
      if (!this.env.DB)
        return json({ ok: false, error: "database_unavailable" }, 503);
      const b = await body();
      const email = String(b.email || b.username || "").trim().toLowerCase();
      const password = String(b.password || "");
      if (!email || !password)
        return json({ ok: false, error: "missing_fields" }, 400);
      const row = await this.env.DB.prepare("SELECT * FROM users WHERE lower(email) = ?").bind(email).first();
      if (!row)
        return json({ ok: false, error: "invalid_credentials", message: "No account found with those details" }, 401);
      const hash = await this.hashPassword(password);
      if (row.password_hash !== hash)
        return json({ ok: false, error: "invalid_credentials", message: "Incorrect password" }, 401);
      const user = this.d1UserToApp(row);
      try {
        await this.env.DB.prepare("UPDATE users SET last_seen = ? WHERE id = ?").bind(Date.now(), row.id).run();
      } catch (e) {
      }
      const token = await this.createSession(row.id);
      return json({ ok: true, user: this.safeUser(row), token });
    }
    if (path === "/api/login/local" && request.method === "POST") {
      if (!this.env.DB)
        return json({ ok: false, error: "database_unavailable" }, 503);
      const b = await body();
      const email = String(b.email || "").trim().toLowerCase();
      const passHash = String(b.passHash || "");
      if (!email || !passHash)
        return json({ ok: false, error: "missing_fields" }, 400);
      const row = await this.env.DB.prepare("SELECT * FROM users WHERE lower(email) = ?").bind(email).first();
      if (!row)
        return json({ ok: false, error: "invalid_credentials" }, 401);
      let data = {};
      try {
        data = row.data ? JSON.parse(row.data) : {};
      } catch (e) {
      }
      if (!data.pass || data.pass !== passHash)
        return json({ ok: false, error: "invalid_credentials" }, 401);
      const user = this.d1UserToApp(row);
      const token = await this.createSession(row.id);
      return json({ ok: true, user: this.safeUser(row), token });
    }
    if (path === "/api/me" && request.method === "GET") {
      const row = await this.authUser(request);
      if (!row)
        return json({ ok: false, error: "unauthorized" }, 401);
      return json({ ok: true, user: this.safeUser(row) });
    }
    if (path === "/api/users" && request.method === "GET") {
      const row = await this.authUser(request);
      if (!row)
        return json({ ok: false, error: "unauthorized" }, 401);
      const list = await this.env.DB.prepare("SELECT id, name, email, avatar, last_seen, username, data FROM users ORDER BY created_at DESC LIMIT 500").all();
      return json({ ok: true, users: (list.results || []).map((u) => this.safeUser(u)) });
    }
    if (path === "/api/logout" && request.method === "POST") {
      const raw = request.headers.get("authorization") || "";
      const token = raw.replace(/^Bearer\s+/i, "").trim();
      if (token && this.env.DB) {
        try {
          await this.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        } catch (e) {
        }
      }
      return json({ ok: true });
    }
    if (path === "/api/upload" && request.method === "POST") {
      let userId = "";
      const authRow = await this.authUser(request);
      if (authRow)
        userId = authRow.id;
      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return json({ ok: false, error: "invalid_form" }, 400);
      }
      const file = form.get("file");
      if (!file || typeof file === "string")
        return json({ ok: false, error: "file_required" }, 400);
      if (!userId)
        userId = String(form.get("userId") || "");
      if (!userId)
        return json({ ok: false, error: "unauthorized" }, 401);
      if (!this.db.users.some((u) => u && u.id === userId))
        return json({ ok: false, error: "unknown_user" }, 403);
      const safeName = String(file.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
      const key = userId + "/" + Date.now() + "-" + safeName;
      const type = file.type || "application/octet-stream";
      const size = Number(file.size) || 0;
      if (size > 25 * 1024 * 1024)
        return json({ ok: false, error: "too_large", message: "Files up to 25 MB" }, 413);
      let storage = "d1";
      try {
        if (this.env.FILES) {
          await this.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: type } });
          storage = "r2";
        } else {
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 32768)
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
          const b64 = btoa(bin);
          await this.env.DB.prepare("INSERT INTO files (key, user_id, content_type, size, data, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").bind(key, userId, type, size, b64, Date.now()).run();
        }
      } catch (e) {
        return json({ ok: false, error: "upload_failed", message: e.message }, 500);
      }
      const origin = new URL(request.url).origin;
      return json({ ok: true, key, url: origin + "/api/file/" + encodeURIComponent(key), type, size, storage });
    }
    if (path.startsWith("/api/file/") && request.method === "GET") {
      const key = decodeURIComponent(path.slice("/api/file/".length));
      if (!key)
        return json({ ok: false, error: "key_required" }, 400);
      try {
        if (this.env.FILES) {
          const obj = await this.env.FILES.get(key);
          if (obj) {
            const headers = new Headers(CORS);
            headers.set("content-type", obj.httpMetadata && obj.httpMetadata.contentType || "application/octet-stream");
            headers.set("cache-control", "public, max-age=31536000, immutable");
            return new Response(obj.body, { headers });
          }
        }
        if (this.env.DB) {
          const row = await this.env.DB.prepare("SELECT content_type, data FROM files WHERE key = ?").bind(key).first();
          if (row && row.data) {
            const bin = atob(row.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++)
              bytes[i] = bin.charCodeAt(i);
            return new Response(bytes, { headers: Object.assign({ "content-type": row.content_type || "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" }, CORS) });
          }
        }
      } catch (e) {
      }
      return json({ ok: false, error: "not_found" }, 404);
    }
    if (path === "/api/email/status" && request.method === "GET") {
      try {
        await this.loadConnections();
      } catch (e) {
      }
      const sender = this.effectiveBrevoSender();
      return json({ ok: true, configured: !!this.effectiveBrevoKey(), provider: "brevo", from: sender.email });
    }
    if ((path === "/api/email/broadcast" || path === "/api/email/test") && request.method === "POST") {
      try {
        await this.loadConnections();
      } catch (e) {
      }
      const brevoKey = this.effectiveBrevoKey();
      if (!brevoKey)
        return json({ ok: false, error: "email_not_configured", message: "Connect the email server in Admin → Servers & API" }, 503);
      const b = await body();
      const adminId = String(b.adminId || "");
      const adminRow = await this.authUser(request);
      const admin = adminRow || (this.db.users || []).find((u) => u && u.id === adminId && u.role === "admin");
      if (!admin)
        return json({ ok: false, error: "admin_only" }, 403);
      let recipients = [];
      if (path === "/api/email/test") {
        const to = String(b.to || "").trim();
        if (!to)
          return json({ ok: false, error: "to_required" }, 400);
        recipients = [{ email: to, name: "WhaleChat test" }];
      } else {
        const ids = Array.isArray(b.userIds) ? b.userIds.map(String) : [];
        const users = (this.db.users || []).filter((u) => u && u.email && (b.all === true || ids.includes(String(u.id))));
        recipients = users.map((u) => ({ email: u.email, name: u.fullName || u.username || "" }));
      }
      recipients = recipients.filter((r, i, a) => r.email && a.findIndex((x) => String(x.email).toLowerCase() === String(r.email).toLowerCase()) === i);
      if (!recipients.length)
        return json({ ok: false, error: "no_recipients" }, 400);
      const subject = String(b.subject || "A message from WhaleChat").slice(0, 180);
      const html = String(b.html || "<p>" + String(b.text || "").replace(/</g, "&lt;") + "</p>");
      const sender = this.effectiveBrevoSender();
      let sent = 0;
      const errors = [];
      for (let i = 0; i < recipients.length; i += 40) {
        const chunk = recipients.slice(i, i + 40);
        try {
          const res = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "api-key": brevoKey, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ sender, to: [{ email: sender.email, name: sender.name }], bcc: chunk, subject, htmlContent: html })
          });
          if (res.ok)
            sent += chunk.length;
          else
            errors.push("Brevo " + res.status + ": " + (await res.text()).slice(0, 160));
        } catch (e) {
          errors.push(e.message);
        }
      }
      if (path === "/api/email/broadcast" && this.db) {
        if (!Array.isArray(this.db.emailCampaigns))
          this.db.emailCampaigns = [];
        this.db.emailCampaigns.unshift({ id: "ec_" + Date.now().toString(36), subject, recipients: recipients.length, queued: sent, by: admin.id, createdAt: Date.now(), failed: errors.length });
        this.db.emailCampaigns = this.db.emailCampaigns.slice(0, 100);
        this.rev += 1;
        this.updatedAt = Date.now();
        this.scheduleSave();
      }
      return json({ ok: sent > 0, recipients: recipients.length, sent, failed: errors.length, errors: errors.slice(0, 5) });
    }
    if (path === "/api/push/key" && request.method === "GET") {
      const v = await this.ensureVapid();
      return json({ ok: true, publicKey: v.pub });
    }
    if (path === "/api/push/subscribe" && request.method === "POST") {
      if (!this.db)
        return json({ ok: false, error: "not_initialised" }, 409);
      const b = await body();
      const userId = String(b.userId || "");
      const sub = b.subscription || {};
      if (!userId || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
        return json({ ok: false, error: "invalid_subscription" }, 400);
      if (!Array.isArray(this.db.pushSubscriptions))
        this.db.pushSubscriptions = [];
      this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => s && s.endpoint !== sub.endpoint);
      this.db.pushSubscriptions.push({ userId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: String(b.device || "").slice(0, 180), at: Date.now() });
      const own = this.db.pushSubscriptions.filter((s) => s.userId === userId);
      if (own.length > 10) {
        const drop = new Set(own.sort((a, c) => (a.at || 0) - (c.at || 0)).slice(0, own.length - 10).map((s) => s.endpoint));
        this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => !drop.has(s.endpoint));
      }
      this.scheduleSave();
      return json({ ok: true, devices: this.db.pushSubscriptions.filter((s) => s.userId === userId).length, publicKey: (await this.ensureVapid()).pub });
    }
    if (path === "/api/push/unsubscribe" && request.method === "POST") {
      const b = await body();
      if (this.db && Array.isArray(this.db.pushSubscriptions)) {
        this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => s && s.endpoint !== (b.endpoint || ""));
        this.scheduleSave();
      }
      return json({ ok: true });
    }
    if (path === "/api/push/status" && request.method === "GET") {
      const userId = String(q.get("user") || "");
      const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s.userId === userId);
      return json({ ok: true, devices: subs.length, publicKey: (await this.ensureVapid()).pub });
    }
    if (path === "/api/push/test" && request.method === "POST") {
      const b = await body();
      const userId = String(b.userId || "");
      const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s.userId === userId);
      if (!subs.length)
        return json({ ok: false, sent: 0, error: "no_device" });
      let sent = 0;
      for (const sub of subs) {
        const r = await this.sendPushTo(sub, { title: b.title || "WhaleChat", body: b.body || "Push notifications are working \u{1F40B}", link: b.link || "#/notifications", tag: "wc-test", icon: "./assets/logo-192.png", badge: "./assets/badge-72.png", renotify: true, ts: Date.now() });
        if (r === true)
          sent++;
      }
      return json({ ok: sent > 0, sent });
    }
    if (path === "/api/market/quotes" && request.method === "GET") {
      if (!this.marketAt || Date.now() - this.marketAt > 3e4) {
        try {
          await this.refreshMarket();
        } catch (e) {
        }
      }
      return json(this.marketSnapshot());
    }
    if (path === "/api/market/status" && request.method === "GET")
      return json(Object.assign({ ok: true }, this.marketStatus()));
    if (path === "/api/market/history" && request.method === "GET") {
      const raw = String(q.get("tickers") || q.get("ticker") || "").toUpperCase();
      const tickers = raw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 40);
      const limit = Number(q.get("limit")) || 240;
      const history = await this.historyFor(tickers, limit);
      return json({ ok: true, at: Date.now(), source: "live", notice: this.marketStatus().notice, status: this.marketStatus(), history });
    }
    if (path === "/api/market/stream" && request.method === "GET") {
      return this.marketStream(request);
    }
    if (path === "/api/bots/state")
      return json({ ok: true, bots: [], enabled: false });
    if (path === "/api/shares/state")
      return json({ ok: true, shares: [], enabled: false });
    return json({ ok: false, error: "not_found", path }, 404);
  }
  marketStream(request) {
    const id = "m_" + Math.random().toString(36).slice(2);
    let controller;
    const stream = new ReadableStream({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        this.marketClients.delete(id);
      }
    });
    this.marketClients.set(id, controller);
    try {
      controller.enqueue(enc.encode("retry: 5000\n\n"));
      controller.enqueue(enc.encode(frameOf("status", { source: "live", notice: this.marketStatus().notice, status: this.marketStatus() })));
      if (this.quotes && Object.keys(this.quotes).length && Date.now() - this.marketAt < 6e4) {
        controller.enqueue(enc.encode(frameOf("snapshot", this.marketSnapshot())));
      }
    } catch (e) {
    }
    const go = /* @__PURE__ */ __name(() => {
      this.refreshMarket().catch(() => {
      });
    }, "go");
    if (!this.marketAt || Date.now() - this.marketAt > 3e4)
      go();
    else
      setTimeout(go, Math.max(1e3, 3e4 - (Date.now() - this.marketAt)));
    if (request.signal)
      request.signal.addEventListener("abort", () => this.marketClients.delete(id));
    return new Response(stream, { headers: Object.assign({ "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" }, CORS) });
  }
  events(request, userId) {
    const id = "c_" + Math.random().toString(36).slice(2);
    let controller;
    const stream = new ReadableStream({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        this.clients.delete(id);
        if (userId && this.countSockets(userId) === 0)
          this.markOffline(userId);
      }
    });
    this.clients.set(id, { user: userId, controller, at: Date.now() });
    if (userId) {
      const snap = {};
      this.presenceAudience(userId).forEach((uid) => {
        snap[uid] = this.presenceView(uid);
      });
      try {
        controller.enqueue(enc.encode("retry: 1500\n\n"));
        controller.enqueue(enc.encode(frameOf("hello", { rev: this.rev, at: Date.now() })));
        controller.enqueue(enc.encode(frameOf("presence-snapshot", { at: Date.now(), presence: snap })));
      } catch (e) {
      }
      this.touchPresence(userId, { visible: true });
      this.markDelivered(userId);
    }
    if (request.signal)
      request.signal.addEventListener("abort", () => {
        this.clients.delete(id);
        if (userId && this.countSockets(userId) === 0)
          this.markOffline(userId);
      });
    return new Response(stream, { headers: Object.assign({ "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" }, CORS) });
  }
};
__name(ChatHub, "ChatHub");
var src_default = {
  async fetch(request, env3) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health")
      return json({ ok: true, app: APP, version: VERSION });
    const id = env3.CHAT_HUB.idFromName(DO_NAME);
    return env3.CHAT_HUB.get(id).fetch(request);
  }
};
export {
  ChatHub,
  src_default as default
};
//# sourceMappingURL=index.js.map
