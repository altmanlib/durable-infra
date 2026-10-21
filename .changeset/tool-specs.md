---
"@altmanlib/durable-infra": minor
---

A module declares each of its tools once, in `Module.toolSpecs` (`scope`: offered everywhere or in shared conversations only; `access`: anyone or a privileged asker; `off` with a `note` for a tool the configuration leaves out). It replaces `Module.sharedTools` and `Module.privilegedTools`, and the names a shared conversation is given are derived from the specs. `describeTools(modules)` and `formatToolCatalog(catalog)` list the tools of an application's modules, for one person and for a group, from the declarations alone: nothing is opened. Tool names, prompt ids and what each conversation is offered are unchanged.
