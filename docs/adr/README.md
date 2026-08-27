# Architecture decision records

Six decisions that a reviewer would reasonably question, each with what was
actually measured and what it cost. They are not a design document — the design
is the code, and `PROGRESS.md` is the narrative. These exist so that "why is it
like that" has an answer that is not somebody's memory.

(There was a seventh, 0004, choosing ECS Fargate for an AWS deployment. It was
never applied, the AWS path has been removed from the repository — the app
ships on Cloudflare Pages and one VM — and the record went with it.)

Written after the fact, which is worth admitting: each was a decision made
during a phase and recorded in `PROGRESS.md` at the time. What these add is the
alternatives that were rejected and why, which a build log tends to leave out.

| | decision | status |
|---|---|---|
| [0001](0001-unknown-is-not-accessible.md) | A missing OSM tag is UNKNOWN, never "accessible" | accepted, load-bearing |
| [0002](0002-self-host-graphhopper.md) | Self-host GraphHopper rather than use the hosted API | accepted |
| [0003](0003-clip-is-offline-only.md) | CLIP runs offline; the request path reads a committed cache | accepted |
| [0005](0005-offline-results-are-opt-in.md) | The app shell is cached always; a result only on opt-in | accepted |
| [0006](0006-no-contraction-hierarchies.md) | No contraction hierarchies in the routing graph | accepted |
| [0007](0007-preference-presets-are-proxies.md) | Quiet, shade and air are tag proxies, and every route says so | accepted |
