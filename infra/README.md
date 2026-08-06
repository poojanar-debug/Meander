# Infrastructure

Four CloudFormation stacks that put Meander on AWS.

> ## Nothing here has been applied.
>
> Every template **validates** — `aws cloudformation validate-template` is a
> read-only call and all four pass it, and `cfn-lint` passes clean on all four
> as well (it catches more: unresolved `!Ref` targets, unknown resource
> properties, bad intrinsic arguments — and it runs in CI). None has ever been
> deployed. The AWS credentials on the machine this was written on are account
> root, and creating billable resources was explicitly out of scope.
>
> **A template that parses is not a template that works.** CloudFormation
> validation checks syntax and function references. It does not check that a
> security group rule is right, that an IAM policy grants enough, that a health
> check path answers, or that two services can reach each other. Everything in
> the gate table at the bottom is therefore **UNVERIFIED**, and each row names
> the command that would settle it.

## Order

| # | stack | why it is where it is |
|---|---|---|
| 1 | `00-platform.yaml` | ECR must exist before an image can be pushed; the OIDC role before CI can push one |
| 2 | `10-network.yaml`  | the VPC and the security groups everything else imports |
| 3 | `20-services.yaml` | needs the network, and an image URI from step 1 |
| 4 | `30-web.yaml`      | needs the ALB's DNS name from step 3 |

```bash
REGION=ap-south-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 1 — registries, secret, OIDC deploy role
aws cloudformation deploy --region $REGION \
  --stack-name meander-platform --template-file infra/00-platform.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubOwner=poojanar-debug GitHubRepo=Meander

# 2 — network. The prefix list ID is region-specific and has no CFN lookup.
PL=$(aws ec2 describe-managed-prefix-lists --region $REGION \
      --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
      --query 'PrefixLists[0].PrefixListId' --output text)
aws cloudformation deploy --region $REGION \
  --stack-name meander-network --template-file infra/10-network.yaml \
  --parameter-overrides CloudFrontPrefixListId=$PL

# 3 — push images, then the services (see "The graph" below for the router)
aws cloudformation deploy --region $REGION \
  --stack-name meander-services --template-file infra/20-services.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ApiImage=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/meander/api:<sha> \
    RouterImage=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/meander/graphhopper:<sha> \
    AlarmEmail=you@example.com

# 4 — bucket and distribution
aws cloudformation deploy --region $REGION \
  --stack-name meander-web --template-file infra/30-web.yaml
```

Secrets are **never** template parameters — a parameter value is visible in
`describe-stacks` forever. Put them in afterwards:

```bash
aws secretsmanager put-secret-value --region $REGION --secret-id meander/api \
  --secret-string '{"MAPILLARY_TOKEN":"…","ANTHROPIC_API_KEY":"…"}'
```

None of them is needed to serve a route. `MAPILLARY_TOKEN` is read only by the
offline batch scorer, `ANTHROPIC_API_KEY` only by narration, and `/api/health`
reports which are missing.

## The graph, which is the part that is actually awkward

The router image never imports. An import is 71 s for the demo region set and
about 31 minutes for `countries`; either would be an outage of that length on
every task replacement, and ECS would kill the task long before the second
finished. So the graph is a build artifact, and it gets to the container one of
two ways:

**Baked in.** Simple, and the task starts in about a second. The image is
1.2 GB for the demo set and CI cannot build it — GitHub's runners would have to
import the graph first. Build it from a workstation that already has one:

```bash
scripts/graphhopper.sh setup --region-set demo   # ~4 min, once
scripts/publish_graph.sh --local
docker buildx build --platform=linux/arm64 --build-arg GRAPH_SOURCE=local \
  -f graphhopper/Dockerfile -t $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/meander/graphhopper:$(git rev-parse HEAD) --push .
```

**Fetched at start.** The image stays 520 MB and CI can build it, at the cost
of a download on every task start and an S3 bucket to hold the archive. The
entrypoint verifies the digest *before* unpacking, because an interrupted
download that is merely unpacked produces a `graph-cache/` that exists, passes
any `-d` test, and then dies on load.

```bash
scripts/publish_graph.sh --s3 s3://your-bucket/graph-demo.tar.zst
# then set GRAPH_S3_URI and GRAPH_SHA256 in the router task definition
```

`countries` is 6.6 GB and needs a 20 GB serve heap, which is a `RouterMemory`
of 24576 and a different cost conversation entirely. The demo set is what these
defaults are sized for.

## What is deliberately not here

- **No Route 53.** This account has no hosted zone, and the `freshhaul.com`
  certificate in us-east-1 is `VALIDATION_TIMED_OUT` — it was requested and the
  DNS validation records were never published, so it expired. `DomainName` and
  `CertificateArn` are therefore optional, and with both empty the distribution
  answers on its own `dxxxx.cloudfront.net` name. That works and needs nothing.
- **No WAF.** About $6/month plus per-request charges, and the application
  already has a per-IP token bucket and a global daily ceiling. Worth adding if
  this is ever exposed to real traffic; not worth adding before it has any.
- **No RDS, no ElastiCache, no DynamoDB.** There is no user data to store. The
  scenery scores are a read-only SQLite file baked into the image, and the route
  cache is in memory per task. Adding a database would create the data-retention
  question this project exists not to have.
- **No autoscaling.** Two API tasks and one router, fixed. Scaling policy
  without traffic to size it from is a guess with a monthly bill attached.

## Cost

Sized for `ap-south-1`, the demo graph, two API tasks and one router, at low
traffic. **Estimated, never billed — this has not been deployed.**

| | monthly |
|---|---|
| Fargate, router — 1 vCPU / 4 GB, ARM, 1 task, 730 h | ~$29 |
| Fargate, API — 0.5 vCPU / 1 GB, ARM, 2 tasks, 730 h | ~$21 |
| NAT gateway — hourly | ~$32 |
| NAT gateway — data processed, ~20 GB | ~$1 |
| Application Load Balancer — hourly + minimal LCU | ~$18 |
| ECR storage — ~5 GB (3 router images at 1.2 GB, 10 API at 360 MB) | ~$0.50 |
| CloudFront — first 1 TB out is free tier; assume ~10 GB after | ~$1 |
| S3 — a few MB of built assets | ~$0.10 |
| CloudWatch — logs at 30-day retention, Container Insights | ~$5 |
| Secrets Manager — one secret | ~$0.40 |
| **total** | **~$108/month** |

Two things stand out and both are worth knowing before you deploy:

**The NAT gateway costs more than the API.** $32/month to give private tasks
outbound access to Overpass, Open-Meteo and ECR. The honest alternatives are to
put the API tasks in public subnets with public IPs and no NAT — which saves
$32 and widens the attack surface of the component holding the coordinates —
or to add interface VPC endpoints, which cost about $7/month each per AZ and
would not cover Overpass or Open-Meteo anyway.

**The load balancer costs about as much as everything it balances.** $18/month
of standing charge for two small tasks. It buys health-check-driven task
replacement and a stable origin for CloudFront. Below this size the honest
answer is that ECS is the wrong shape and a single small instance would do.

Not included: the one-off cost of building the graph, data transfer if traffic
is real, and the free-tier credits a new account would absorb some of this with.

## Gate

**Every row below is still UNVERIFIED against AWS.** Nothing has been deployed.

Four of them have now been verified **locally**, against the self-hosted
GraphHopper and a `uvicorn` on this machine, on 2026-08-06. That is a weaker
claim than the row makes and is recorded separately for exactly that reason —
it establishes that the *application* behaves as the row expects, and says
nothing about whether the CloudFormation that is supposed to produce that
arrangement works.

| # | claim | verified locally | how |
|---|---|---|---|
| 6 | the API reached the router | **yes** | `self_hosted: true`, `self_hosted_source: "env"` |
| 7 | the smoothness constraint can fire | **yes** | `path_details` = `road_class, surface, road_environment, smoothness`, and `scripts/verify_selfhosted.py` returns three distinct geometries at Colombo, Amsterdam and London |
| 8 | pre-warmed CLIP scores shipped | **yes** | `segments_scored: 146`, `segments_clip: 146` |
| 9 | a real route works end to end | **yes** | three routes at Hyde Park, `scoring_method: "clip"`, the accessible one blocked with one barrier and a reason |

Two more things were established while doing it, neither of which is a row here:

- **`/readyz` returns 503 with the router stopped and 200 with it running.**
  Observed both ways, which had never been done before.
- **`scripts/verify_selfhosted.py` used to fail at Princes Street, Edinburgh**
  — not a routing defect. Its location list claims `great-britain`, and the
  `demo` region set imports **Greater London** only. Fixed: the script now asks
  the running router what it covers, via the same `backend/coverage.py` the API
  uses, and skips what is outside instead of failing it. Under `demo` it reports
  3 checked and 1 skipped and exits 0; under `countries` Edinburgh will be
  checked with no change to the file. A run in which *every* location is skipped
  exits 1 — a verification that verified nothing is not a pass.

Run the command; the expectation says what it should print.

| # | claim | how to verify | expected |
|---|---|---|---|
| 1 | all four templates are well-formed | `cfn-lint infra/*.yaml` | no output, exit 0 — **this one has been run and passes**, and runs in CI |
| 2 | the stacks create cleanly | the four `deploy` commands above | `CREATE_COMPLETE` each |
| 3 | the router has no public ingress | `aws ec2 describe-security-groups --filters Name=group-name,Values=meander-router --query 'SecurityGroups[0].IpPermissions'` | one rule, port 8989, `UserIdGroupPairs` naming the API SG, `IpRanges` empty |
| 4 | the router is unreachable from outside | `aws ecs describe-tasks … --query 'tasks[0].attachments'` then `curl http://<private-ip>:8989/health` from outside the VPC | connection times out |
| 5 | the ALB admits only CloudFront | `aws ec2 describe-security-groups --filters Name=group-name,Values=meander-alb` | ingress `PrefixListIds` only, no `0.0.0.0/0` |
| 6 | the API reached the router | `curl -s $SITE/api/health \| jq .routing` | `self_hosted: true`, `self_hosted_source: "env"`, `smoothness` in `path_details` |
| 7 | the smoothness constraint can fire | `curl -s $SITE/api/health \| jq '.routing.path_details'` | contains `"smoothness"` — without it the accessible preset silently stops excluding impassable surfaces |
| 8 | pre-warmed CLIP scores shipped | `curl -s $SITE/api/health \| jq .cache` | `segments_scored: 146` |
| 9 | a real route works end to end | `curl -s -X POST $SITE/api/routes -H 'content-type: application/json' -d '{"origin":{"lat":51.507489,"lon":-0.162207},"minutes":35,"mode":"auto","objectives":["fastest","nature","accessible"]}' \| jq '.routes[] \| {id,status,scoring_method}'` | three routes, `scoring_method: "clip"` |
| 10 | the rate limiter sees real client IPs | 60 requests from one address | 429 after the bucket empties — **and** two different addresses must not share a bucket |
| 11 | the bucket is not publicly readable | `curl -sI https://meander-web-$ACCOUNT.s3.$REGION.amazonaws.com/index.html` | `403` |
| 12 | the SPA serves deep links | `curl -sI $SITE/some/deep/link` | `200` and `content-type: text/html` |
| 13 | ~~the service worker is not edge-cached~~ | — | **moot.** There is no `sw.js` on this branch; the service worker belonged to the launch frontend and did not survive the reconciliation merge (BLOCKED.md §5). `30-web.yaml` still carries the CachingDisabled behaviour for it, which is harmless and correct to keep — it costs nothing and the file is coming back. Re-open this row when it does. |
| 14 | security headers are applied | `curl -sI $SITE/ \| grep -iE 'content-security-policy\|strict-transport'` | both present, CSP naming only `self` and `tiles.openfreemap.org` |
| 15 | CI can deploy without a stored key | run the `deploy` workflow | green, and no `AWS_SECRET_ACCESS_KEY` anywhere in the repository or its secrets |
| 16 | alarms fire | `aws ecs update-service --service meander-graphhopper --desired-count 0` | `meander-router-not-running` goes ALARM within ~3 min; set it back to 1 |
| 17 | the deploy is reversible | `aws ecs update-service --task-definition meander-api:<previous>` | previous revision serves; see DEPLOY.md |

Item 10 is the one most likely to be wrong, and it is the reason
`MEANDER_TRUSTED_PROXY_HOPS` is `2` here rather than the `1` that would be right
behind an ALB alone. CloudFront sets `X-Forwarded-For` to the viewer's address
and the ALB appends CloudFront's, so the app sees `viewer, cloudfront` and must
count two from the right. Getting it wrong does not break anything visibly —
every request in the world simply lands in one rate-limit bucket.
