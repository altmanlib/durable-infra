---
'@altmanlib/durable-infra': minor
---

An application can keep the history of changes itself. `AgentServiceOptions.changes` (`openCore`'s `service.changes`) takes a `ChangeLog`; changes are then committed first and noted there after, including the conversations moved to the configured model, and `Settings.access` and `Settings.channel` are not available. `Change.area` is a string, and `Settings.record` and `Settings.recordChannelChange` note an application's own changes. `Settings.changes()` now returns a promise.

Queries: `Insights.conversations()`, and `Insights.usage(range, { key })` for the spend of one channel key. `SessionReader` gets `keyOf`, `conversationOf`, `pendingInputs`, `isBusy`, `spent` and `listConversations`.

`appDoc` and `appDocFamily` take `migrate`, to convert a document stored at an older version when it is read. The Durable probe checks it.
