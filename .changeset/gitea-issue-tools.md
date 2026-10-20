---
"@altmanlib/durable-infra": minor
---

Complete the Gitea issue tools: alongside `gitea_issue_create`, a shared conversation can now list a repository's issues (`gitea_issue_list`), read one in full (`gitea_issue_get`), comment on one (`gitea_issue_comment_create`) and change one (`gitea_issue_edit` — a new title, a new body, or closing and reopening). All five take their repository from the `gitea.repo` setting as before.
