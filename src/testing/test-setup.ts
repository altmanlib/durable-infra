// Loaded before every test file (bunfig.toml).
import { setLogSink } from "../platform/log.ts";

// Keeps the service log out of test output. Tests that assert on the log replace the sink with `captureLogs` from testing.ts.
setLogSink(() => {});

// Tests talk to servers on this machine. Bun's fetch follows HTTP_PROXY and friends, which would send those requests to
// whatever proxy the developer's shell has set, so keep local addresses out of it, whatever else NO_PROXY already lists.
for (const name of ["NO_PROXY", "no_proxy"]) {
  process.env[name] = [process.env[name], "127.0.0.1", "localhost", "[::1]"].filter(Boolean).join(",");
}
