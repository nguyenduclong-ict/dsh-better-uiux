/**
 * dsh-better-uiux — host half.
 *
 * ONE Settings surface ("Better UIUX") for three previously separate features:
 *
 *   1. Live terminal output — ported from `dsh-plugin-live-terminal`. Streams
 *      foreground command output and background job output into the transcript.
 *   2. Custom CSS — ported from `dsh-plugin-custom-css`. Injects a user snippet
 *      into the Web GUI's <head>.
 *   3. Edit message — temporarily HIDDEN (see `EDIT_MESSAGE_HIDDEN`). The code
 *      stays in the bundle for a later release, but the flag can never be on:
 *      the browser half renders no switch for it and this half clamps it to
 *      `false`, so neither the GUI nor a hand-edited config.json can enable it.
 *
 * Because DSH is expected to grow native live-terminal support, every feature
 * can be switched off independently in the GUI. The switch is durable (shared by
 * every window) and the host half honours it: HTTP routes report `enabled:false`
 * and the subprocess/jobs interception is skipped entirely while a feature is
 * off, so a disabled feature costs nothing.
 *
 * Storage: `$DSH_HOME|~/.dsh` + `/plugins/dsh-better-uiux/config.json`.
 * Resolved from the *installed* location on purpose: `pnpm add <local path>`
 * links this package, so anything derived from `import.meta.url` would point
 * back into the plugin's source checkout.
 *
 * HTTP surface (registered on the Harness web server):
 *   GET  /api/better-uiux/config  -> { features, css }
 *   POST /api/better-uiux/config  <- { features?: {...}, css?: string }
 *   GET  /api/better-uiux/jobs    -> { success, enabled, jobs }
 *   GET  /api/better-uiux/output  -> live output for one job / process
 *   GET  /api/better-uiux/stop    -> stop a job, a process, or a pending wait
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-better-uiux';
export const inject = ['webServer', 'subprocess'];

const PLUGIN_ID = 'dsh-better-uiux';

/** Largest accepted request body (a CSS snippet; 1 MiB is far beyond any sane theme). */
const MAX_BODY_BYTES = 1024 * 1024;

/** Route prefix shared by every endpoint of this plugin. */
const API = '/api/better-uiux';

/**
 * TEMPORARILY HIDDEN FEATURE — Edit message.
 *
 * The browser half still contains the implementation, but the feature is closed
 * on both ends: no switch renders in Settings, and this half forces the stored
 * flag to `false` on every read and every write, so a stale `config.json` (or a
 * hand-crafted POST) cannot turn it back on. Flip this to `false` to re-enable —
 * together with the matching constant in `core.js`.
 */
const EDIT_MESSAGE_HIDDEN = true;

/**
 * Feature flags. `liveTerminal` and `customCss` default to ON so a fresh install is
 * immediately useful (each is switched off in Settings — in particular the live
 * terminal, once DSH ships that natively).
 *
 * `editMessage` defaults to OFF on purpose: editing a message cannot rewrite it in
 * place, so the feature necessarily branches the session. Until that behaviour is
 * settled it stays opt-in rather than surprising anyone who never asked for it.
 * It is also hidden while `EDIT_MESSAGE_HIDDEN` is true.
 */
const DEFAULT_FEATURES = Object.freeze({
  /** Live terminal output streaming (ported live-terminal). */
  liveTerminal: true,
  /** Custom CSS injection (ported custom-css). */
  customCss: true,
  /** Edit-and-resend for messages already in the transcript. */
  editMessage: false
});

// ---------------------------------------------------------------------------
// Durable configuration
// ---------------------------------------------------------------------------

/**
 * Resolve the durable store directory: `$DSH_HOME|~/.dsh` + `/plugins/<id>`.
 * @returns {string} absolute directory that holds `config.json`.
 */
function resolveStoreDir() {
  let home = '';
  try {
    const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    home = fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), '.dsh');
  } catch {
    home = '';
  }
  return path.join(home.length > 0 ? home : os.tmpdir(), 'plugins', PLUGIN_ID);
}

const STORE_DIR = resolveStoreDir();
const CONFIG_FILE = path.join(STORE_DIR, 'config.json');

/** Coerce any stored/supplied payload into the persisted shape. */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const features = source.features !== null && typeof source.features === 'object' ? source.features : {};
  // Every flag falls back to DEFAULT_FEATURES, so an absent key means "on" (the
  // shipped default) and only an explicit `false` switches a feature off. A
  // strict `=== true` here would silently force every default to off.
  const resolved = {};
  for (const key of Object.keys(DEFAULT_FEATURES)) {
    resolved[key] = typeof features[key] === 'boolean' ? features[key] : DEFAULT_FEATURES[key];
  }
  // While the feature is hidden the stored value is ignored rather than trusted:
  // a config.json written by an earlier build (or edited by hand) must not be able
  // to switch Edit message back on.
  if (EDIT_MESSAGE_HIDDEN) resolved.editMessage = false;
  return {
    features: resolved,
    css: typeof source.css === 'string' ? source.css : ''
  };
}

const EMPTY_CONFIG = normalizeConfig({});

/** Normalized in-memory mirror of the persisted config. */
let currentConfig = { ...EMPTY_CONFIG, features: { ...EMPTY_CONFIG.features } };

/** Read the persisted config; never throws (a broken file falls back to defaults). */
function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return normalizeConfig({});
    // Strip a UTF-8 BOM: an editor (or PowerShell's Set-Content) adds one, and
    // JSON.parse rejects it — which would silently reset every switch.
    const text = fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '');
    return normalizeConfig(JSON.parse(text));
  } catch (error) {
    console.warn('[better-uiux] Failed to read config file:', error?.message ?? error);
    return normalizeConfig({});
  }
}

/** Persist `currentConfig` atomically-ish; returns whether the write succeeded. */
function writeConfigFile() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const temp = `${CONFIG_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(currentConfig, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, CONFIG_FILE);
    return true;
  } catch (error) {
    console.warn('[better-uiux] Failed to write config file:', error?.message ?? error);
    return false;
  }
}

currentConfig = readConfigFile();

/**
 * Read one feature flag.
 * @param {keyof DEFAULT_FEATURES} key - feature name.
 * @returns {boolean} whether the feature is switched on right now.
 */
function featureOn(key) {
  return currentConfig.features[key] === true;
}

// ---------------------------------------------------------------------------
// Live terminal state (ported from dsh-plugin-live-terminal)
// ---------------------------------------------------------------------------

// Map of active process outputs for foreground commands:
// id -> { id, callId, jobId, pid, handle, sessionId, cwd, command, output, active, startedAt, lastUpdated, finishedAt }
const activeProcesses = new Map();

// Map of background job buffers: jobId -> accumulated output string
const backgroundJobBuffers = new Map();
let jobsRegistry = null;

// Map of in-flight `job_output` calls waiting on a job (wait: true):
// callId -> { callId, jobId, sessionId, startedAt, controller }
// Aborting one of these controllers ends ONLY that waiting tool call; the
// background job it waits on keeps running (route `/stop?mode=wait`).
const pendingWaits = new Map();

/** Resolve one pending wait by tool call id first, then by awaited job id. */
function findPendingWait(callId, jobId) {
  if (callId) {
    const wanted = String(callId);
    const direct = pendingWaits.get(wanted);
    if (direct) return direct;
    for (const entry of pendingWaits.values()) {
      if (entry.callId === wanted) return entry;
    }
  }
  if (jobId) {
    const wanted = String(jobId);
    for (const entry of pendingWaits.values()) {
      if (entry.jobId === wanted) return entry;
    }
  }
  return null;
}

/** Public job snapshot shape accepted by the `job_output` output schema. */
function jobSnapshotForValue(jobId) {
  const store = jobsRegistry?.store;
  if (!store || !jobId) return null;

  let job = store.get(jobId);
  if (!job) {
    for (const [id, candidate] of store.entries()) {
      if (String(id) === String(jobId)) {
        job = candidate;
        break;
      }
    }
  }
  if (!job) return null;

  const snapshot = {
    id: String(job.id ?? jobId),
    kind: typeof job.kind === 'string' && job.kind ? job.kind : 'job',
    label: typeof job.label === 'string' ? job.label : '',
    // Constrained to the `job_output` schema enum: an unexpected producer value
    // must not fail output validation and turn this into an error result.
    status: ['running', 'stopping', 'completed', 'killed', 'failed'].includes(job.status) ? job.status : 'running',
    startedAt: Number.isSafeInteger(job.startedAt) ? job.startedAt : Date.now()
  };
  if (typeof job.detail === 'string') snapshot.detail = job.detail;
  if (Number.isSafeInteger(job.finishedAt)) snapshot.finishedAt = job.finishedAt;
  return snapshot;
}

/**
 * Replacement `job_output` value for a wait the user stopped.
 * Returned as the tool's own `value`, so the registered `render` and the
 * tool-jobs content finalizer shape the model-facing text exactly like a
 * normal read ("<text>\n[status: ...]"), and the tool call is NOT an error.
 * Returns null when the job record is unavailable, leaving the honest
 * core result ("Error: wait aborted") in place.
 */
function waitStoppedValue(jobId) {
  const job = jobSnapshotForValue(jobId);
  if (!job) return null;

  const settled = job.status === 'completed' || job.status === 'killed' || job.status === 'failed';
  return {
    text: settled
      ? `Wait stopped by user; job ${job.id} has already settled.`
      : `Wait stopped by user; job ${job.id} is still running — read it again with job_output, or stop it with job_kill.`,
    job
  };
}

function cleanCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return '';
  const cmdIdx = argv.indexOf('-Command');
  if (cmdIdx !== -1 && argv[cmdIdx + 1]) {
    let cmd = argv[cmdIdx + 1];
    // Remove PowerShell UTF-8 preamble injected by DSH:
    cmd = cmd.replace(/^\s*\[Console\]::OutputEncoding[^;]+;\s*\$OutputEncoding[^;]+;\s*/i, '');
    return cmd.trim();
  }
  const cIdx = argv.indexOf('-c');
  if (cIdx !== -1 && argv[cIdx + 1]) {
    return argv[cIdx + 1].trim();
  }
  return argv.slice(1).join(' ').trim() || argv[0];
}

function normalizeCmd(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/^\s*\[console\]::outputencoding[^;]+;\s*\$outputencoding[^;]+;\s*/i, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesCommand(procOrCmd, cmdText) {
  if (!procOrCmd || !cmdText) return false;
  const p = normalizeCmd(typeof procOrCmd === 'string' ? procOrCmd : (procOrCmd.command || procOrCmd.label || ''));
  const c = normalizeCmd(cmdText);
  if (!p || !c) return false;
  if (p === c) return true;

  const minLen = Math.min(p.length, c.length);
  const maxLen = Math.max(p.length, c.length);
  if (minLen > 30 && minLen / maxLen >= 0.75) {
    return p.includes(c) || c.includes(p);
  }
  return false;
}

function pruneCompletedProcesses() {
  const completed = [];
  for (const proc of activeProcesses.values()) {
    if (!proc.active) {
      completed.push(proc);
    }
  }
  if (completed.length > 50) {
    completed.sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    const toRemove = completed.slice(0, completed.length - 50);
    for (const p of toRemove) {
      activeProcesses.delete(p.id);
      if (p.callId) activeProcesses.delete(p.callId);
      if (p.jobId) activeProcesses.delete(p.jobId);
    }
  }

  // Keep up to 100 finished background job buffers
  if (backgroundJobBuffers.size > 100) {
    const keys = [...backgroundJobBuffers.keys()];
    for (let i = 0; i < keys.length - 100; i++) {
      backgroundJobBuffers.delete(keys[i]);
    }
  }
}

/**
 * Wraps job.readOutput to support multi-consumer streaming:
 * - Plugin gets full accumulated output from process start.
 * - Agent / tool-jobs (job_output) gets its incremental unread delta without missing anything.
 */
function setupJobOutputInterception(jobId, job) {
  if (!job || job.__liveTerminalIntercepted) return;
  job.__liveTerminalIntercepted = true;

  const origReadOutput = job.readOutput;
  let fullAccumulated = backgroundJobBuffers.get(jobId) || '';
  let modelUnreadBuffer = '';

  function pump() {
    if (typeof origReadOutput === 'function') {
      try {
        const chunk = origReadOutput();
        if (chunk) {
          fullAccumulated += chunk;
          modelUnreadBuffer += chunk;
          backgroundJobBuffers.set(jobId, fullAccumulated);
        }
      } catch (e) {}
    }
  }

  job.readOutput = function() {
    pump();
    const result = modelUnreadBuffer;
    modelUnreadBuffer = '';
    return result;
  };

  job.__getLiveOutput = function() {
    pump();
    return fullAccumulated;
  };

  if (job.settled && typeof job.settled.then === 'function') {
    job.settled.then(() => {
      pump();
      if (job.output && job.output.length > fullAccumulated.length) {
        fullAccumulated = job.output;
      }
      backgroundJobBuffers.set(jobId, fullAccumulated);
    }).catch(() => {});
  }

  if (!backgroundJobBuffers.has(jobId)) {
    backgroundJobBuffers.set(jobId, '');
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Shared response preamble for every verb. */
function prepareResponse(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

/** Parse the request URL defensively; query access never throws. */
function requestUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    return new URL('/');
  }
}

/** Read and parse the JSON request body, capped by {@link MAX_BODY_BYTES}. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let body = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done({});
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        done(JSON.parse(body || '{}'));
      } catch {
        done({});
      }
    });
    req.on('error', () => done({}));
  });
}

/** Answer one live-terminal route that a disabled feature must not serve. */
function denyDisabled(res) {
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, enabled: false, jobs: [], found: false, output: '' }));
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register every host-side contribution.
 * @param {object} ctx - plugin context; needs `webServer` and `subprocess`.
 */
export function apply(ctx) {
  ctx.logger?.info?.(`[better-uiux] config file: ${CONFIG_FILE}`);
  ctx.logger?.info?.(`[better-uiux] features: ${JSON.stringify(currentConfig.features)}`);

  // -------------------------------------------------------------------------
  // 0. Capture the route handlers as they are registered
  //
  // The ported browser half used to call `/api/live-terminal/*` (the standalone
  // plugin's namespace). Rather than duplicate ~500 lines of handler bodies under
  // a second prefix, the handlers are collected here as `webServer.register` is
  // called and then re-registered under the legacy prefix at the end. Purely a
  // compatibility shim for a cached client; the canonical prefix stays `API`.
  // -------------------------------------------------------------------------
  const capturedHandlers = {};
  const realRegister = ctx.webServer.register.bind(ctx.webServer);
  ctx.webServer.register = (definition) => {
    try {
      const path = typeof definition?.path === 'string' ? definition.path : '';
      if (path.startsWith(`${API}/`) && typeof definition.handler === 'function') {
        capturedHandlers[path.slice(API.length + 1)] = definition.handler;
      }
    } catch {
      /* capture is best-effort; never block registration */
    }
    return realRegister(definition);
  };

  // -------------------------------------------------------------------------
  // 1. DSH_CALL_ID contributor (live terminal correlation)
  // -------------------------------------------------------------------------
  ctx.inject(['shellEnv'], (envCtx) => {
    try {
      envCtx.shellEnv.register({
        name: 'better-uiux-call-id',
        variables: {
          DSH_CALL_ID: {
            description: 'Call ID of the current tool execution for live stream correlation.'
          }
        },
        resolve(execution) {
          if (execution && execution.callId) {
            return { DSH_CALL_ID: String(execution.callId) };
          }
          return {};
        }
      });
      ctx.logger?.info?.('[better-uiux] registered DSH_CALL_ID contributor');
    } catch (e) {
      ctx.logger?.warn?.(`[better-uiux] failed to register shellEnv contributor: ${e?.message || e}`);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Background jobs registry — output interception
  // -------------------------------------------------------------------------
  ctx.inject(['jobs'], (jobsCtx) => {
    try {
      jobsRegistry = jobsCtx.jobs;

      // Intercept any pre-existing jobs
      if (jobsRegistry?.store) {
        for (const [id, job] of jobsRegistry.store.entries()) {
          setupJobOutputInterception(String(id), job);
        }
      }

      const origJobsStart = jobsCtx.jobs.start.bind(jobsCtx.jobs);
      jobsCtx.jobs.start = function(spec) {
        const jobId = origJobsStart(spec);
        if (jobId) {
          const jid = String(jobId);
          try {
            const job = jobsCtx.jobs.store?.get(jobId);
            if (job) {
              setupJobOutputInterception(jid, job);
              ctx.logger?.info?.(`[better-uiux] Intercepted background job ${jid}`);
            }
          } catch (e) {
            ctx.logger?.warn?.(`[better-uiux] Failed to intercept job ${jid}: ${e?.message || e}`);
          }
        }
        return jobId;
      };
      ctx.logger?.info?.('[better-uiux] hooked jobs.start for background job streaming');
    } catch (e) {
      ctx.logger?.warn?.(`[better-uiux] failed to hook jobs: ${e?.message || e}`);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Track in-flight job_output(wait: true) calls so a Stop can end ONLY the
  //    waiting tool call. DSH hands a tool body `exec.signal` fused from the
  //    caller signal plus whatever an around-wrapper put there, so contributing
  //    our own controller to `exec.signal` is the supported seam: aborting it
  //    cancels this one call and leaves the turn (and the background job) alive.
  // -------------------------------------------------------------------------
  ctx.inject(['tools'], (toolsCtx) => {
    try {
      toolsCtx.on('tools/execute', async (exec, next) => {
        if (!exec || exec.name !== 'job_output' || exec.arguments?.wait !== true) {
          return next();
        }
        if (!featureOn('liveTerminal')) return next();

        const callId = exec.callId === undefined || exec.callId === null ? '' : String(exec.callId);
        const jobId = exec.arguments?.job_id === undefined || exec.arguments?.job_id === null
          ? ''
          : String(exec.arguments.job_id);
        if (!callId && !jobId) return next();

        const entry = {
          callId,
          jobId,
          sessionId: exec.agent?.id ?? null,
          startedAt: Date.now(),
          controller: new AbortController()
        };
        if (callId) pendingWaits.set(callId, entry);

        const upstreamSignal = exec.signal;
        // Fuse instead of clobbering: another around-wrapper (e.g. the tool-call
        // timeout policy) may already have replaced `exec.signal`, and its
        // cancellation must keep reaching this body.
        exec.signal = upstreamSignal && typeof upstreamSignal.addEventListener === 'function'
          ? AbortSignal.any([upstreamSignal, entry.controller.signal])
          : entry.controller.signal;
        try {
          const result = await next();

          const stoppedByUs = entry.controller.signal.aborted;
          const message = result?.error?.message;
          if (stoppedByUs && result?.isError && (message === 'wait aborted' || message === 'tool call aborted')) {
            const replacement = waitStoppedValue(jobId);
            if (replacement) return { value: replacement };
          }
          return result;
        } finally {
          exec.signal = upstreamSignal;
          if (callId) pendingWaits.delete(callId);
        }
      });
      ctx.logger?.info?.('[better-uiux] hooked tools/execute for job_output wait tracking');
    } catch (e) {
      ctx.logger?.warn?.(`[better-uiux] failed to hook tools/execute: ${e?.message || e}`);
    }
  });

  // -------------------------------------------------------------------------
  // 4. subprocess.spawn — foreground command output streaming.
  //    The wrapper is always installed (so the seam is stable) but records
  //    nothing at all while the feature is off.
  // -------------------------------------------------------------------------
  const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess);
  ctx.subprocess.spawn = function(spec) {
    const handle = originalSpawn(spec);
    if (!featureOn('liveTerminal')) return handle;

    const stdoutCollector = handle.collected?.stdout;
    if (stdoutCollector) {
      const env = spec.env || {};
      const callId = env.DSH_CALL_ID || null;
      const sessionId = env.DSH_SESSION_ID || null;
      const id = callId || (handle.pid > 0 ? String(handle.pid) : `proc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      const command = cleanCommand(spec.argv);
      const cwd = spec.cwd || '';

      const procRecord = {
        id,
        callId,
        jobId: null,
        pid: handle.pid || 0,
        handle,
        sessionId,
        cwd,
        command,
        output: '',
        active: true,
        startedAt: Date.now(),
        lastUpdated: Date.now(),
        finishedAt: null
      };

      activeProcesses.set(id, procRecord);
      if (callId && id !== callId) {
        activeProcesses.set(callId, procRecord);
      }

      let readOffset = 0;
      const timer = setInterval(() => {
        try {
          const slice = stdoutCollector.readFrom(readOffset);
          if (slice && slice.text) {
            procRecord.output += slice.text;
            readOffset = slice.nextOffset;
            if (procRecord.output.length > 300000) {
              procRecord.output = procRecord.output.slice(-300000);
            }
            procRecord.lastUpdated = Date.now();
          }
        } catch (e) {}
      }, 150);

      handle.done.finally(() => {
        clearInterval(timer);
        try {
          const slice = stdoutCollector.readFrom(readOffset);
          if (slice && slice.text) {
            procRecord.output += slice.text;
          }
        } catch (e) {}
        procRecord.active = false;
        procRecord.finishedAt = Date.now();
        procRecord.lastUpdated = Date.now();

        pruneCompletedProcesses();
      });
    }

    return handle;
  };

  // -------------------------------------------------------------------------
  // 5. GET/POST /api/better-uiux/config
  // -------------------------------------------------------------------------
  ctx.webServer.register({
    kind: 'exact',
    path: `${API}/config`,
    handler: async (req, res) => {
      if (prepareResponse(req, res)) return;

      if (req.method === 'GET') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ...currentConfig }));
        return;
      }

      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      const payload = await readJsonBody(req);
      const next = {
        features: { ...currentConfig.features },
        css: currentConfig.css
      };
      if (payload.features !== null && typeof payload.features === 'object') {
        for (const key of Object.keys(DEFAULT_FEATURES)) {
          if (typeof payload.features[key] === 'boolean') next.features[key] = payload.features[key];
        }
      }
      if (typeof payload.css === 'string') next.css = payload.css;
      currentConfig = normalizeConfig(next);
      const saved = writeConfigFile();

      ctx.logger?.info?.(`[better-uiux] features now: ${JSON.stringify(currentConfig.features)}`);

      res.statusCode = 200;
      res.end(JSON.stringify({ ...currentConfig, saved }));
    }
  });

  // -------------------------------------------------------------------------
  // 6. GET /api/better-uiux/jobs — live background-job list
  // -------------------------------------------------------------------------
  ctx.webServer.register({
    kind: 'exact',
    path: `${API}/jobs`,
    handler: async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!featureOn('liveTerminal')) return denyDisabled(res);

      const reqUrl = requestUrl(req);
      const qSessionId = reqUrl.searchParams.get('sessionId');
      const jobs = jobsRegistry || ctx.jobs || ctx.get?.('jobs');
      const jobList = [];

      if (jobs?.store) {
        for (const [id, job] of jobs.store.entries()) {
          const jid = String(id);
          if (!job.__liveTerminalIntercepted) {
            setupJobOutputInterception(jid, job);
          }
          const ownerSessionId = job.owner?.id ?? null;
          if (qSessionId && ownerSessionId !== null && ownerSessionId !== qSessionId) continue;

          const isTerminal = job.status === 'completed' || job.status === 'killed' || job.status === 'failed';
          jobList.push({
            id: jid,
            kind: job.kind || 'pwsh',
            command: job.label || '',
            status: job.status || (isTerminal ? 'completed' : 'running'),
            active: !isTerminal,
            sessionId: ownerSessionId,
            startedAt: job.startedAt || 0,
            finishedAt: job.finishedAt || null
          });
        }
      }

      for (const [jid, output] of backgroundJobBuffers.entries()) {
        if (!jobList.some(j => j.id === jid)) {
          jobList.push({
            id: jid,
            kind: 'pwsh',
            command: '',
            status: 'completed',
            active: false,
            hasOutput: !!output
          });
        }
      }

      res.end(JSON.stringify({ success: true, enabled: true, jobs: jobList }));
    }
  });

  // -------------------------------------------------------------------------
  // 7. GET /api/better-uiux/output — output for a job or a foreground process
  // -------------------------------------------------------------------------
  ctx.webServer.register({
    kind: 'exact',
    path: `${API}/output`,
    handler: async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!featureOn('liveTerminal')) return denyDisabled(res);

      const reqUrl = requestUrl(req);
      const qJobId = reqUrl.searchParams.get('jobId');
      const qId = reqUrl.searchParams.get('id') || reqUrl.searchParams.get('callId');
      const qSessionId = reqUrl.searchParams.get('sessionId');
      const qCommand = reqUrl.searchParams.get('command');

      // --- A. Prioritize lookup via jobs registry (for background jobs) ---
      const jobs = jobsRegistry || ctx.jobs || ctx.get?.('jobs');

      if (qJobId) {
        let job = jobs?.store?.get(qJobId);
        if (!job && jobs?.store) {
          for (const [id, j] of jobs.store.entries()) {
            if (String(id) === qJobId) {
              job = j;
              break;
            }
          }
        }

        if (job) {
          if (!job.__liveTerminalIntercepted) {
            setupJobOutputInterception(qJobId, job);
          }
          const isTerminal = job.status === 'completed' || job.status === 'killed' || job.status === 'failed';
          let fullOutput = job.__getLiveOutput ? job.__getLiveOutput() : (backgroundJobBuffers.get(qJobId) || '');
          if (isTerminal && job.output && job.output.length > fullOutput.length) {
            fullOutput = job.output;
            backgroundJobBuffers.set(qJobId, fullOutput);
          }

          return res.end(JSON.stringify({
            found: true,
            active: !isTerminal,
            status: job.status,
            kind: job.kind || 'pwsh',
            jobId: qJobId,
            command: job.label || '',
            startedAt: job.startedAt || 0,
            finishedAt: job.finishedAt || 0,
            output: fullOutput
          }));
        }

        if (backgroundJobBuffers.has(qJobId)) {
          return res.end(JSON.stringify({
            found: true,
            active: false,
            status: 'completed',
            jobId: qJobId,
            output: backgroundJobBuffers.get(qJobId)
          }));
        }
      }

      // --- B. activeProcesses (foreground commands and tracked processes) ---
      let matched = null;

      // 1. By jobId in activeProcesses
      if (qJobId) {
        if (activeProcesses.has(qJobId)) {
          matched = activeProcesses.get(qJobId);
        } else {
          for (const proc of activeProcesses.values()) {
            if (proc.jobId === qJobId) {
              matched = proc;
              break;
            }
          }
        }
      }

      // 2. By specific ID or callId
      if (!matched && qId) {
        if (activeProcesses.has(qId)) {
          matched = activeProcesses.get(qId);
        } else {
          for (const proc of activeProcesses.values()) {
            if (proc.id === qId || proc.callId === qId || proc.jobId === qId) {
              matched = proc;
              break;
            }
          }
        }
      }

      // 3. By sessionId and command
      if (!matched && qSessionId && qCommand) {
        for (const proc of activeProcesses.values()) {
          if (proc.sessionId === qSessionId && matchesCommand(proc, qCommand)) {
            if (proc.active) {
              matched = proc;
              break;
            }
            if (!matched || proc.lastUpdated > matched.lastUpdated) {
              matched = proc;
            }
          }
        }
      }

      // 4. By command only
      if (!matched && qCommand) {
        for (const proc of activeProcesses.values()) {
          if (matchesCommand(proc, qCommand)) {
            if (proc.active) {
              matched = proc;
              break;
            }
            if (!matched || proc.lastUpdated > matched.lastUpdated) {
              matched = proc;
            }
          }
        }
      }

      // 5. By sessionId only
      if (!matched && qSessionId) {
        for (const proc of activeProcesses.values()) {
          if (proc.sessionId === qSessionId) {
            if (proc.active) {
              matched = proc;
              break;
            }
            if (!matched || proc.lastUpdated > matched.lastUpdated) {
              matched = proc;
            }
          }
        }
      }

      // 6. Fallback if only 1 active process
      if (!matched) {
        const activeList = [];
        for (const proc of activeProcesses.values()) {
          if (proc.active && !activeList.some(p => p.id === proc.id)) {
            activeList.push(proc);
          }
        }
        if (activeList.length === 1) {
          matched = activeList[0];
        }
      }

      // 7. Fallback to background jobs by command only if no active process matched
      if (!matched && !qJobId && qCommand && jobs?.store) {
        for (const [id, job] of jobs.store.entries()) {
          if (matchesCommand(job.label, qCommand)) {
            const jid = String(id);
            if (!job.__liveTerminalIntercepted) {
              setupJobOutputInterception(jid, job);
            }
            const isTerminal = job.status === 'completed' || job.status === 'killed' || job.status === 'failed';
            let fullOutput = job.__getLiveOutput ? job.__getLiveOutput() : (backgroundJobBuffers.get(jid) || '');
            if (isTerminal && job.output && job.output.length > fullOutput.length) {
              fullOutput = job.output;
              backgroundJobBuffers.set(jid, fullOutput);
            }

            return res.end(JSON.stringify({
              found: true,
              active: !isTerminal,
              isBackground: true,
              status: job.status,
              kind: job.kind || 'pwsh',
              jobId: jid,
              command: job.label || '',
              startedAt: job.startedAt || 0,
              finishedAt: job.finishedAt || 0,
              output: fullOutput
            }));
          }
        }
      }

      if (matched) {
        if (qJobId && !matched.jobId) {
          matched.jobId = qJobId;
          activeProcesses.set(qJobId, matched);
        }
        return res.end(JSON.stringify({
          found: true,
          active: matched.active,
          status: matched.active ? 'running' : 'completed',
          kind: 'pwsh',
          id: matched.id,
          jobId: matched.jobId,
          callId: matched.callId,
          sessionId: matched.sessionId,
          command: matched.command,
          cwd: matched.cwd,
          startedAt: matched.startedAt || 0,
          output: matched.output,
          finishedAt: matched.finishedAt
        }));
      }

      res.end(JSON.stringify({
        found: false,
        active: false,
        output: ''
      }));
    }
  });

  // -------------------------------------------------------------------------
  // 8. GET /api/better-uiux/stop — stop a job, a process, or a pending wait
  // -------------------------------------------------------------------------
  ctx.webServer.register({
    kind: 'exact',
    path: `${API}/stop`,
    handler: async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!featureOn('liveTerminal')) return denyDisabled(res);

      const reqUrl = requestUrl(req);
      const qMode = (reqUrl.searchParams.get('mode') || '').toLowerCase();
      const qJobId = reqUrl.searchParams.get('jobId');
      const qId = reqUrl.searchParams.get('id') || reqUrl.searchParams.get('callId');

      // 0. Wait-only stop: end the pending `job_output(wait: true)` call and
      // leave the background job running. Never falls through to a kill.
      if (qMode === 'wait') {
        const target = findPendingWait(qId, qJobId);
        let stoppedWait = false;

        if (target) {
          const reason = new Error('wait stopped by user from Better UIUX Terminal');
          reason.name = 'BetterUiuxWaitStopped';
          try {
            target.controller.abort(reason);
            stoppedWait = true;
            ctx.logger?.info?.(
              `[better-uiux] Stopped wait${target.callId ? ` ${target.callId}` : ''} on job ${target.jobId}; job left running`
            );
          } catch (e) {
            ctx.logger?.warn?.(`[better-uiux] Failed to stop wait: ${e?.message || e}`);
          }
        }

        return res.end(JSON.stringify({
          success: true,
          mode: 'wait',
          stoppedWait,
          killed: false,
          jobId: qJobId,
          id: qId
        }));
      }

      let killed = false;

      // 1. Kill background job via jobs registry
      if (qJobId) {
        const jobs = jobsRegistry || ctx.jobs || ctx.get?.('jobs');
        let job = jobs?.store?.get(qJobId);
        if (!job && jobs?.store) {
          for (const [id, j] of jobs.store.entries()) {
            if (String(id) === qJobId) {
              job = j;
              break;
            }
          }
        }

        if (job) {
          if (typeof job.cancel === 'function') {
            try {
              job.cancel('Stopped by user from Better UIUX');
              job.status = 'stopping';
              killed = true;
              ctx.logger?.info?.(`[better-uiux] Cancelled background job ${qJobId}`);
            } catch (e) {}
          }
        }

        if (!killed && jobs && typeof jobs.kill === 'function') {
          try {
            jobs.kill(qJobId, job?.owner, 'Stopped by user from Better UIUX');
            killed = true;
          } catch (e) {}
        }

        const prev = backgroundJobBuffers.get(qJobId) || '';
        if (!prev.includes('[Process stopped by user]')) {
          backgroundJobBuffers.set(qJobId, (prev ? prev + '\n' : '') + '[Process stopped by user]\n');
        }
      }

      // 2. Kill foreground process via activeProcesses handle
      let targetProc = null;
      if (!killed && qJobId) {
        targetProc = activeProcesses.get(qJobId);
      }
      if (!killed && !targetProc && qId) {
        targetProc = activeProcesses.get(qId);
        if (!targetProc) {
          for (const p of activeProcesses.values()) {
            if (p.id === qId || p.callId === qId || p.jobId === qId) {
              targetProc = p;
              break;
            }
          }
        }
      }

      if (targetProc && targetProc.handle) {
        try {
          if (typeof targetProc.handle.terminate === 'function') {
            targetProc.handle.terminate();
            killed = true;
          } else if (typeof targetProc.handle.kill === 'function') {
            targetProc.handle.kill('SIGTERM');
            killed = true;
          }
        } catch (e) {}
      }

      // 3. Fallback on Windows: taskkill tree by pid
      if (targetProc && targetProc.pid > 0 && process.platform === 'win32') {
        try {
          const { spawnSync } = await import('node:child_process');
          spawnSync('taskkill', ['/F', '/T', '/PID', String(targetProc.pid)]);
          killed = true;
        } catch (e) {}
      }

      if (targetProc) {
        targetProc.active = false;
        targetProc.finishedAt = Date.now();
        targetProc.lastUpdated = Date.now();
        if (!targetProc.output.includes('[Process stopped by user]')) {
          targetProc.output += (targetProc.output ? '\n' : '') + '[Process stopped by user]\n';
        }
      }

      // NOTE: no catch-all fallback here. A stop that failed to resolve a
      // specific target must never cancel an unrelated running job; a wait on a
      // job must go through `mode=wait` above.

      res.end(JSON.stringify({
        success: true,
        killed,
        jobId: qJobId,
        id: qId
      }));
    }
  });

  // Restore the real register, then publish the legacy aliases for a cached client.
  ctx.webServer.register = realRegister;

  // Only the live-output routes need aliasing; `/config` never had a legacy name.
  const legacyHandlers = {
    jobs: capturedHandlers.jobs,
    output: capturedHandlers.output,
    stop: capturedHandlers.stop
  };
  registerLegacyAliases(ctx, legacyHandlers);

  ctx.logger?.info?.(
    `[better-uiux] ready — ${API}/config, ${API}/jobs, ${API}/output, ${API}/stop`
  );
}

// ---------------------------------------------------------------------------
// Legacy route alias
//
// The browser half of the ported live-terminal module used to call
// `/api/live-terminal/*` — the namespace of the STANDALONE plugin this one
// replaces. Those routes belong to whatever still owns that prefix (a 401 when
// nothing legitimate does), so a stale cached client would silently receive no
// output at all. The client has been re-pointed, and this alias means an old
// bundle still works against the new host instead of failing quietly.
// ---------------------------------------------------------------------------

/**
 * Register the live-output routes a second time under the legacy prefix.
 *
 * @param {object} ctx - plugin context; needs `webServer`.
 * @param {{ jobs: Function, output: Function, stop: Function }} handlers - the
 *   same handlers registered under the current prefix.
 * @returns {string[]} the legacy paths registered.
 */
function registerLegacyAliases(ctx, handlers) {
  const LEGACY = '/api/live-terminal';
  const registered = [];
  for (const [name, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') continue;
    try {
      ctx.webServer.register({ kind: 'exact', path: `${LEGACY}/${name}`, handler });
      registered.push(`${LEGACY}/${name}`);
    } catch (error) {
      // A prefix collision with something else is not fatal: the current
      // namespace is registered and working regardless.
      ctx.logger?.warn?.(`[better-uiux] legacy alias ${LEGACY}/${name} not registered: ${error?.message ?? error}`);
    }
  }
  if (registered.length > 0) {
    ctx.logger?.info?.(`[better-uiux] legacy live-terminal aliases: ${registered.join(', ')}`);
  }
  return registered;
}

export { CONFIG_FILE, DEFAULT_FEATURES, registerLegacyAliases };
