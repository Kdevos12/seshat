# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub's **Report a vulnerability** button
on the repository's Security tab, or contact the maintainer ([@Kdevos12](https://github.com/Kdevos12)).
You should get an answer within a week. Fixes go to `main`; there are no maintained older versions during
the beta.

## What Seshat runs, and where

Seshat runs code that a language model wrote. Its design assumes that code is hostile:

- **The certifier** compiles and replays a candidate proof only inside a sandbox (bubblewrap, or Docker):
  no network, a read-only filesystem except its work directory, memory and process limits. Without a
  sandbox it refuses to run and every result stays `computed`
  ([documentation/certifier.md](documentation/certifier.md#where-untrusted-code-runs)). The sandbox protects
  what is written and the network, not what is read: your files stay readable to the code it runs.
- **The Kimina Lean server** compiles attempts outside the certifier's sandbox. `scripts/kimina.sh` binds it
  to 127.0.0.1 and requires an API key; do not expose it to a network you do not trust.
- **Text fetched from the web** (literature search) is treated as hostile: only allowed hosts are reached,
  the text is cleaned and bounded, and it is data that never changes a claim's status ([documentation/literature.md](documentation/literature.md#fetched-text-is-hostile)).
- **The local interface** (`harness ui`) listens on 127.0.0.1 only.
- **Keys** live in your environment or in `.env`, which git ignores; host profiles read them with
  `${env:NAME}` and never store them.

Issues of particular interest: a way for a candidate proof to be certified without a kernel replay, a way
out of the certifier's sandbox, a way for fetched or model-written text to change a claim's status, and
anything that leaks a key.
