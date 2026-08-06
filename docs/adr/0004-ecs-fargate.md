# 4 · ECS Fargate rather than App Runner, Lambda or a VM

**Accepted, and unapplied** — `infra/` has never been deployed. This records
the reasoning so the next person does not re-litigate it from scratch.

## Context

Two long-lived containers: an API, and a routing server that holds a 485 MB
graph in memory and answers in 24 ms because it is already loaded.

## Decision

ECS Fargate on ARM64 (Graviton), two services, one cluster.

## Consequences

- The router keeps its graph resident between requests, which is the entire
  reason self-hosting was worth doing.
- The router runs in private subnets with no public IP and no load balancer;
  its security group's only ingress rule names the API's security group.
- ARM64 is roughly 20% cheaper for the same vCPU and memory. Nothing in either
  image lacks an aarch64 wheel; the router is a JVM.
- ~$108/month all in, of which the NAT gateway is $32 and the load balancer
  $18 — together more than the compute they serve. Itemised in
  `infra/README.md` with that stated plainly.
- Two API tasks and one router, fixed. No autoscaling: a scaling policy with no
  traffic to size it from is a guess with a bill attached.

## Alternatives rejected

**App Runner.** The obvious fit for two containers, and it is **closed to new
customers**. Decided for us.

**Lambda.** Rejected on the router: a 485 MB graph would be loaded per cold
start, which turns a 24 ms route into seconds and undoes the reason for
self-hosting. The API alone would fit, but splitting the two across platforms
doubles the operational surface to save part of $21/month.

**A single EC2 instance with docker compose.** Genuinely cheaper — about $30/month
all in, and the compose file already exists and works. Rejected for the brief's
stated target rather than on merit, and `infra/README.md` says so out loud:
below this size ECS is the wrong shape. What Fargate buys is health-check-driven
replacement, rolling deploys with a circuit breaker, and no host to patch.

**Kubernetes.** Rejected: a control plane and a cluster upgrade cadence for two
containers.
