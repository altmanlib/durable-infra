# durable-infra

基于 [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) 的聊天机器人共享基础设施：会话与一轮的机制、控制台设置、业务数据库，以及可按需开启的功能模块。

```ts
import { openCore } from "@altmanlib/durable-infra";
import { clockModule } from "@altmanlib/durable-infra/modules/clock";
import { reminderModule } from "@altmanlib/durable-infra/modules/reminder";

const core = await openCore({
  config: loadCoreConfig(dataDir),
  version,
  logDir,
  modules: [clockModule(), reminderModule()],
  prompts: { entries: { /* the welcome of your channels */ }, replace: { "system.preamble": "…" } },
});
```

- 只支持 Bun
- `@earendil-works/pi-durable`、`chord`、`pi-ai` 是精确版本的 peer 依赖，由应用安装
- 设计与分层见 [docs/design/2026-10-20-infra-extraction.md](docs/design/2026-10-20-infra-extraction.md)，开发约定见 [AGENTS.md](AGENTS.md)

## 许可

MIT
