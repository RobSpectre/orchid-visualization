"""Forward Hermes activity to the Orchid visualizer.

Observer only: callbacks enqueue and return. A daemon thread batches events
every 50 ms and POSTs them to the visualizer; if it isn't running, batches
are dropped silently.

What is sent (to the local visualizer only):
  - stream lifecycle and token deltas (live typing);
  - per-request timing and usage (TTFT, duration, tokens, context length);
  - finished messages — the user's prompt, the assistant's reasoning, reply and
    tool calls, and tool results — so the reasoning trace works even when the
    visualizer can't read this Hermes home's state.db (e.g. another macOS user);
  - Hermes' own inference statistics — the numbers its status bar shows (model,
    context used / window, session tokens, API calls, average latency and
    velocity, cache hit, compressions) — read from the running agent;
  - a heartbeat naming the local user and Hermes home, for the status page.
The visualizer redacts secrets from all text before showing it.
"""

import getpass
import json
import os
import math
import queue
import sys
import threading
import weakref
import time
import urllib.request

VERSION = "0.2.0"
TEXT_LIMIT = 8000  # per field; the visualizer clips further for display


DEFAULT_URL = "http://127.0.0.1:4747/hermes/hook"


def _url() -> str:
    env = os.environ.get("ORCHID_VIZ_HOOK_URL")
    if env:
        return env
    try:  # written by scripts/install-hermes-plugin.sh
        with open(os.path.join(os.path.dirname(__file__), "config.json"), encoding="utf-8") as f:
            return json.load(f).get("url") or DEFAULT_URL
    except Exception:
        return DEFAULT_URL


URL = _url()
_events: "queue.Queue[dict]" = queue.Queue(maxsize=4096)
_started = False
_who = {"user": "", "home": ""}
_agents: "dict[str, weakref.ref]" = {}  # session_id -> the main agent working in it
_last_stats: "dict[str, str]" = {}


def _put(event: dict) -> None:
    try:
        _events.put_nowait(event)
    except queue.Full:
        pass


def _post(batch: list) -> None:
    req = urllib.request.Request(URL, data=json.dumps(batch, default=str).encode(), headers={"content-type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=0.5).close()


def _sender() -> None:
    last_hello = 0.0
    while True:
        try:
            batch = [_events.get(timeout=1)]
        except queue.Empty:
            batch = []
        deadline = time.monotonic() + 0.05
        while batch and time.monotonic() < deadline and len(batch) < 512:
            try:
                batch.append(_events.get(timeout=max(0.0, deadline - time.monotonic())))
            except queue.Empty:
                break
        batch.extend(_stats_events())
        if time.monotonic() - last_hello > 30:  # heartbeat: who is connected, even when idle
            batch.append({"type": "hello", "t": time.time(), "plugin": VERSION, **_who})
            last_hello = time.monotonic()
        if not batch:
            continue
        try:
            _post(batch)
        except Exception:
            pass


# ---------------------------------------------------------------- inference statistics
# Hooks don't receive the agent, but Hermes calls post_api_request from a function
# that has it (agent/turn_response_intake.py). Keep a weak reference to it and read
# the same fields Hermes' status bar reads (hermes_cli/cli_status_bar_mixin.py),
# every second from the sender thread, so the numbers match Hermes exactly.

def _find_agent():
    f = sys._getframe(2)
    for _ in range(30):
        if f is None:
            return None
        for name in ("agent", "self"):
            a = f.f_locals.get(name)
            if a is not None and hasattr(a, "context_compressor") and hasattr(a, "session_id"):
                return a
        f = f.f_back
    return None


def _remember_agent() -> bool:
    """Track the calling agent; True when it is Hermes' background memory-review agent."""
    try:
        a = _find_agent()
        if a is None:
            return False
        if getattr(a, "_memory_write_origin", None) == "background_review":
            return True  # shares the session id, but it is not what the status bar shows
        sid = getattr(a, "session_id", None)
        if sid:
            _agents[sid] = weakref.ref(a)
    except Exception:
        pass
    return False


def _is_background() -> bool:
    try:
        a = _find_agent()
        return a is not None and getattr(a, "_memory_write_origin", None) == "background_review"
    except Exception:
        return False


def _num(v):
    try:
        v = float(v)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def _snapshot(a) -> dict:
    st = {"model": getattr(a, "model", None), "provider": getattr(a, "provider", None), "platform": getattr(a, "platform", None)}
    for k in ("session_input_tokens", "session_output_tokens", "session_cache_read_tokens", "session_cache_write_tokens",
              "session_prompt_tokens", "session_completion_tokens", "session_total_tokens", "session_api_calls"):
        st[k] = getattr(a, k, None)
    comp = getattr(a, "context_compressor", None)
    if comp is not None:
        used = max(0, getattr(comp, "last_prompt_tokens", 0) or 0)
        try:  # the status bar's display anchoring (turn's first response + appended estimate)
            from agent.usage_anchor import anchored_context_tokens
            msgs = getattr(a, "_session_messages", None)
            anchored = anchored_context_tokens(msgs if isinstance(msgs, list) else [], getattr(a, "_turn_base_usage_anchor", None), charge_stale_thinking=False)
            if anchored:
                used = anchored
        except Exception:
            pass
        length = max(0, getattr(comp, "context_length", 0) or 0)
        if length:
            used = min(used, length)
        st.update(context_used=used, context_length=length or None,
                  context_percent=max(0, min(100, round(used / length * 100))) if length else None,
                  compressions=getattr(comp, "compression_count", 0) or 0)
    try:  # rolling averages: mean latency, sum/sum velocity
        lat = list(getattr(a, "_api_latency_history", []) or [])
        out = list(getattr(a, "_api_output_history", []) or [])
        n = min(len(lat), len(out))
        if n:
            lat, out = lat[-n:], out[-n:]
            total = sum(lat)
            st.update(avg_latency=_num(total / n), avg_velocity=_num(sum(out) / total) if total > 0 else None, samples=n)
    except Exception:
        pass
    prompt, read = st.get("session_prompt_tokens") or 0, st.get("session_cache_read_tokens") or 0
    st["cache_hit_pct"] = _num(read / prompt * 100) if prompt and read else None
    return st


def _stats_events() -> list:
    events = []
    for sid, ref in list(_agents.items()):
        a = ref()
        if a is None:
            _agents.pop(sid, None)
            _last_stats.pop(sid, None)
            continue
        try:
            st = _snapshot(a)
        except Exception:
            continue
        key = json.dumps(st, sort_keys=True, default=str)
        if key == _last_stats.get(sid):
            continue
        _last_stats[sid] = key
        events.append({"type": "stats", "t": time.time(), "session_id": sid, **st})
    return events


def _ensure_sender() -> None:
    global _started
    if not _started:
        _started = True
        try:
            _who["user"] = getpass.getuser()
        except Exception:
            _who["user"] = ""
        _who["home"] = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        threading.Thread(target=_sender, name="orchid-viz-sender", daemon=True).start()


def _common(kw: dict) -> dict:
    return {k: kw.get(k) for k in ("session_id", "turn_id", "model", "provider", "platform") if kw.get(k) is not None}


def _text(v) -> str:
    if v is None:
        return ""
    if not isinstance(v, str):
        try:
            v = json.dumps(v, default=str)
        except Exception:
            v = str(v)
    return v[:TEXT_LIMIT]


def _get(obj, name):
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _tool_calls(msg) -> list:
    out = []
    for tc in _get(msg, "tool_calls") or []:
        fn = _get(tc, "function") or {}
        out.append({"id": _get(tc, "id"), "name": _get(fn, "name") or _get(tc, "name"), "args": _text(_get(fn, "arguments") or _get(tc, "arguments"))})
    return out


def _on_stream_start(**kw):
    _put({"type": "stream_start", "t": time.time(), **_common(kw)})


def _on_stream_delta(delta=None, kind="text", **kw):
    if delta:
        _put({"type": "delta", "t": time.time(), "kind": kind, "delta": delta, **_common(kw)})


def _on_stream_end(finished=None, error=None, **kw):
    _put({"type": "stream_end", "t": time.time(), "finished": finished, "error": str(error) if error else None, **_common(kw)})


def _on_pre_api_request(**kw):
    _put({
        "type": "pre_api", "t": time.time(), "approx_input_tokens": kw.get("approx_input_tokens"),
        "api_call_count": kw.get("api_call_count"), **_common(kw),
    })


def _on_post_api_request(**kw):
    bg = _remember_agent()
    usage = kw.get("usage") or {}
    _put({
        "background": bg,
        "type": "post_api", "t": time.time(),
        "started_at": kw.get("started_at"), "ended_at": kw.get("ended_at"),
        "first_chunk_at": kw.get("first_chunk_at"), "api_duration": kw.get("api_duration"),
        "context_length": kw.get("context_length"), "finish_reason": kw.get("finish_reason"),
        "api_call_count": kw.get("api_call_count"),
        "usage": {k: usage.get(k) for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "prompt_tokens", "reasoning_tokens")},
        **_common(kw),
    })
    msg = kw.get("assistant_message")
    if msg is not None:
        reasoning = _get(msg, "reasoning") or _get(msg, "reasoning_content") or ""
        _put({
            "type": "message", "t": time.time(), "role": "assistant", "background": bg,
            "content": _text(_get(msg, "content")), "reasoning": _text(reasoning),
            "tool_calls": _tool_calls(msg), "finish_reason": kw.get("finish_reason"), **_common(kw),
        })


def _on_pre_llm_call(**kw):
    if kw.get("user_message"):
        _put({"type": "message", "t": time.time(), "role": "user", "background": _is_background(), "content": _text(kw.get("user_message")), **_common(kw)})


def _on_post_tool_call(**kw):
    _put({
        "type": "message", "t": time.time(), "role": "tool", "background": _is_background(), "tool_name": kw.get("tool_name"),
        "tool_call_id": kw.get("tool_call_id"), "content": _text(kw.get("result")),
        "duration_ms": kw.get("duration_ms"), **_common(kw),
    })


def register(ctx) -> None:
    _ensure_sender()
    ctx.register_hook("on_stream_start", _on_stream_start)
    ctx.register_hook("on_stream_delta", _on_stream_delta)
    ctx.register_hook("on_stream_end", _on_stream_end)
    ctx.register_hook("pre_api_request", _on_pre_api_request)
    ctx.register_hook("post_api_request", _on_post_api_request)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
