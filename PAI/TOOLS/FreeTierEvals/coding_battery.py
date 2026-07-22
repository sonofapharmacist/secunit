#!/usr/bin/env python3
"""
PAI Coding Battery — 2026-06-15.
Runs C1-C6 + C8 from coding-battery-spec.md.

Anthropic-compat: GLM-4.5-air, GLM-4.7, GLM-5.1, M3
OpenAI-compat (Mistral): Small 4, Codestral, Devstral Med, Devstral Small 2
Cohere v2 Chat: North Mini Code

Usage:
  python3 coding_battery.py --target m3
  python3 coding_battery.py --target small4
  python3 coding_battery.py --target all
  python3 coding_battery.py --c8-only --target m3     # just C8
  python3 coding_battery.py --skip-c8 --target all    # skip C8 if vitest not available
"""

import os, json, time, subprocess, sys, urllib.request, urllib.error, re, shutil, tempfile
from pathlib import Path

# ── Endpoints ────────────────────────────────────────────────────────────────

ENDPOINTS = {
    # Native Anthropic API
    "sonnet": {
        "name": "Claude Sonnet 4.6 (Anthropic native)", "fmt": "anthropic",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-sonnet-4-6", "passage_key": "api/anthropic",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "sonnet5": {
        "name": "Claude Sonnet 5 (Anthropic native)", "fmt": "anthropic",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-sonnet-5", "passage_key": "api/anthropic",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "opus": {
        "name": "Claude Opus 4.8 (Anthropic native)", "fmt": "anthropic",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-opus-4-8", "passage_key": "api/anthropic",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "haiku": {
        "name": "Claude Haiku 4.5 (Anthropic native)", "fmt": "anthropic",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-haiku-4-5-20251001", "passage_key": "api/anthropic",
        "max_tokens": 4096, "is_reasoning": False,
    },
    # Anthropic-compat
    "m3": {
        "name": "MiniMax M3 (512K)", "fmt": "anthropic",
        "url": "https://api.minimax.io/anthropic/v1/messages",
        "model": "MiniMax-M3", "passage_key": "api/minimax",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "glm": {
        "name": "Z.ai GLM-4.5-air", "fmt": "anthropic",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-4.5-air", "passage_key": "api/glm",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "glm47": {
        "name": "Z.ai GLM-4.7", "fmt": "anthropic",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-4.7", "passage_key": "api/glm",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "glm51": {
        "name": "Z.ai GLM-5.1", "fmt": "anthropic",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-5.1", "passage_key": "api/glm",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "glm52-1m": {
        "name": "Z.ai GLM-5.2 (1M ctx by default, 3x quota — emergency-only per 2026-06-16 quota wall finding)", "fmt": "anthropic",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-5.2", "passage_key": "api/glm",
        "max_tokens": 4096, "is_reasoning": False,
    },
    # NVIDIA NIM OpenAI-compat
    "gpt_oss_120b": {
        "name": "OpenAI GPT-OSS-120B (NIM reasoning)", "fmt": "openai",
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "model": "openai/gpt-oss-120b", "passage_key": "api/nvidia",
        "max_tokens": 8192, "is_reasoning": True,
    },
    "nemotron_30b_r": {
        "name": "Nemotron-3-Nano-Omni-30B-A3B-R (NIM reasoning, fence-strip test)", "fmt": "openai",
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "model": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "passage_key": "api/nvidia",
        "max_tokens": 8192, "is_reasoning": True,
    },
    "nemotron_super": {
        "name": "Nemotron-3-Super-120B-A12B (NIM)", "fmt": "openai",
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "model": "nvidia/nemotron-3-super-120b-a12b", "passage_key": "api/nvidia",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "llama4_maverick": {
        "name": "Llama-4-Maverick-17B-128E (NIM)", "fmt": "openai",
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "model": "meta/llama-4-maverick-17b-128e-instruct", "passage_key": "api/nvidia",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "qwen35_122b": {
        "name": "Qwen3.5-122B-A10B (NIM)", "fmt": "openai",
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "model": "qwen/qwen3.5-122b-a10b", "passage_key": "api/nvidia",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "qwen397b": {
        "name": "Qwen3.5-397B-A17B (NIM reasoning — 2026-06-30 full bench)", "fmt": "openai",
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "model": "qwen/qwen3.5-397b-a17b", "passage_key": "api/nvidia",
        "max_tokens": 8192, "is_reasoning": True,
    },
    # StepFun Mini plan direct API
    "stepfun35_flash": {
        "name": "StepFun step-3.5-flash (Mini plan)", "fmt": "openai",
        "url": "https://api.stepfun.ai/step_plan/v1/chat/completions",
        "model": "step-3.5-flash", "passage_key": "api/stepfun",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "stepfun35_flash_2603": {
        "name": "StepFun step-3.5-flash-2603 (Mini plan)", "fmt": "openai",
        "url": "https://api.stepfun.ai/step_plan/v1/chat/completions",
        "model": "step-3.5-flash-2603", "passage_key": "api/stepfun",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "stepfun37_flash": {
        "name": "StepFun step-3.7-flash (Mini plan, reasoning)", "fmt": "openai",
        "url": "https://api.stepfun.ai/step_plan/v1/chat/completions",
        "model": "step-3.7-flash", "passage_key": "api/stepfun",
        "max_tokens": 8192, "is_reasoning": True,
    },
    # Mistral OpenAI-compat
    "small4": {
        "name": "Mistral Small 4", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "mistral-small-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "medium35": {
        "name": "Mistral Medium 3.5 (SOTA)", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "mistral-medium-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "magistral_s": {
        "name": "Mistral Magistral S (reasoning)", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "magistral-small-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": True,
    },
    "ministral_8b": {
        "name": "Mistral Ministral 8B (edge tier)", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "ministral-8b-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "ministral_14b": {
        "name": "Mistral Ministral 14B (edge tier)", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "ministral-14b-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "codestral": {
        "name": "Mistral Codestral", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "codestral-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "devstral_med": {
        "name": "Mistral Devstral Med", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "devstral-medium-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "devstral_small2": {
        "name": "Mistral Devstral Small 2 (devstral-latest)", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "devstral-latest", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "leanstral": {
        "name": "Leanstral 1.5 119B A6B (Labs)", "fmt": "openai",
        "url": "https://api.mistral.ai/v1/chat/completions",
        "model": "labs-leanstral-1-5-1", "passage_key": "api/mistral",
        "max_tokens": 4096, "is_reasoning": True,
    },
    # Gemini native API (generativelanguage.googleapis.com)
    # Tier 1 RPM (AI Studio tldr-insights, 2026-07-06): Flash-Lite 4K RPM, Flash 1K RPM
    "flash_lite_25": {
        "name": "Gemini 2.5 Flash-Lite", "fmt": "gemini",
        "model": "gemini-2.5-flash-lite", "passage_key": "api/gemini",
        "max_tokens": 4096, "is_reasoning": False, "sleep": 0,
    },
    "flash_25": {
        "name": "Gemini 2.5 Flash", "fmt": "gemini",
        "model": "gemini-2.5-flash", "passage_key": "api/gemini",
        "max_tokens": 4096, "is_reasoning": True, "sleep": 0.5,
    },
    "flash_35": {
        "name": "Gemini 3.5 Flash", "fmt": "gemini",
        "model": "gemini-3.5-flash", "passage_key": "api/gemini",
        "max_tokens": 4096, "is_reasoning": True, "sleep": 0.5,
    },
    "flash_lite_31": {
        "name": "Gemini 3.1 Flash-Lite", "fmt": "gemini",
        "model": "gemini-3.1-flash-lite", "passage_key": "api/gemini",
        "max_tokens": 4096, "is_reasoning": False, "sleep": 0,
    },
    "flash_36": {
        "name": "Gemini 3.6 Flash", "fmt": "gemini",
        "model": "gemini-3.6-flash", "passage_key": "api/gemini",
        "max_tokens": 4096, "is_reasoning": True, "sleep": 0.5,
    },
    "flash_lite_35": {
        "name": "Gemini 3.5 Flash-Lite", "fmt": "gemini",
        "model": "gemini-3.5-flash-lite", "passage_key": "api/gemini",
        "max_tokens": 4096, "is_reasoning": False, "sleep": 0,
    },
    # OpenAI native
    "gpt55": {
        "name": "OpenAI GPT-5.5 (top tier)", "fmt": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-5.5", "passage_key": "api/openai",
        "max_tokens": 4096, "is_reasoning": True,
    },
    "gpt54": {
        "name": "OpenAI GPT-5.4 (current Forge default)", "fmt": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-5.4", "passage_key": "api/openai",
        "max_tokens": 4096, "is_reasoning": True,
    },
    "gpt52": {
        "name": "OpenAI GPT-5.2", "fmt": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-5.2", "passage_key": "api/openai",
        "max_tokens": 4096, "is_reasoning": True,
    },
    "gpt5mini": {
        "name": "OpenAI GPT-5-mini (cost-optimized flagship)", "fmt": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-5-mini", "passage_key": "api/openai",
        "max_tokens": 4096, "is_reasoning": True,
    },
    "gpt41": {
        "name": "OpenAI GPT-4.1 (mature frontier)", "fmt": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-4.1", "passage_key": "api/openai",
        "max_tokens": 4096, "is_reasoning": False,
    },
    "gpt4o": {
        "name": "OpenAI GPT-4o (legacy default)", "fmt": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-4o", "passage_key": "api/openai",
        "max_tokens": 4096, "is_reasoning": False,
    },
    # Cohere v2 Chat
    "north_mini_code": {
        "name": "Cohere North Mini Code 1.0", "fmt": "cohere",
        "url": "https://api.cohere.com/v2/chat",
        "model": "north-mini-code", "passage_key": "api/cohere",
        "max_tokens": 16000, "is_reasoning": True,  # thinking model — needs big budget
    },
    # Claude Fable 5 — first of Claude 5 family. Anthropic-native, thinking always-on.
    # Per Ken Huang 2026-07-05: post-7/1 retraining flags security-adjacent
    # prompts more aggressively; refusals arrive as stop_reason="refusal".
    "fable5": {
        "name": "Claude Fable 5 (Claude 5 family, thinking always-on)", "fmt": "anthropic",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-fable-5", "passage_key": "api/anthropic",
        "max_tokens": 4096, "is_reasoning": True,
    },
}


def resolve_key(passage_key: str) -> str:
    try:
        out = subprocess.run(["passage", "show", passage_key],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Fall back to ANTHROPIC_API_KEY env var (real Anthropic API for Sonnet/Opus)
        env_key = os.environ.get("ANTHROPIC_API_KEY")
        if env_key:
            return env_key
        raise


# Fable 5 effort dial: low | medium | high | xhigh | max (default high).
_DEFAULT_EFFORT = "high"
_VALID_EFFORT = {"low", "medium", "high", "xhigh", "max"}

def _effort_level() -> str:
    """Parse --effort=<level> or --effort <level> from argv. Default "high"."""
    args = sys.argv
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--effort="):
            v = a.split("=", 1)[1]
        elif a == "--effort" and i + 1 < len(args):
            v = args[i + 1]
            i += 1
        else:
            i += 1
            continue
        if v not in _VALID_EFFORT:
            raise SystemExit(f"--effort must be one of {sorted(_VALID_EFFORT)}, got {v!r}")
        return v
    return _DEFAULT_EFFORT


# ── Callers ──────────────────────────────────────────────────────────────────

def call_anthropic(cfg, prompt, max_tokens=None):
    api_key = resolve_key(cfg["passage_key"])
    payload = {
        "model": cfg["model"],
        "max_tokens": max_tokens or cfg["max_tokens"],
        "messages": [{"role": "user", "content": prompt}],
    }
    # Fable 5: effort via output_config. No temperature / thinking param.
    if cfg["model"] == "claude-fable-5":
        payload["output_config"] = {"effort": _effort_level()}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(cfg["url"], data=data, headers={
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.load(resp)
            stop_reason = result.get("stop_reason")
            content = result.get("content", [])
            # Fable 5 / Claude 5 family refuses inside a 200 response.
            if stop_reason == "refusal":
                details = (result.get("stop_details") or {}).get("reason", "refused")
                return "", time.time() - t0, f"REFUSAL:{details}"
            text = "".join(b.get("text", "") for b in content
                          if isinstance(b, dict) and b.get("type") == "text")
            return text, time.time() - t0, ""
    except urllib.error.HTTPError as e:
        return "", time.time() - t0, f"HTTP{e.code}:{e.read().decode()[:120]}"
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"


def call_openai(cfg, prompt, max_tokens=None):
    api_key = resolve_key(cfg["passage_key"])
    # OpenAI gpt-5.x rejects `max_tokens` and requires `max_completion_tokens`.
    # Mistral + NIM still accept `max_tokens`. Detect via URL host.
    is_openai_native = "api.openai.com" in cfg["url"]
    token_field = "max_completion_tokens" if is_openai_native else "max_tokens"
    is_labs = cfg.get("model", "").startswith("labs-")
    payload = {
        "model": cfg["model"],
        token_field: max_tokens or cfg["max_tokens"],
        "messages": [{"role": "user", "content": prompt}],
    }
    if is_labs:
        payload["temperature"] = 1.0
        payload["top_p"] = 1.0
    data = json.dumps(payload).encode()
    req = urllib.request.Request(cfg["url"], data=data, headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.load(resp)
            choices = result.get("choices", [])
            if not choices:
                return "", time.time() - t0, "ERR:no_choices"
            msg = choices[0].get("message", {})
            content = msg.get("content")
            # NIM reasoning models return content as None or as a list of blocks
            if content is None:
                return "", time.time() - t0, f"ERR:content_null:{json.dumps(result)[:150]}"
            if isinstance(content, list):
                # Type-filter for thinking/list responses: keep only type=="text" blocks
                text = "".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") in ("text", None)
                )
                if not text:
                    return "", time.time() - t0, f"ERR:no_text_blocks:{json.dumps(result)[:150]}"
                return text, time.time() - t0, ""
            return content, time.time() - t0, ""
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:120]
        except Exception:
            pass
        return "", time.time() - t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"


def call_cohere(cfg, prompt, max_tokens=None):
    api_key = resolve_key(cfg["passage_key"])
    # For thinking models, always use the endpoint's max_tokens (large budget).
    # Per-test max_tokens are tuned for chat models and starve the thinking model.
    effective = cfg["max_tokens"] if cfg.get("is_reasoning") else (max_tokens or cfg["max_tokens"])
    payload = {
        "model": cfg["model"],
        "max_tokens": effective,
        "messages": [{"role": "user", "content": prompt}],
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(cfg["url"], data=data, headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.load(resp)
            content = result.get("message", {}).get("content", [])
            text = "".join(b.get("text", "") for b in content
                          if isinstance(b, dict) and b.get("type") == "text")
            if not text:
                # Return debug info on empty
                return "", time.time() - t0, f"ERR:cohere_empty:{json.dumps(result)[:200]}"
            return text, time.time() - t0, ""
    except urllib.error.HTTPError as e:
        return "", time.time() - t0, f"HTTP{e.code}:{e.read().decode()[:120]}"
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"


# Generation confirmed 2026-07-22: 3.6 Flash / 3.5 Flash-Lite reject thinkingBudget:0 with
# HTTP 400 INVALID_ARGUMENT (budget -1 and omitting the field both work) — thinking can no
# longer be fully disabled on these models. Older Flash variants accept budget 0 fine.
GEMINI_NO_ZERO_BUDGET_MODELS = {"gemini-3.6-flash", "gemini-3.5-flash-lite"}

# 3.6 Flash specifically: even at thinkingBudget:1 (the minimum legal value), thoughtsTokenCount
# ranged 6-218 in spot checks and silently eats the response budget — small max_tokens values
# come back MAX_TOKENS with empty content. 3.5 Flash-Lite showed no such overhead with
# thinkingConfig omitted entirely (scored 46/53 clean), so it's not given this treatment.
GEMINI_ALWAYS_THINKS_MODELS = {"gemini-3.6-flash"}
GEMINI_THINKING_OVERHEAD_FLOOR = 1024

def call_gemini(cfg, prompt, max_tokens=None):
    api_key = resolve_key(cfg["passage_key"])
    model = cfg["model"]
    max_tok = max_tokens or cfg["max_tokens"]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    if model in GEMINI_ALWAYS_THINKS_MODELS:
        gen_config = {"maxOutputTokens": max(max_tok, GEMINI_THINKING_OVERHEAD_FLOOR), "temperature": 0.1,
                      "thinkingConfig": {"thinkingBudget": 1}}
    else:
        gen_config = {"maxOutputTokens": max_tok, "temperature": 0.1}
        if model not in GEMINI_NO_ZERO_BUDGET_MODELS:
            gen_config["thinkingConfig"] = {"thinkingBudget": 0}
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": gen_config,
    }
    t0 = time.time()
    backoff = 5
    for attempt in range(5):
        try:
            req = urllib.request.Request(
                url, json.dumps(payload).encode(), {"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                result = json.load(resp)
                elapsed = time.time() - t0
                err = result.get("error")
                if err:
                    return "", elapsed, f"API:{err.get('message','')[:80]}"
                candidates = result.get("candidates", [])
                if not candidates:
                    return "", elapsed, "NO_CANDIDATES"
                parts = candidates[0].get("content", {}).get("parts", [])
                text = " ".join(p.get("text","") for p in parts
                               if p.get("text","").strip() and not p.get("thought", False))
                return text.strip(), elapsed, ""
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:120]
            if e.code == 503 and attempt < 4:
                print(f"    [503 retry {attempt+1}/4 — backoff {backoff}s]", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue
            return "", time.time() - t0, f"HTTP{e.code}:{body}"
        except Exception as e:
            return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"
    return "", time.time() - t0, "MAX_RETRIES"


def call_api(cfg, prompt, max_tokens=None):
    fmt = cfg["fmt"]
    if fmt == "anthropic":
        return call_anthropic(cfg, prompt, max_tokens)
    elif fmt == "openai":
        return call_openai(cfg, prompt, max_tokens)
    elif fmt == "cohere":
        return call_cohere(cfg, prompt, max_tokens)
    elif fmt == "gemini":
        return call_gemini(cfg, prompt, max_tokens)
    else:
        return "", 0.0, f"ERR:unknown_fmt:{fmt}"


# ── C1 prompt + scorer ──────────────────────────────────────────────────────

C1_PROMPT = '''Write a TypeScript function:

  parseAuthHeader(header: string, nowMs: number): ParseResult

  type ParseResult =
    | { valid: true; token: string }
    | { valid: false; reason: 'missing' | 'malformed' | 'expired' };

Behavior:
- `header === ''` (after trim) -> { valid: false, reason: 'missing' }
- `header` does not match `/^Bearer\\s+(\\S+)$/i` (case-insensitive scheme) -> { valid: false, reason: 'malformed' }
- Token is base64url-encoded JSON. Decode it; if the decoded JSON has a numeric `exp` field, and `exp * 1000 <= nowMs`, -> { valid: false, reason: 'expired' }
- If the token decodes but has no `exp` field, it is NOT expired (treat as opaque).
- Otherwise -> { valid: true, token: <raw token string> }

Constraints:
- No `any`. No `as` casts.
- Use a `switch` on `reason` (in a helper that consumes `ParseResult`) to demonstrate the exhaustive `never` check. Or write the helper inline.
- Signature must be exactly as shown. Don't add optional params.

Just the code (with imports). No explanation.'''


def score_c1(response: str) -> tuple[int, list[str]]:
    """Returns (score 0-3, list of reasons)."""
    notes = []
    score = 0
    r = response

    # Strip markdown fences for analysis
    code = re.sub(r'```[a-z]*\n?', '', r).strip()
    # Strip comments so "treat as opaque" doesn't count as a cast
    code_no_comments = re.sub(r'//.*$', '', code, flags=re.MULTILINE)

    # Check 0: any/as disqualifiers
    if re.search(r'\bany\b', code) and ': any' in code:
        notes.append("uses any")
        return 0, notes
    # 'as' cast: must not appear except possibly for base64url OR type-narrowing `unknown`
    # Strip comments FIRST, then count casts. Allow up to 2 casts for `unknown` narrowing.
    as_casts = re.findall(r'\bas\s+[A-Za-z<>[\]]+', code_no_comments)
    legitimate_casts = 0
    for cast in as_casts:
        # Cast is legitimate if it's part of a base64url decode or unknown narrowing
        if re.search(r'atob|base64|decode', code, re.I):
            legitimate_casts += 1
        elif re.search(r'unknown|as\s+Record<|as\s+number|as\s+string', code, re.I):
            legitimate_casts += 1
    if len(as_casts) > legitimate_casts:
        notes.append(f"uses 'as' cast beyond allowed contexts: {as_casts}")
        return 0, notes
    if as_casts:
        notes.append(f"as casts (legitimate): {len(as_casts)}")

    # Check signature match
    if 'parseAuthHeader' not in code or 'nowMs' not in code:
        notes.append("signature mismatch")
        return 0, notes

    # Check reject paths
    has_missing = "missing" in code.lower()
    has_malformed = "malformed" in code.lower()
    has_expired = "expired" in code.lower()
    paths_found = sum([has_missing, has_malformed, has_expired])
    notes.append(f"reject paths: missing={has_missing} malformed={has_malformed} expired={has_expired}")

    if paths_found < 2:
        return 0, notes
    elif paths_found < 3:
        score = 1
        notes.append("2 of 3 reject paths")
    else:
        # All 3 paths — score depends on never-check
        score = 2

    # Check never exhaustive
    has_never = re.search(r'\bnever\b', code) is not None
    has_switch = re.search(r'\bswitch\s*\(', code) is not None
    if has_never and has_switch:
        score = 3
        notes.append("never exhaustive check present")
    elif has_never:
        score = max(score, 2)
        notes.append("has 'never' but no switch on reason")
    else:
        notes.append("no never exhaustive check")

    return score, notes


# ── C2 prompt + scorer ──────────────────────────────────────────────────────

C2_PROMPT = '''This Bun script crashes intermittently in production. Find the bug, explain why it happens, give me a minimal fix, and a 3-line repro that fails on the unfixed code.

Symptom: ~1 in 50 worker runs exits silently with this stack trace:

  TypeError: undefined is not an object (evaluating 'response.headers.get')
    at fetchWithRetry (/home/me/proj/lib/http.ts:42:24)
    at processJob (/home/me/proj/worker.ts:118:10)
    at async run (/home/me/proj/worker.ts:50:5)

Code:
```typescript
// lib/http.ts
export async function fetchWithRetry(url: string, opts: RequestInit = {}, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, opts);
      if (response.status >= 500 && i < attempts - 1) {
        await new Promise(r => setTimeout(r, 100 * 2 ** i));
        continue;
      }
      return response;
    } catch (err) {
      if (i === attempts - 1) throw err;
    }
  }
  return fetch(url, opts);  // line 42
}
```

The endpoint returns 500 ~2% of the time. Workers don't crash visibly; they just disappear.'''


def score_c2(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response.lower()
    score = 0

    # Identifies the line-42 fallthrough pattern. Accept multiple phrasings:
    # - "line 42" literally
    # - "fallthrough" / "falls through" / "fall through"
    # - "after the loop" / "after the retry loop"
    # - "bare fetch" / "unconditional fetch" / "extra fetch"
    # - "fetch at the end" / "final fetch" / "return fetch"
    bug_pattern = bool(re.search(
        r'line\s*42|fall\s*through|fallthrough|after\s*(?:the\s*)?(?:retry\s*)?loop|'
        r'bare\s*fetch|unconditional\s*fetch|extra\s*fetch|fetch\s*at\s*the\s*end|'
        r'final\s*fetch\s*\(.*\)\s*$|return\s+fetch\s*\(\s*url', r, re.M | re.I))
    mentions_undefined = 'undefined' in r or 'response is undefined' in r or 'no response' in r or 'unhandled' in r

    if not bug_pattern:
        notes.append("does not identify line-42 fallthrough / final-fetch bug")
        return 0, notes
    elif 'try/catch' in r and 'worker' in r and not mentions_undefined:
        notes.append("blames worker / generic try-catch")
        return 0, notes
    elif not mentions_undefined:
        notes.append("identifies bug but wrong cause")
        return 1, notes

    # Has correct cause and repro
    has_repro = bool(re.search(r'repro|reproduce|test case|to reproduce', r))
    has_fix = bool(re.search(r'fix|solution|patch|change|restructure|move.*inside|throw', r))
    fix_is_idiomatic = bool(re.search(r'inside.*loop|throw new|loop.*restructure|instead of return|don.t return|move\s+the\s+throw', r))

    if bug_pattern and mentions_undefined and not has_repro and not has_fix:
        notes.append("correct cause, no fix or repro")
        return 1, notes
    if bug_pattern and mentions_undefined and has_fix and not fix_is_idiomatic:
        notes.append("correct cause, fix is a guard not restructure")
        return 2, notes
    if bug_pattern and mentions_undefined and has_fix and has_repro:
        score = 3
        notes.append("full diagnosis + idiomatic fix + repro")
    elif bug_pattern and mentions_undefined and has_fix:
        score = 2
        notes.append("correct cause + fix, no repro")

    return score, notes


# ── C3 prompt + scorer ──────────────────────────────────────────────────────

C3_PROMPT = '''Refactor these 3 files to extract the Basic auth construction into a single `auth.ts` module. Don't change observable behavior. Show me the new contents of all 3 files.

Before:

```typescript
// a.ts
import { b } from "./b";
export function getProfile(user: string, pw: string): Promise<unknown> {
  if (!user || !pw) throw new Error("missing creds");
  const tok = Buffer.from(`${user}:${pw}`).toString("base64");
  return b(`Basic ${tok}`);
}

// b.ts
import { c } from "./c";
export function b(auth: string): Promise<unknown> {
  return c({ headers: { Authorization: auth } });
}

// c.ts
export function c(opts: { headers: Record<string, string> }): Promise<unknown> {
  return fetch("https://api.example.com/me", opts).then(r => r.json());
}
```

Constraints:
- `getProfile`, `b`, `c` must keep their exact signatures.
- All `Buffer.from(...).toString("base64")` Basic-auth construction must happen in `auth.ts` (no leakage of `Buffer` to `a.ts` or `b.ts`).
- `b.ts` should not need to know that Basic auth is in use - it just passes an `Authorization` header value.
- Add minimal type annotations to make the new module boundary self-documenting.'''


def score_c3(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response
    score = 0

    # Look for auth.ts
    has_auth_ts = bool(re.search(r'auth\.ts', r))
    has_three_files = bool(re.search(r'a\.ts', r)) and bool(re.search(r'b\.ts', r)) and bool(re.search(r'c\.ts', r))

    if not has_auth_ts or not has_three_files:
        notes.append("missing auth.ts or one of the 3 files")
        return 0, notes

    # Check signatures preserved.
    # c.ts legitimately doesn't need to change in this refactor — allow "unchanged" declarations.
    has_getprofile = 'getProfile' in r
    has_func_b = re.search(r'(?:export\s+)?function\s+b\s*\(', r) is not None
    has_func_c = re.search(r'(?:export\s+)?function\s+c\s*\(', r) is not None
    c_unchanged = bool(re.search(r'c\.ts\s+is\s+(?:unchanged|not\s+changed|the\s+same)|c\.ts\s+(?:unchanged|not\s+modified|stays)|no\s+change.*c\.ts|c\.ts.*no\s+change', r, re.I))

    if not has_getprofile:
        notes.append("getProfile not preserved")
        return 0, notes
    if not has_func_b:
        notes.append("function b() not preserved")
        return 0, notes
    if not has_func_c and not c_unchanged:
        notes.append("function c() not preserved (and c.ts not declared unchanged)")
        return 0, notes

    # Check Buffer only in auth.ts
    # Split response into sections by filename
    sections = re.split(r'//\s*(\w+\.ts)|```\w*\n?//\s*(\w+\.ts)', r)
    buffer_in_a_or_b = False
    for section in sections:
        if not section:
            continue
        # crude: check if 'a.ts' or 'b.ts' section contains Buffer
        if re.search(r'\bBuffer\.from', section):
            # need to know which file this section belongs to
            pass

    # Simpler: look for explicit "a.ts" or "b.ts" headers with Buffer
    a_section = re.search(r'(?:^|\n)(?://\s*)?a\.ts[\s\S]+?(?=(?://\s*)?b\.ts|```\s*$)', r, re.M)
    b_section = re.search(r'(?:^|\n)(?://\s*)?b\.ts[\s\S]+?(?=(?://\s*)?c\.ts|```\s*$)', r, re.M)
    c_section = re.search(r'(?:^|\n)(?://\s*)?c\.ts[\s\S]+?(?=(?://\s*)?$|```\s*$)', r, re.M)

    if a_section and 'Buffer' in a_section.group():
        buffer_in_a_or_b = True
        notes.append("Buffer leaked to a.ts")
    if b_section and 'Buffer' in b_section.group():
        buffer_in_a_or_b = True
        notes.append("Buffer leaked to b.ts")

    if buffer_in_a_or_b:
        return 1, notes

    # Check basicAuth export in auth.ts
    auth_section = re.search(r'(?:^|\n)(?://\s*)?auth\.ts[\s\S]+?(?=(?://\s*)?a\.ts|```\s*$)', r, re.M)
    # Look for any function that returns a string + is exported (basicAuth, buildAuth, createAuthHeader, etc.)
    auth_has_exported_func = False
    if auth_section:
        auth_text = auth_section.group()
        if re.search(r'export\s+(?:function|const)\s+\w+', auth_text):
            # Has an exported function/const — check it returns a string
            if re.search(r':\s*string\b|=>\s*string\b', auth_text):
                auth_has_exported_func = True
        # Fall back to the exact basicAuth name
        if 'basicAuth' in auth_text:
            auth_has_exported_func = True

    if not auth_section or not auth_has_exported_func:
        notes.append("auth.ts missing string-returning export (basicAuth or equivalent)")
        return 1, notes

    # Check a.ts uses the auth helper (any import from ./auth)
    if a_section and not re.search(r'from\s+["\']\./auth["\']', a_section.group()):
        notes.append("a.ts doesn't import from ./auth")
        return 1, notes

    score = 2
    notes.append("all 3 files correct, signatures preserved, Buffer only in auth.ts")

    # Check 3: imports consistent (all relative ./x)
    all_imports = re.findall(r'import\s+.*?from\s+["\']([^"\']+)["\']', r)
    relative_imports = [imp for imp in all_imports if imp.startswith('./')]
    if len(all_imports) > 0 and len(relative_imports) == len(all_imports):
        score = 3
        notes.append("clean module boundary + consistent relative imports")
    else:
        notes.append(f"imports: relative={len(relative_imports)}/{len(all_imports)}")

    return score, notes


# ── C4 prompt + scorer ──────────────────────────────────────────────────────

C4_PROMPT = '''Write 4+ vitest tests for this function. Each test should fail on the buggy code and target one specific failure mode. Use descriptive test names that match the bug.

```typescript
// buggy.ts
export function normalizeRecords(records: Array<Record<string, unknown>>): Array<Record<string, string>> {
  return records
    .filter(r => r.deleted !== true)
    .map(r => {
      const out: Record<string, string> = {};
      for (const k of Object.keys(r)) {
        out[k] = String(r[k]);
      }
      return out;
    });
}
```

The function is supposed to:
1. Skip records where `deleted === true`
2. Convert every value to a string
3. Drop keys whose values are `null` or `undefined`
4. Return `[]` when given `[]`

It is called like this in production:
```typescript
const cleaned = normalizeRecords(await db.query("SELECT * FROM users"));
await api.post("/sync", { users: cleaned });
```

Write 4+ failing tests. Name each test after the bug it catches.'''


def score_c4(response: str) -> tuple[int, list[str]]:
    """Heuristic: count vitest test blocks; check names for bug patterns.
    Accepts both it() and test() (vitest synonyms)."""
    notes = []
    r = response

    # Count it() AND test() blocks (vitest accepts both)
    it_blocks = re.findall(r'\bit\(\s*["\']([^"\']+)["\']', r)
    test_blocks = re.findall(r'\btest\(\s*["\']([^"\']+)["\']', r)
    all_blocks = it_blocks + test_blocks
    n_tests = len(all_blocks)
    notes.append(f"found {n_tests} tests (it={len(it_blocks)} test={len(test_blocks)})")

    if n_tests < 4:
        return min(n_tests, 1), notes

    # Check for bug-targeting names
    name_text = " ".join(all_blocks).lower()
    has_deleted = 'deleted' in name_text or 'string' in name_text or 'skip' in name_text
    has_null = 'null' in name_text or 'undefined' in name_text or 'drop' in name_text
    has_lru = 'recency' in name_text or 'lru' in name_text or 'recent' in name_text
    has_proto = 'proto' in name_text or 'inherit' in name_text

    bug_targets = sum([has_deleted, has_null, has_proto])
    notes.append(f"bug patterns: deleted={has_deleted} null/drop={has_null} proto={has_proto}")

    if n_tests == 4 and bug_targets < 2:
        return 1, notes
    if n_tests == 4 and bug_targets == 2:
        return 2, notes
    if n_tests >= 4 and bug_targets >= 3:
        return 3, notes
    if n_tests >= 5 and bug_targets >= 3:
        return 4, notes
    if n_tests >= 5 and bug_targets >= 4:
        # Check for positive case
        if 'passes through' in name_text or 'normal' in name_text or 'happy' in name_text:
            return 5, notes
        return 4, notes

    return min(n_tests - 1, 4), notes


# ── C5 prompt + scorer ──────────────────────────────────────────────────────

C5_PROMPT = '''Design a REST API for managing API keys. The resource is an API key with: id, name, prefix (first 8 chars of the key, used for display), hash (sha256 of the key, never returned), scopes (array of strings), createdAt, lastUsedAt, revokedAt.

Endpoints needed:
- Create a key (returns the FULL key value ONCE, never again)
- List keys (returns prefix + metadata, never the hash or full value)
- Revoke a key
- Rotate a key (atomic: revoke + create new with same name)

Non-negotiables (these are the rubric dimensions):
1. **Secret handling** - full key only on create/rotate, NEVER on list. Hash NEVER leaves the server. Prefix is fine to return.
2. **Auth** - every endpoint requires a valid JWT with `keys:write` scope. List may use `keys:read`. Show the scope check.
3. **Methods/paths** - RESTful: POST /keys, GET /keys, DELETE /keys/:id (or PATCH with `{revoked: true}`), POST /keys/:id/rotate. POST /keys/:id/revoke is WRONG.
4. **Error contract** - uniform envelope across all endpoints. Example: `{ "error": { "code": "string_constant", "message": "human readable", "details": {...} } }`. Status codes: 400 (validation), 401 (no auth), 403 (wrong scope), 404 (not found), 409 (conflict - e.g. name in use on rotate), 500 (server).
5. **Atomic rotation** - POST /keys/:id/rotate must be a single transaction: mark old key revoked AND create new key with the same name AND return the new full key. Two separate calls (revoke + create) is a race condition and scores 0 on this dimension.

Specify:
- HTTP methods + paths
- Request/response shape (JSON, with TypeScript types)
- Error contract: full envelope spec
- Auth: where the scope check happens

Be precise. Show me the TypeScript types and one example error response.'''


def score_c5(response: str) -> tuple[int, list[str]]:
    """Score on 5 non-negotiables; total 0-5. Tolerates markdown table format."""
    notes = []
    r = response

    # 1. Secret handling: full key only on create/rotate, never on list.
    # Find the GET /keys section. Use a simple section delimiter: stop at the
    # start of a line that BEGINS with another HTTP method (not prose mentions).
    list_section = re.search(
        r'(?:^|\n)\s*[`*]?\s*GET\s+[^\n]*/keys[^\n]*\n[\s\S]+?'
        r'(?=(?:^|\n)\s*[`*]?\s*(?:POST|DELETE|PATCH|PUT)\s+[^\n]*/|$)',
        r, re.I | re.M)
    list_safe = True
    if list_section:
        list_text = list_section.group().lower()
        # If list section mentions "full key" without "never" nearby, fail
        if 'full' in list_text and 'key' in list_text and 'never' not in list_text:
            list_safe = False
        if 'hash' in list_text and 'never' not in list_text and 'no hash' not in list_text:
            list_safe = False
    secret_ok = list_safe
    notes.append(f"secret handling (no full key/hash in list): {secret_ok}")

    # 2. Auth: scope check (also accept "scopes" plural or "authorization")
    has_scope = re.search(r'\bkeys:write\b|\bkeys:read\b|\bscopes?\b', r, re.I) is not None
    has_jwt = re.search(r'\bjwt\b', r, re.I) is not None
    auth_ok = has_scope and has_jwt
    notes.append(f"auth (JWT + scope): {auth_ok}")

    # 3. Methods/paths: POST /keys, GET /keys, DELETE/PATCH /keys/:id, POST /keys/:id/rotate
    # Markdown table format: "| POST | `/keys` | ..." — the path is wrapped in backticks,
    # pipes separate cells. Use a tolerant pattern that allows markdown table punctuation.
    def has_method_path(method, path_pat):
        # Match: METHOD [whitespace|pipes|backticks]+ /keys[/path]
        return re.search(
            rf'\b{method}\b\s*[|`\s]*`?{path_pat}', r, re.I
        ) is not None

    has_post_keys = has_method_path('POST', r'/keys(?![^`]*`\s*[/])')
    has_get_keys = has_method_path('GET', r'/keys(?![^`]*`\s*[/])')
    has_delete = has_method_path('DELETE', r'/keys/\S+') or has_method_path('PATCH', r'/keys/\S+')
    has_rotate = re.search(r'\brotate\b', r, re.I) is not None
    has_wrong_revoke = re.search(r'POST\s+[|`\s]*`?/keys/\S+/revoke', r, re.I) is not None
    paths_ok = has_post_keys and has_get_keys and has_delete and has_rotate and not has_wrong_revoke
    notes.append(f"paths: POST={has_post_keys} GET={has_get_keys} DEL/PATCH={has_delete} rotate={has_rotate} wrong={has_wrong_revoke}")

    # 4. Error contract: uniform envelope
    has_envelope = re.search(r'\{?\s*["\']?error["\']?\s*:\s*\{', r) is not None
    has_status_codes = all(code in r for code in ['400', '401', '403', '404'])
    error_ok = has_envelope and has_status_codes
    notes.append(f"error contract (envelope + status codes): {error_ok}")

    # 5. Atomic rotation: 1 endpoint, transaction
    has_atomic = re.search(r'\b(?:atomic|single\s+transaction|same\s+transaction|one\s+transaction)\b', r, re.I) is not None
    has_409 = '409' in r
    has_two_calls = re.search(r'two\s+(?:separate\s+)?calls|revoke.*then.*create|first.*revoke.*then', r, re.I) is not None
    rotation_ok = has_atomic and has_409 and not has_two_calls
    notes.append(f"atomic rotation: atomic={has_atomic} 409={has_409} two_calls={has_two_calls}")

    score = sum([secret_ok, auth_ok, paths_ok, error_ok, rotation_ok])
    return score, notes


# ── C6 prompt + scorer ──────────────────────────────────────────────────────

C6_PROMPT = '''Write a bash function `backup-and-rotate` that:
1. Takes a directory path as $1
2. Creates a tar.gz of the directory at /backup/$(basename $1)-$(date +%Y%m%d-%H%M%S).tar.gz
3. Keeps only the 5 most recent backups in /backup/ (deletes older ones)
4. Exits 0 on success, non-zero on any failure
5. Logs what it did to stderr

Constraints:
- Use `set -euo pipefail` at the top
- Use `mktemp` for any temp files
- Don't `eval`
- Quote all variables
- If the source directory doesn't exist, exit 1 with a message to stderr
- Filenames in /backup/ may contain spaces, newlines, or leading dashes - the rotation step MUST handle these correctly (use null-delimited iteration)

Show me the function with a one-line example of how to call it.'''


def score_c6(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response

    # Strip code fences
    code = re.sub(r'```[a-z]*\n?', '', r).strip()

    has_strict = bool(re.search(r'set\s+-[a-z]*e.*-?[a-z]*u.*-?[a-z]*o.*pipefail|set\s+-[a-z]*euo\s*pipefail', code))
    has_mktemp = 'mktemp' in code
    # Only flag eval as a disqualifier if it appears as an actual command (not in a comment/summary).
    # Strip backticks and check for `eval ` (with trailing space) or `eval$` (end of word/line)
    code_no_backticks = code.replace('`', '')
    has_eval = bool(re.search(r'\beval\s+["\']|\beval\s+\$', code_no_backticks))
    # Existence check: match -d followed by any variable (e.g. -d "$1" or -d "$src")
    has_existence_check = bool(re.search(r'-d\s+["\']?\$', code)) or bool(re.search(r'if\s+\[\s*!\s*-d', code))

    if not has_strict:
        notes.append("missing set -euo pipefail")
        return 0, notes
    if has_eval:
        notes.append("uses eval (disqualifier)")
        return 0, notes
    if not has_existence_check:
        notes.append("no existence check on $1")
        return 0, notes

    # Check for filename safety in rotation
    has_null_delimited = bool(re.search(r'-print0|-z\s*["\']?\s*\\?\s*0?-?d\s*["\']?\s*["\']?\s*0', code)) or bool(re.search(r'read\s+-r\s+-d\s+["\']?\\?0', code)) or 'IFS=' in code
    has_unsafe_xargs = bool(re.search(r'xargs\s+(?!-0|-r)', code)) and not has_null_delimited
    has_unsafe_ls_xargs = bool(re.search(r'\bls\b.*\|\s*xargs', code)) and not has_null_delimited

    has_trap = bool(re.search(r'\btrap\s+', code))
    has_atomic_write = bool(re.search(r'mv\s+.*\s+["\']?/backup/', code)) and bool(re.search(r'tmp|mktemp', code))

    if has_unsafe_xargs or has_unsafe_ls_xargs:
        notes.append("rotation breaks on spaces (ls|xargs without -print0)")
        return 1, notes
    if not has_null_delimited:
        notes.append("no null-delimited iteration (would break on spaces/newlines)")
        return 1, notes

    if not has_trap and not has_atomic_write:
        notes.append("null-delimited rotation, no trap or atomic write")
        return 2, notes

    notes.append("null-delimited rotation + trap or atomic write")
    return 3, notes


# ── Test registry ────────────────────────────────────────────────────────────

TESTS = [
    ("C1", "TS-strict type narrowing", 3, C1_PROMPT, score_c1, 2500),
    ("C2", "Debug from stack trace + repro", 3, C2_PROMPT, score_c2, 2500),
    ("C3", "Multi-file refactor", 3, C3_PROMPT, score_c3, 3000),
    ("C4", "Test generation", 5, C4_PROMPT, score_c4, 3000),
    ("C5", "REST API design", 5, C5_PROMPT, score_c5, 3000),
    ("C6", "Bash / shell scripting", 3, C6_PROMPT, score_c6, 2000),
]


# ── C8: TTLCache against vitest ──────────────────────────────────────────────

CACHE_STUB = '''export type CacheOptions<V> = {
  maxEntries: number;
  now?: () => number;
  defaultTtlMs?: number;
};

export class TTLCache<K, V> {
  constructor(opts: CacheOptions<V>) { throw new Error("not implemented"); }
  get(key: K): V | undefined { throw new Error("not implemented"); }
  set(key: K, value: V, ttlMs?: number): void { throw new Error("not implemented"); }
  delete(key: K): boolean { throw new Error("not implemented"); }
  clear(): void { throw new Error("not implemented"); }
  get size(): number { throw new Error("not implemented"); }
}
'''

CACHE_TESTS = '''import { describe, it, expect, beforeEach } from "vitest";
import { TTLCache } from "./cache";

describe("TTLCache", () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => { now = 1_000_000; });

  it("returns undefined for missing key", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    expect(c.get("nope")).toBeUndefined();
  });

  it("returns the value after set", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 5000);
    expect(c.get("a")).toBe(1);
  });

  it("expires entries after TTL", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 1000);
    now += 1001;
    expect(c.get("a")).toBeUndefined();
  });

  it("refreshes TTL on set with same key", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 1000);
    now += 500;
    c.set("a", 2, 1000);
    now += 700;
    expect(c.get("a")).toBe(2);
  });

  it("delete returns true if key existed", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 5000);
    expect(c.delete("a")).toBe(true);
    expect(c.delete("a")).toBe(false);
  });

  it("evicts least-recently-used when over capacity", () => {
    const c = new TTLCache<string, number>({ maxEntries: 2, now: clock });
    c.set("a", 1, 60_000); now += 10;
    c.set("b", 2, 60_000); now += 10;
    c.get("a"); now += 10;
    c.set("c", 3, 60_000);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });

  it("get updates recency", () => {
    const c = new TTLCache<string, number>({ maxEntries: 2, now: clock });
    c.set("a", 1, 60_000); now += 10;
    c.set("b", 2, 60_000); now += 10;
    c.get("a"); now += 10;
    c.set("c", 3, 60_000);
    expect(c.get("b")).toBeUndefined();
  });

  it("clear empties the cache", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 5000);
    c.set("b", 2, 5000);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });
});
'''

C8_PROMPT = f'''Implement the methods of TTLCache so all the tests in cache.test.ts pass. You may NOT modify the tests. tsconfig has strict mode on.

Show me the full new contents of cache.ts.

The current stub is:

```typescript
{CACHE_STUB}
```

The tests are:

```typescript
{CACHE_TESTS}
```'''


def extract_code_block(response: str) -> str:
    """Extract the model's cache.ts implementation from a code block."""
    # Try to find ```typescript or ```ts block; fall back to first code block
    m = re.search(r'```(?:typescript|ts)\n(.*?)```', response, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r'```\n(.*?)```', response, re.DOTALL)
    if m:
        return m.group(1).strip()
    # No code block; assume whole response is code
    return response.strip()


def run_c8(cfg, response: str) -> tuple[int, list[str]]:
    """Write the model's cache.ts into a tmp dir, run vitest, count passing tests."""
    notes = []
    code = extract_code_block(response)

    if 'class TTLCache' not in code:
        notes.append("no TTLCache class in response")
        return 0, notes

    # Create tmp project
    work = Path(tempfile.mkdtemp(prefix="c8-"))
    try:
        (work / "src").mkdir()
        (work / "src" / "cache.ts").write_text(code)
        (work / "src" / "cache.test.ts").write_text(CACHE_TESTS)
        (work / "tsconfig.json").write_text('{"compilerOptions": {"strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "esModuleInterop": true, "skipLibCheck": true, "noEmit": true, "types": []}, "include": ["src/**/*"]}')
        (work / "package.json").write_text('{"name": "c8", "type": "module", "scripts": {"test": "vitest run"}}')

        # Install vitest if not present
        env = os.environ.copy()
        env["BUN_INSTALL_CACHE_DIR"] = str(work / ".bun-cache")
        install = subprocess.run(
            ["bun", "add", "-d", "vitest", "typescript@5", "@types/node"],
            cwd=work, capture_output=True, text=True, timeout=120, env=env,
        )
        if install.returncode != 0:
            notes.append(f"vitest install failed: {install.stderr[:120]}")
            return 0, notes

        # Run vitest
        result = subprocess.run(
            ["bunx", "vitest", "run"],
            cwd=work, capture_output=True, text=True, timeout=60, env=env,
        )
        out = result.stdout + result.stderr

        # Parse pass/fail count
        # Format 1: "Tests  8 passed (8)" (all passing)
        # Format 2: "Tests  5 passed | 3 failed (8)" (mixed)
        m = re.search(r'Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?\s*\(\d+\)', out)
        if m:
            passed = int(m.group(1))
            failed = int(m.group(2)) if m.group(2) else 0
        else:
            # Fallback: count "✓" or "✗" / "passed" / "failed"
            passed = out.count('✓') + len(re.findall(r'\bpassed\b', out))
            failed = out.count('✗') + len(re.findall(r'\bfailed\b', out))

        notes.append(f"vitest: {passed} passed, {failed} failed")

        # Score
        if failed == 0 and passed >= 7:
            # Check for any/'as' (use 'any' as a type)
            any_count = len(re.findall(r':\s*any\b|<any>|as\s+any', code))
            if any_count > 0:
                notes.append(f"uses 'any' ({any_count}x) — penalizing to 3")
                return 3, notes
            notes.append("all tests pass, no 'any'")
            return 5, notes
        elif passed >= 5:
            return 4, notes
        elif passed >= 3:
            return 3, notes
        elif passed >= 1:
            return 2, notes
        else:
            return 0, notes
    except subprocess.TimeoutExpired:
        notes.append("vitest timeout")
        return 0, notes
    except Exception as e:
        notes.append(f"EXC: {type(e).__name__}: {str(e)[:80]}")
        return 0, notes
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── Main loop ────────────────────────────────────────────────────────────────

def main():
    target_filters = ["all"]
    skip_c8 = False
    c8_only = False
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == "--target" and i + 1 < len(sys.argv):
            target_filters.append(sys.argv[i + 1])
            i += 2
            continue
        if arg == "--skip-c8":
            skip_c8 = True
        if arg == "--c8-only":
            c8_only = True
        i += 1

    if not target_filters:
        targets = list(ENDPOINTS.keys())
    else:
        targets = [t for t in target_filters if t != "all"]
    # Dedupe, preserve order
    seen = set()
    targets = [t for t in targets if not (t in seen or seen.add(t))]

    if not targets:
        print(f"No valid targets. Use: {', '.join(ENDPOINTS.keys())}, all")
        sys.exit(1)

    for t in targets:
        run_target(t, skip_c8=skip_c8, c8_only=c8_only)


def run_target(target_key: str, skip_c8: bool = False, c8_only: bool = False):
    cfg = ENDPOINTS[target_key]
    print(f"\n{'═' * 80}")
    print(f"CODING BATTERY — {cfg['name']}")
    print(f"  URL:    {cfg.get('url', 'native-api')}")
    print(f"  Model:  {cfg['model']}  ({cfg['fmt']})")
    print(f"{'═' * 80}")

    results = []
    grand_total = 0
    grand_possible = 0
    wall_total = 0.0

    if not c8_only:
        print(f"\n{'Test':<6} {'Score':>10} {'/max':>6} {'Latency':>10}  Notes")
        print("─" * 100)
        for tid, label, max_score, prompt, scorer, max_tok in TESTS:
            response, elapsed, err = call_api(cfg, prompt, max_tokens=max_tok)
            wall_total += elapsed
            if err:
                print(f"  {tid:<4}  {'ERR':>10} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
                results.append({"id": tid, "label": label, "score": 0, "max": max_score, "err": err, "raw": ""})
                grand_possible += max_score
                _s = cfg.get("sleep", 1.0)
                if _s > 0: time.sleep(_s)
                continue
            score, notes = scorer(response)
            results.append({
                "id": tid, "label": label, "score": score, "max": max_score,
                "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes,
            })
            grand_total += score
            grand_possible += max_score
            marker = "✓" if score == max_score else ("~" if score > 0 else "✗")
            note_str = "; ".join(notes[:2])[:80]
            print(f"  {tid:<4}  {marker} {score}/{max_score:<3} {'/':>3}{max_score:<3} {elapsed:>8.2f}s  {note_str}")
            _s = cfg.get("sleep", 1.0)
            if _s > 0: time.sleep(_s)

    if not skip_c8:
        print(f"\n  C8   (TTLCache implementation vs vitest)")
        t0 = time.time()
        response, elapsed, err = call_api(cfg, C8_PROMPT, max_tokens=4000)
        wall_total += elapsed
        if err:
            print(f"  C8    {'ERR':>10} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": "C8", "label": "TTLCache vs vitest", "score": 0, "max": 5, "err": err, "raw": ""})
            grand_possible += 5
        else:
            score, notes = run_c8(cfg, response)
            results.append({
                "id": "C8", "label": "TTLCache vs vitest", "score": score, "max": 5,
                "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes,
            })
            grand_total += score
            grand_possible += 5
            marker = "✓" if score == 5 else ("~" if score > 0 else "✗")
            print(f"  C8    {marker} {score}/5    /5    {elapsed:>8.2f}s  {'; '.join(notes[:3])[:80]}")

    print("─" * 100)
    pct = 100 * grand_total / grand_possible if grand_possible else 0
    print(f"SCORE: {grand_total}/{grand_possible}  ({pct:.0f}%)  wall: {wall_total:.1f}s")

    # Save results — include effort suffix for Fable 5 runs so multiple effort levels
    # coexist on disk instead of clobbering each other.
    effort_tag = f"-{_effort_level()}" if cfg["model"] == "claude-fable-5" else ""
    out_path = f"/home/realuser/.claude/PAI/MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/coding-batt-{target_key}{effort_tag}.json"
    with open(out_path, "w") as f:
        json.dump({
            "target": cfg["name"],
            "model": cfg["model"],
            "fmt": cfg["fmt"],
            "timestamp": "2026-06-15",
            "score": f"{grand_total}/{grand_possible}",
            "pct": pct,
            "wall_s": wall_total,
            "results": results,
        }, f, indent=2)
    print(f"Results saved: {out_path}")


if __name__ == "__main__":
    main()
