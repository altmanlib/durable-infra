# @altmanlib/durable-infra

## 0.2.0

### Minor Changes

- 3044adc: `SettingsError` takes the kind as a type argument (default: the kernel's own kinds), so a channel can throw and handle a kind of its own, such as "no such group", without the kernel knowing it. The kernel's `SettingsErrorKind` no longer lists `unknown_group`.
