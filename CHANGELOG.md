# @altmanlib/durable-infra

## 0.3.0

### Minor Changes

- 3524e27: `kysely` is a peer dependency (`^0.29.6`) instead of a dependency, so an application that opens tables of its own in the business database shares one copy of it with the package; two copies make the `Kysely` types of the application and of `Records` incompatible. Applications install `kysely` themselves.

## 0.2.0

### Minor Changes

- 3044adc: `SettingsError` takes the kind as a type argument (default: the kernel's own kinds), so a channel can throw and handle a kind of its own, such as "no such group", without the kernel knowing it. The kernel's `SettingsErrorKind` no longer lists `unknown_group`.
