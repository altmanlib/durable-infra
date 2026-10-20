---
'@altmanlib/durable-infra': minor
---

`openCore` takes `changes`, a function that makes the application's `ChangeLog` from the open business database, for an application that keeps the history of changes there. `ChannelService` no longer includes `record` and `keepRecent`; a channel with shared conversations takes `SharedChannelService`. `./testing` exports `memoryChangeLog()` (and `MemoryChangeLog`), a `ChangeLog` in memory for tests.
