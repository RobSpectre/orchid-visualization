// Token Factory telemetry, one stat per row.
//
// Headline tok/s is always exactly Hermes' own status-bar formula
// (hermes_cli/cli_status_bar_mixin.py): sum(output tokens) / sum(latency)
// over the current session's last 10 API calls. Latency is end-to-end, so this
// includes prompt processing and time to first token.
//
// Decode speed and TTFT are only measured when the optional stream hook
// reports first-chunk timing. Without it they're estimated by a least-squares
// fit over recent calls (latency ≈ overhead + out / decodeRate) and tagged "est".

import { S } from './state.js';
import { P, a as pa } from './theme.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US'));
const short = (n) => {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};
const HERMES_WINDOW = 10; // agent_init.py: deque(maxlen=10)
const ago = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h ago` : `${Math.round(h / 24)} days ago`;
};

export function fitDecode(calls) {
  const pts = calls.filter((c) => c.out != null && c.latency > 0).slice(-40);
  if (pts.length < 8) return null;
  const mx = pts.reduce((a, c) => a + c.out, 0) / pts.length;
  const my = pts.reduce((a, c) => a + c.latency, 0) / pts.length;
  let sxx = 0, sxy = 0;
  for (const c of pts) { sxx += (c.out - mx) ** 2; sxy += (c.out - mx) * (c.latency - my); }
  if (sxx < 1e4 || sxy <= 0) return null; // not enough spread in output length
  const slope = sxy / sxx;
  const overhead = my - slope * mx;
  if (overhead < 0) return null;
  return { tps: 1 / slope, overhead, n: pts.length };
}

// Hermes' status-bar velocity: sum/sum over the last 10 calls (true throughput, not mean of ratios).
export function hermesVelocity(calls) {
  const w = calls.filter((c) => c.out != null && c.latency > 0).slice(-HERMES_WINDOW);
  const lat = w.reduce((a, c) => a + c.latency, 0);
  if (!w.length || lat <= 0) return null;
  return { tps: w.reduce((a, c) => a + c.out, 0) / lat, avgLatency: lat / w.length, n: w.length };
}

export function createFactory() {
  const shown = { tps: 0 };
  const els = Object.fromEntries([
    'tf-model', 'tf-provider', 'tf-tps', 'tf-tps-sub', 'tf-spark', 'tf-spark-k', 'tf-tok-s', 'tf-tok-s-sub', 'tf-tok-30', 'tf-tok-30-sub',
    'tf-ttft', 'tf-ttft-sub', 'tf-lat', 'tf-lat-sub',
    'tf-ctx-left', 'tf-ctx-sub', 'tf-ctx-bar',
  ].map((id) => [id, $(id)]));
  let lastText = 0;

  // The current session's calls, like Hermes' per-agent history; all calls if it has none yet.
  function sessionCalls() {
    const sess = S.hermes.session;
    const all = S.hermes.calls.filter((c) => !sess?.model || c.model === sess.model);
    const mine = sess ? all.filter((c) => c.session === sess.id) : [];
    return mine.length ? mine : all;
  }

  function liveTps(now) {
    const st = S.hermes.stream;
    if (!st || now - st.lastAt > 1500) return null;
    const windowMs = 1500;
    const chars = st.samples.filter((s) => now - s.t < windowMs).reduce((a, s) => a + s.n, 0);
    return chars / 4 / (windowMs / 1000); // ~4 chars per token
  }

  // Activity over the last 2 hours: output tokens per 2-minute slot, across all
  // of Hermes' Token Factory calls. Idle time is flat, so stale calls never look current.
  const SPARK_WINDOW = 2 * 3600_000;
  const SPARK_BUCKETS = 60;
  function drawSpark(allCalls, now) {
    const c = els['tf-spark'];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const start = now - SPARK_WINDOW;
    const size = SPARK_WINDOW / SPARK_BUCKETS;
    const buckets = new Float64Array(SPARK_BUCKETS);
    let total = 0;
    for (const call of allCalls) {
      if (call.ts < start || call.ts > now || call.out == null) continue;
      buckets[Math.min(SPARK_BUCKETS - 1, Math.floor((call.ts - start) / size))] += call.out;
      total += call.out;
    }
    // Floor the scale so one small call doesn't fill the whole height.
    const max = Math.max(2000, ...buckets);
    const bw = w / SPARK_BUCKETS;
    for (let i = 0; i < SPARK_BUCKETS; i++) {
      const x = i * bw;
      const v = buckets[i];
      if (!v) {
        ctx.fillStyle = pa(P.ink, 0.12);
        ctx.fillRect(x + 1, h - 1, bw - 2, 1);
        continue;
      }
      const bh = Math.max(2, (v / max) * (h - 2));
      ctx.fillStyle = i >= SPARK_BUCKETS - 2 ? P.lime : pa(P.lime, 0.6);
      ctx.fillRect(x + 1, h - bh, bw - 2, bh);
    }
    return total;
  }

  const set = (id, text, cls) => {
    const el = els[id];
    if (el.textContent !== text) el.textContent = text;
    if (cls !== undefined) el.classList.toggle('est', cls === 'est');
  };

  return function update(now) {
    const sess = S.hermes.session;
    const calls = sessionCalls();
    const last = calls.at(-1);
    const hv = hermesVelocity(calls);
    const post = S.hermes.lastPost;
    const live = liveTps(now);
    const fit = fitDecode(calls);

    // Headline: always Hermes' own velocity (real token counts and timings). The live
    // stream is only used to say "streaming now": text deltas don't include tool-call
    // tokens and arrive in bursts, so a chars-per-token rate from them is unreliable.
    // Hermes' own numbers from the plugin when present (exact, any user); else the same formula over its calls.
    const hs = sess?.hermes;
    const target = hs?.velocity ?? hv?.tps ?? 0;
    shown.tps += (target - shown.tps) * 0.12;

    if (now - lastText < 90) return;
    lastText = now;

    set('tf-model', sess?.model ? sess.model.split('/').pop() : last?.model?.split('/').pop() ?? '—');
    set('tf-provider', sess ? `${sess.providerName}${sess.reasoningEffort ? ` · reasoning ${sess.reasoningEffort}` : ''} · ${sess.source ?? ''} session` : '—');
    set('tf-tps', shown.tps ? shown.tps.toFixed(0) : '—');
    // Over 10 minutes since the last call: still the last measurement, but say how old it is.
    const lastAt = S.hermes.calls.at(-1)?.ts;
    const stale = live == null && lastAt != null && Date.now() - lastAt > 10 * 60_000;
    els['tf-tps'].parentElement.classList.toggle('stale', stale);
    set('tf-tps-sub', !hv && hs?.velocity == null ? 'waiting for a request'
      : `avg of last ${hs?.samples ?? hv?.n ?? "?"} calls${live != null ? ' · streaming now' : stale ? ` · agent idle, last ran ${ago(Date.now() - lastAt)}` : ''}`);

    // Tokens processed: this session (Hermes' own total) and the last 30 days (all tasks).
    const ts = sess?.tokensSession;
    if (ts) {
      set('tf-tok-s', short(ts.total));
      // Calls and cost live here (there is no footer line, so nothing can collide with the rows).
      const cost = sess.costUsd != null ? ` · $${sess.costUsd.toFixed(2)}` : '';
      set('tf-tok-s-sub', `${fmt(sess.apiCalls)} calls${cost} · ${short(ts.cached)} cached · ${short(ts.output)} out`);
    }
    const t30 = sess?.tokens30d;
    if (t30) {
      set('tf-tok-30', short(t30.total));
      set('tf-tok-30-sub', `${fmt(t30.calls)} calls · ${t30.sessions} sessions · incl. background tasks`);
    }

    if (post?.ttft != null) {
      set('tf-ttft', `${post.ttft < 1 ? `${Math.round(post.ttft * 1000)}ms` : `${post.ttft.toFixed(2)}s`}`, '');
      set('tf-ttft-sub', 'measured · stream hook');
    } else if (fit) {
      set('tf-ttft', `${fit.overhead.toFixed(2)}s`, 'est');
      set('tf-ttft-sub', 'fit intercept · includes prompt processing');
    } else {
      set('tf-ttft', '—', '');
      set('tf-ttft-sub', 'needs stream hook');
    }

    if (hs?.latency != null) {
      set('tf-lat', `${hs.latency.toFixed(1)}s`);
      set('tf-lat-sub', `mean of last ${hs.samples ?? '?'}${last?.latency != null ? ` · last ${last.latency.toFixed(1)}s` : ''}`);
    } else if (hv) {
      set('tf-lat', `${hv.avgLatency.toFixed(1)}s`);
      set('tf-lat-sub', `mean of last ${hv.n} · last ${last.latency.toFixed(1)}s`);
    } else {
      set('tf-lat', '—');
      set('tf-lat-sub', 'no calls yet this session');
    }

    // Same numbers as Hermes' status bar, computed by the server (server/context.mjs):
    // used = turn-base anchor + appended estimate; window = Hermes' own context length.
    const window_ = sess?.contextWindow;
    const used = sess?.contextUsed;
    if (window_ && used != null) {
      // Hermes rounds its "% used" to whole numbers; show the remainder of that, so the two always add to 100.
      const usedPct = Math.max(0, Math.min(100, Math.round((used / window_) * 100)));
      set('tf-ctx-left', `${100 - usedPct}%`);
      set('tf-ctx-sub', `${short(Math.max(0, window_ - used))} left · ${short(used)} / ${short(window_)} used`);
      // The bar fills with what's USED, like Hermes' context bar, and uses Hermes' thresholds:
      // under 50% good, 50–80% warning, over 80% bad, 95%+ critical.
      els['tf-ctx-bar'].style.width = `${Math.min(100, (used / window_) * 100).toFixed(1)}%`;
      const level = usedPct >= 95 ? 'critical' : usedPct > 80 ? 'bad' : usedPct >= 50 ? 'warn' : 'good';
      els['tf-ctx-bar'].closest('.row').dataset.level = level;
    } else {
      // Unknown for this session (e.g. just switched, no response yet): never keep the old session's figure.
      set('tf-ctx-left', '—');
      set('tf-ctx-sub', window_ ? `${short(window_)} window · waiting for the first response` : 'waiting for the first response');
      els['tf-ctx-bar'].style.width = '0%';
      delete els['tf-ctx-bar'].closest('.row').dataset.level;
    }
    const generated = drawSpark(S.hermes.calls, Date.now());
    set('tf-spark-k', generated ? `${short(generated)} tokens generated` : 'no agent activity');

  };
}
