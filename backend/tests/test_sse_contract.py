"""The SSE wire format, asserted as bytes rather than through a parser.

test_streaming_and_reporting.py covers the *behaviour* — progress before
routes, routes before done, a cache hit still speaking SSE — and it reads the
stream through a helper that mirrors the frontend's parser. That is the right
way to test behaviour and the wrong way to test a wire format: change the
framing on both sides of a helper and every one of those tests still passes
while the browser stops rendering.

So this file asserts the actual characters, and it asserts them against what
`frontend/src/api/client.js` is written to accept. That parser is small and
strict:

    buffer.split('\\n\\n')                       frames are blank-line separated
    part.split('\\n').find(l => l.startsWith('data:'))   one data line per frame
    JSON.parse(line.slice(5))                  everything after `data:` is JSON
    evt.type in {progress, route, done, error} the whole vocabulary

Every one of those four is a thing the backend could break unilaterally, and
none of them would fail a test that used the same abstraction to read as the
server used to write.
"""

from __future__ import annotations

import json
import re

import pytest

from backend.config import TEST_LOCATIONS_BY_SLUG

COLOMBO = TEST_LOCATIONS_BY_SLUG["colombo-fort"]
VIHARA = TEST_LOCATIONS_BY_SLUG["viharamahadevi"]

BODY = {
    "origin": {"lat": COLOMBO.lat, "lon": COLOMBO.lon},
    "destination": {"lat": VIHARA.lat, "lon": VIHARA.lon},
    "minutes": 25,
}
SSE = {"Accept": "text/event-stream"}

# The complete vocabulary the client branches on. A fifth type is not an
# extension — the client silently drops anything it does not recognise, so it
# would be a feature that never arrives.
CLIENT_EVENT_TYPES = {"progress", "route", "done", "error"}


@pytest.fixture
def stream(api_client) -> str:
    response = api_client.post("/api/routes", json=BODY, headers=SSE)
    assert response.status_code == 200
    return response.text


# --- framing ----------------------------------------------------------------


def test_the_media_type_is_exactly_what_the_client_checks_for(api_client) -> None:
    """`client.js` tests `contentType.includes('text/event-stream')` and falls
    back to `res.json()` when it does not match — so a wrong media type does
    not error, it silently takes the non-streaming path and the whole of Phase
    1.5 stops happening."""
    response = api_client.post("/api/routes", json=BODY, headers=SSE)

    assert "text/event-stream" in response.headers["content-type"]


def test_frames_are_separated_by_exactly_one_blank_line(stream: str) -> None:
    """The client splits on `\\n\\n` and keeps the remainder as a partial
    frame. Extra blank lines produce empty frames, which it skips; a *missing*
    one merges two events into a single unparseable blob."""
    assert stream.endswith("\n\n"), "the final frame is not terminated"
    assert "\n\n\n" not in stream, "an extra blank line splits a frame in two"


def test_every_frame_has_exactly_one_data_line(stream: str) -> None:
    """`find(l => l.startsWith('data:'))` takes the *first* data line and
    ignores the rest, so a multi-line frame silently loses everything after
    the first — which SSE itself allows and this client does not."""
    for frame in stream.split("\n\n"):
        if not frame.strip():
            continue
        data_lines = [line for line in frame.split("\n") if line.startswith("data:")]
        if frame.lstrip().startswith(":"):
            assert not data_lines, "a comment frame must not also carry data"
            continue
        assert len(data_lines) == 1, f"frame has {len(data_lines)} data lines: {frame!r}"


def test_everything_after_the_data_prefix_parses_as_json(stream: str) -> None:
    """`JSON.parse(line.slice(5))` — a fixed five-character slice past `data:`.
    Any other prefix length, and this is a parse error in the browser rather
    than anything the client reports."""
    for frame in stream.split("\n\n"):
        line = next((line for line in frame.split("\n") if line.startswith("data:")), None)
        if line is None:
            continue
        json.loads(line[5:])   # raises if the prefix is not exactly `data:`


def test_no_frame_contains_a_bare_carriage_return(stream: str) -> None:
    """The client splits on `\\n\\n` only. CRLF framing would leave a stray
    `\\r` on the end of every JSON payload, and `JSON.parse` tolerates it —
    which is worse, because it works until something compares a string."""
    assert "\r" not in stream


# --- vocabulary -------------------------------------------------------------


def test_every_event_type_is_one_the_client_handles(stream: str) -> None:
    """The client's if/else chain has no final else. An unrecognised type is
    not an error — it is dropped in silence."""
    for frame in stream.split("\n\n"):
        line = next((line for line in frame.split("\n") if line.startswith("data:")), None)
        if line is None:
            continue
        event_type = json.loads(line[5:]).get("type")
        assert event_type in CLIENT_EVENT_TYPES, f"unhandled event type {event_type!r}"


def test_a_route_event_carries_its_payload_under_route(stream: str) -> None:
    """`onRoute(evt.route)`, not `onRoute(evt)`."""
    routes = [
        json.loads(line[5:])
        for frame in stream.split("\n\n")
        for line in frame.split("\n")
        if line.startswith("data:") and '"type":"route"' in line.replace(" ", "")
    ]
    assert routes, "no route events at all"
    for event in routes:
        assert "route" in event
        assert isinstance(event["route"], dict)
        assert "id" in event["route"], "the client merges by id; without one it appends"


def test_the_done_event_carries_its_payload_under_payload(stream: str) -> None:
    """`final = evt.payload` — the object App.jsx reads cache, reason and
    best_departure from."""
    done = [
        json.loads(line[5:])
        for frame in stream.split("\n\n")
        for line in frame.split("\n")
        if line.startswith("data:") and '"type":"done"' in line.replace(" ", "")
    ]
    assert len(done) == 1, f"expected exactly one done event, got {len(done)}"
    payload = done[0]["payload"]
    for key in ("routes", "cache"):
        assert key in payload, f"done payload has no {key!r}"


def test_progress_events_carry_a_percentage_and_a_sentence(stream: str) -> None:
    """StatusBanner renders `progress.text` and puts `progress.pct` into an
    aria-valuenow. A missing pct becomes the literal default of 5 and the bar
    stops moving; missing text is an empty banner."""
    progress = [
        json.loads(line[5:])
        for frame in stream.split("\n\n")
        for line in frame.split("\n")
        if line.startswith("data:") and '"type":"progress"' in line.replace(" ", "")
    ]
    assert progress, "no progress events"
    for event in progress:
        assert isinstance(event["pct"], int | float)
        assert 0 <= event["pct"] <= 100
        assert isinstance(event["text"], str) and event["text"].strip()


# --- the contract with the file that parses it ------------------------------


def test_the_client_parser_still_slices_five_characters() -> None:
    """Read out of the frontend source, so this fails if the parser changes
    without the server.

    A test that asserts both halves against a shared constant proves they agree
    with the constant. This asserts the server's bytes against the *literal in
    the file that will receive them*.
    """
    from pathlib import Path

    client_js = Path(__file__).resolve().parents[2] / "frontend" / "src" / "api" / "client.js"
    source = client_js.read_text()

    assert "line.slice(5)" in source, (
        "client.js no longer slices 5 characters past `data:`. The server writes "
        "'data: ' + json; if the client's offset moved, one of the two is wrong."
    )
    assert "buffer.split('\\n\\n')" in source, "client.js no longer splits frames on a blank line"

    # And that its branch list has not grown past what the server can emit.
    handled = set(re.findall(r"evt\.type === '(\w+)'", source))
    assert handled == CLIENT_EVENT_TYPES, (
        f"client.js handles {sorted(handled)} but the contract is "
        f"{sorted(CLIENT_EVENT_TYPES)}"
    )
