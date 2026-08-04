"""Route narration via the Anthropic API.

Strictly optional. No key, no budget, or any failure at all means `narration`
stays `null` and the card reads "Description still being written…" — which is
why that copy exists in the frontend.

The model is given only what the route data already says. It is not asked to
infer anything about the place, because it has no way to know and a plausible
invention would be indistinguishable from a fact.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from .config import settings
from .fixtures import BudgetExhausted, FixtureMissing, fetch
from .logging_setup import get_logger
from .metrics import metrics

log = get_logger(__name__)

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
MODEL = "claude-sonnet-5"
MAX_TOKENS = 220

SYSTEM_PROMPT = (
    "You write two-sentence descriptions of walking, cycling and driving routes "
    "for a routing app.\n"
    "\n"
    "Rules:\n"
    "- Use only the facts given. Never invent a landmark, a street name, a "
    "surface, or anything about what the route looks like.\n"
    "- If a route is blocked, say what blocks it and do not soften it.\n"
    "- Plain British English. No marketing tone, no exclamation marks, no "
    "second-person imperatives.\n"
    "- Two sentences, at most 45 words.\n"
    "- Do not mention scores, percentages or the word 'route'."
)


@dataclass(frozen=True)
class NarrationRequest:
    label: str
    duration_min: float
    distance_m: float
    mode: str
    nature: float | None
    air: float | None
    shade: float | None
    status: str
    blockers: list[str]
    rest_stop_types: list[str]
    scoring_method: str


def _facts(req: NarrationRequest) -> str:
    lines = [
        f"Objective: {req.label}",
        f"Travel: {req.mode}, {round(req.duration_min)} minutes, "
        f"{round(req.distance_m)} metres",
        f"Status: {req.status}",
    ]
    if req.nature is not None:
        lines.append(f"Greenery, 0 to 1: {req.nature:.2f}")
    if req.air is not None:
        lines.append(f"Air quality, 0 to 1 where 1 is clean: {req.air:.2f}")
    if req.shade is not None:
        lines.append(f"Shade, 0 to 1: {req.shade:.2f}")
    if req.rest_stop_types:
        lines.append("Rest stops along the way: " + ", ".join(req.rest_stop_types))
    if req.blockers:
        lines.append("Blocked by: " + "; ".join(req.blockers))
    if req.scoring_method == "placeholder":
        lines.append(
            "NOTE: these figures are placeholders, not measurements. Say so in the "
            "second sentence."
        )
    elif req.scoring_method == "geometry_only":
        lines.append(
            "NOTE: greenery was estimated from the route's shape and tags, not from "
            "photographs."
        )
    return "\n".join(lines)


async def narrate(req: NarrationRequest) -> str | None:
    """Two sentences about a route, or ``None``.

    Every failure path returns ``None``. Narration is the least important thing
    in the response and must never be able to fail a request.
    """
    if not settings.anthropic_api_key:
        log.info("narration_skipped", extra={"reason": "no_api_key"})
        return None

    body: dict[str, Any] = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": _facts(req)}],
    }

    try:
        response = await fetch(
            "POST",
            ANTHROPIC_URL,
            json_body=body,
            headers={
                "Content-Type": "application/json",
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": ANTHROPIC_VERSION,
            },
            cost=1,
            service="anthropic",
        )
    except (FixtureMissing, BudgetExhausted) as exc:
        log.info("narration_unavailable", extra={"reason": type(exc).__name__})
        metrics.incr("narration_failures_total")
        return None
    except httpx.HTTPError as exc:
        log.warning("narration_transport_error", extra={"error": type(exc).__name__})
        metrics.incr("narration_failures_total")
        return None

    if response.status_code >= 400:
        log.warning("narration_error", extra={"status": response.status_code})
        metrics.incr("narration_failures_total")
        return None

    try:
        payload = response.json()
        blocks = payload.get("content") or []
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    except (ValueError, AttributeError, TypeError, json.JSONDecodeError):
        log.warning("narration_unparseable")
        metrics.incr("narration_failures_total")
        return None

    text = text.strip()
    return text or None


def narration_request_for(route: Any, rest_stops: list[Any] | None) -> NarrationRequest:
    """Build a NarrationRequest from a wire Route."""
    return NarrationRequest(
        label=route.label,
        duration_min=route.duration_min,
        distance_m=route.distance_m,
        mode=route.mode,
        nature=route.scores.nature,
        air=route.scores.air,
        shade=route.scores.shade,
        status=route.status,
        blockers=[f"{b.type}: {b.description}" for b in route.blockers],
        rest_stop_types=sorted({s.type for s in (rest_stops or [])}),
        scoring_method=route.scoring_method,
    )
