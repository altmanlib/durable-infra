# @altmanlib/durable-infra

## 0.5.0

### Minor Changes

- bdd3152: `openCore` takes `changes`, a function that makes the application's `ChangeLog` from the open business database, for an application that keeps the history of changes there. `ChannelService` no longer includes `record` and `keepRecent`; a channel with shared conversations takes `SharedChannelService`. `./testing` exports `memoryChangeLog()` (and `MemoryChangeLog`), a `ChangeLog` in memory for tests.

## 0.4.0

### Minor Changes

- 1436e4d: An application can keep the history of changes itself. `AgentServiceOptions.changes` (`openCore`'s `service.changes`) takes a `ChangeLog`; changes are then committed first and noted there after, including the conversations moved to the configured model, and `Settings.access` and `Settings.channel` are not available. `Change.area` is a string, and `Settings.record` and `Settings.recordChannelChange` note an application's own changes. `Settings.changes()` now returns a promise.
  
  Queries: `Insights.conversations()`, and `Insights.usage(range, { key })` for the spend of one channel key. `SessionReader` gets `keyOf`, `conversationOf`, `pendingInputs`, `isBusy`, `spent` and `listConversations`.
  
  `appDoc` and `appDocFamily` take `migrate`, to convert a document stored at an older version when it is read. The Durable probe checks it.

## 0.3.0

### Minor Changes

- 3524e27: `kysely` is a peer dependency (`^0.29.6`) instead of a dependency, so an application that opens tables of its own in the business database shares one copy of it with the package; two copies make the `Kysely` types of the application and of `Records` incompatible. Applications install `kysely` themselves.

## 0.2.0

### Minor Changes

- 3044adc: `SettingsError` takes the kind as a type argument (default: the kernel's own kinds), so a channel can throw and handle a kind of its own, such as "no such group", without the kernel knowing it. The kernel's `SettingsErrorKind` no longer lists `unknown_group`.
