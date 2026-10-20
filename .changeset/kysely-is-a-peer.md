---
'@altmanlib/durable-infra': minor
---

`kysely` is a peer dependency (`^0.29.6`) instead of a dependency, so an application that opens tables of its own in the business database shares one copy of it with the package; two copies make the `Kysely` types of the application and of `Records` incompatible. Applications install `kysely` themselves.
