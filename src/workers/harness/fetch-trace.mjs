// Preload (`NODE_OPTIONS=--import=…/fetch-trace.mjs`, `VF_FETCH_LOG=file.jsonl`) for a harness
// that only says "Connection error.": logs every fetch that rejects, with its full cause chain.
// Never logs bodies or header values — only sizes, header names, and which header values
// are not valid ByteStrings (a classic cause of fetch failing before it reaches the network).
//
// It also heals one failure seen with dsh → OpenRouter: after a TLS alert the dead HTTP/2
// session stays in fetch's connection pool, so every retry fails in ~1 ms with
// ERR_HTTP2_INVALID_SESSION. Swapping in a fresh pool lets the harness's own retry reconnect.
import fs from 'node:fs';

const out = process.env.VF_FETCH_LOG;
const orig = globalThis.fetch;
if (out && orig) {
  globalThis.fetch = async function traced(input, init) {
    const started = Date.now();
    try {
      return await orig(input, init);
    } catch (err) {
      const chain = [];
      for (let e = err; e && chain.length < 6; e = e.cause) chain.push({ name: e.name, message: String(e.message ?? e), code: e.code });
      const req = input instanceof Request ? input : undefined;
      const raw = init?.headers && !(init.headers instanceof Headers) ? Object.entries(Array.isArray(init.headers) ? Object.fromEntries(init.headers) : init.headers) : [];
      let names = raw.map(([k]) => k);
      try {
        names = [...new Headers(init?.headers ?? req?.headers ?? {}).keys()];
      } catch {} // the headers themselves may be what made fetch fail
      let healed = false;
      const deep = String(chain[chain.length - 1]?.code ?? '');
      if (/^ERR_HTTP2_|^ERR_SSL_/.test(deep)) {
        // Node 26's fetch keeps its pool (an undici Agent) here; `.1` is only a compatibility wrapper.
        for (const key of [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')]) {
          const old = globalThis[key];
          try {
            if (!old?.constructor) continue;
            globalThis[key] = new old.constructor();
            old.close?.()?.catch?.(() => {});
            healed = true;
            break;
          } catch {}
        }
      }
      fs.appendFileSync(
        out,
        JSON.stringify({
          ts: new Date().toISOString(),
          pid: process.pid,
          url: String(req?.url ?? input).replace(/\?.*/, ''),
          method: init?.method ?? req?.method,
          ms: Date.now() - started,
          bodyBytes: typeof init?.body === 'string' ? Buffer.byteLength(init.body) : undefined,
          signalAborted: Boolean(init?.signal?.aborted ?? req?.signal?.aborted),
          headers: names,
          nonByteStringHeaders: raw.filter(([, v]) => /[^\x00-\xff]/.test(String(v))).map(([k]) => k),
          chain,
          healed,
        }) + '\n',
      );
      throw err;
    }
  };
}
