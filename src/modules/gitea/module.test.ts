import { expect, test } from "bun:test";

import { giteaConfigFromEnv } from "./module.ts";

test("Gitea is both variables or neither; the address is http(s), kept without a trailing slash", () => {
  expect(giteaConfigFromEnv({})).toBeUndefined();
  // Another program's variables of the unprefixed names are not read.
  expect(giteaConfigFromEnv({ GITEA_URL: "https://other.test", GITEA_TOKEN: "theirs" })).toBeUndefined();
  expect(giteaConfigFromEnv({ BOT_GITEA_URL: " ", BOT_GITEA_TOKEN: "" })).toBeUndefined();
  expect(giteaConfigFromEnv({ BOT_GITEA_URL: " https://git.test/sub/ ", BOT_GITEA_TOKEN: " t0k " })).toEqual({
    url: "https://git.test/sub",
    token: "t0k",
  });
  expect(giteaConfigFromEnv({ BOT_GITEA_URL: "http://10.0.0.5:3000", BOT_GITEA_TOKEN: "t" })?.url).toBe("http://10.0.0.5:3000");
});

test("one of the two variables alone, or an address that is not plain http(s), is refused naming the variable", () => {
  expect(() => giteaConfigFromEnv({ BOT_GITEA_URL: "https://git.test" })).toThrow("BOT_GITEA_TOKEN");
  expect(() => giteaConfigFromEnv({ BOT_GITEA_TOKEN: "t" })).toThrow("BOT_GITEA_URL");
  for (const bad of ["git.test", "ftp://git.test", "https://git.test/?x=1", "https://u:p@git.test"])
    expect(() => giteaConfigFromEnv({ BOT_GITEA_URL: bad, BOT_GITEA_TOKEN: "t" })).toThrow("BOT_GITEA_URL");
});
