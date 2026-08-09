# Caddy with the DuckDNS DNS-01 solver compiled in.
#
# The stock `caddy` image cannot do this. Automatic HTTPS by HTTP-01 would work
# — port 80 is open — but DNS-01 is the better answer here for one reason: it
# proves control of the name rather than control of the port, so a certificate
# can be issued and renewed even if 80 is ever closed, and it never needs the
# challenge to survive a proxy rule. `meander-app.duckdns.org` is a DuckDNS
# name, so the solver has to be DuckDNS's.
#
# Both versions are pinned, deliberately. `caddy:2-builder` would rebuild into a
# different Caddy on any future `docker compose build`, and a routing proxy that
# changes underneath a deployment is exactly the thing this file exists to stop.
#
#   caddy            2.11.4   (2026-08, current stable)
#   caddy-dns/duckdns v0.5.0  (2025-04-19, latest tag on the module proxy)
#
# Build context is this directory, not the repository root — nothing else in the
# repo belongs in a TLS terminator's build context.

FROM caddy:2.11.4-builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2.11.4

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Fail the build rather than the deployment if the module did not make it in.
# xcaddy exiting 0 does not by itself prove the plugin is registered, and a
# missing DNS provider does not surface until the first certificate request —
# which is minutes into a deployment, in a log nobody is watching.
RUN caddy list-modules | grep -q '^dns.providers.duckdns$' \
    || (echo "duckdns provider missing from build" >&2; exit 1)
