# durable-infra

Shared infrastructure for chat bots built on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable).

It provides the parts every such bot needs, so each bot only adds its own channels:

- **Kernel**: conversations and turns that survive a restart, delivery of answers and notices, scheduled events, rate limits, and settings an operator can change at runtime (editable prompts, allowlists, change history).
- **Platform**: structured logging with a rotating log file, in-process counters, and a SQLite business database with per-domain migrations.
- **Modules**: optional features an application opts into, such as the clock, reminders, web fetch and search, a shared memo, conversation settings, and Gitea issues.

## Requirements

- [Bun](https://bun.com) 1.4.4 or later
- `@earendil-works/pi-durable`, `@earendil-works/chord` and `@earendil-works/pi-ai`, installed by the application at the exact version listed in this package's `peerDependencies`

## License

MIT
