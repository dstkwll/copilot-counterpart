# Scoped files

Context-only jobs make the lead read every relevant file and paste it into the prompt, which costs the lead's own context and limits what the delegate can check. A `files` grant lets the delegate read named paths itself, and optionally stage edits for review.

## Design

- **Custom tools only.** The workspace exposes `workspace_read`, `workspace_list`, `workspace_search`, and with write grants `workspace_write` and `workspace_edit`. Built-in and MCP tools stay excluded, the pre-tool hook allows only these names, and the adapter verifies the runtime's tool set matches exactly before sending the prompt. Names are prefixed so they cannot collide with Copilot built-ins.
- **Path checks.** `root` is resolved with `realpath` and must not itself sit in a sensitive directory. Read grants must resolve inside it; each read resolves the requested path through symlinks and must land in a read grant or be a write target. Write grants are exact files keyed by the real parent directory plus file name, and every access re-resolves the parent, so a directory later swapped for a symlink no longer matches. Sensitive names are refused on every path segment, case-insensitively, even when granted.
- **Opening files.** Files are opened with `O_NOFOLLOW | O_NONBLOCK` (so a FIFO cannot hang the open); the open handle must be a regular file with one link (hard links are refused, since they can alias files outside the grant or sensitive files) and under 4 MB, and at most its stat size plus one byte is read, so a file growing mid-read is refused. After reading, the path is resolved again and must still name the same device and inode. Only UTF-8 text without NUL bytes is accepted, for reads and for staged content, so every diff is reviewable. A byte-order mark is kept as content, so removing it shows in the diff.
- **Staging.** Edits live in memory per job and are visible to later reads, lists and searches in the same job, including newly created files. Edits to one file are serialized, and an edit's size is checked before the expanded string is built. Staging freezes when the job reaches a terminal status, and the frozen flag is re-checked after every await.
- **Review and apply.** `copilot_changes` takes one snapshot of the staged set and derives both the unified diffs and the `changeSetHash` from it. The hash covers each file's path, a tagged hash of its original bytes (absent files hash differently from any content) and its staged content. `copilot_apply` is single-flight and requires that hash, a finished job whose runtime shutdown is confirmed, settled staging, and parent directories with the same real path and device/inode as at grant time, and unchanged on-disk bytes. It prepares every temporary file first, then re-checks and renames each one, preserving the existing mode. If a commit fails midway it reports which files were written and marks the job `partial` (recorded before temp-file cleanup, so a cleanup failure cannot hide it), refusing further applies.
- **Audit.** Each access, staging and refusal is recorded as `supervisor.file_access`; apply is recorded as `supervisor.applied`. Workspace tool events keep only metadata, because their arguments and results carry file contents. Unexpected filesystem errors are reduced to their error code so they cannot echo ungranted paths.

## Why staged rather than direct writes

The lead should read the diff either way before trusting the change, so direct writes save no lead tokens over staged writes with a server-side apply. Staging keeps every disk write behind the lead, which keeps the host's own permission model meaningful.

## Limits

256 KB per read, 4 MB read per job, 1 MB per staged file, 500 list entries, 200 search matches, 1 MB per searched file and 20 MB searched per job. Search is literal text, not regular expressions. Orchestration trees share one workspace across the lead and children. `.pdf` and `.docx` files are read as extracted text and cannot be staged.

Search budgets are per job and reserved before each read, staged content included. Traversal descends only into granted directories and their ancestors.

## Residual risk

These are application-level checks in the server process, not an OS sandbox. They hold against an untrusted delegate, which can only call the tools above. Against another local process actively racing the filesystem, the no-follow opens, identity checks and pre-commit re-checks narrow the window but cannot close it: Node has no directory-handle-relative operations, so a parent swapped between the last check and a rename could still redirect that one write, and a directory swapped mid-listing could expose entry names from outside the grant.
