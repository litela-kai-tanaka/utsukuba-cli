# Explicit INFOSS attempt start (foreground only)

All existing read commands remain unchanged. This narrowly scoped command is a **write**: it starts one new attempt, not a final submission. It is limited to course `351845`, drill `4141433`, using the saved matching Manaba profile. It never logs in automatically, retries a POST, follows the POST response's redirect, answers questions, or submits final answers. No background integration permissions or schedules are changed.

```sh
UTSUKUBA_CLI_HOME=/home/litela-runtime/.local/share/utsukuba-cli \
  bun run packages/cli/src/index.ts --profile manaba-1 --json \
  drills start 351845 4141433 \
  --confirm-start https://manaba.tsukuba.ac.jp/ct/course_351845_drill_4141433

UTSUKUBA_CLI_HOME=/home/litela-runtime/.local/share/utsukuba-cli \
  bun run packages/cli/src/index.ts --profile manaba-1 --json \
  drills inspect-attempt 351845 4141433
```

Run these from the repository checkout. The compiled `dist/utsukuba` supports the same arguments. Both `drills ...` and `manaba drills ...` are available. Missing/mismatched confirmation or an unsupported target is rejected before reading authentication or issuing requests. The production base is restricted to `https://manaba.tsukuba.ac.jp/ct`; loopback bases are permitted for synthetic tests but still require matching saved-profile base URLs.

The confirmed command rereads the landing page exactly once. It requires the observed current `受付中` state (independently of prior scores/pass history), `提出上限: 無制限`, `受付終了日時: 未設定`, and one enabled observed `action_DrillStudent_querystart` POST control. Both the form action and any submit-control action must resolve to the exact canonical landing URL. Only the three required hidden controls and the observed start control are sent. Unknown/ambiguous or unavailable layouts fail closed before POST.

Before the one POST, the command exclusively reserves a target directory under `$UTSUKUBA_CLI_HOME/attempts/` and persists a `post-pending` journal. Store keys bind the profile, base URL, course and drill. Directory/file permissions are `0700`/`0600`. Unsafe paths, symlinks and stores inside Git checkouts are rejected. Raw response HTML, response Location and hidden values are private journal data: do not print, share or commit these files.

The public result includes `stateFile`, canonical `url`, `stage`, `httpStatus` and non-sensitive start `actionNames`. `response-saved` means only that a response was saved—not that an attempt was successfully opened or that any answers were submitted. A transport/body-read/storage failure after the POST boundary yields `unknown` or retains the durable `post-pending` state. **Never automatically repeat a start after either outcome.** All reserved targets, including successful ones, reject another start. There is deliberately no release/reset command in this first slice.

`inspect-attempt` is offline: it loads only the bound private journal and returns sanitized body/form metadata plus structured radio/checkbox questions when supported. Unsupported question layouts return `questions: null` with safe inspection metadata still available. It does not follow links, load resources, replay the POST or reveal the raw HTML/Location. Subsequent final-submit protocol is intentionally unimplemented pending inspection of the actual started response.

Tests use synthetic fixtures and loopback/injected HTTP only; they do not start a real student attempt.
