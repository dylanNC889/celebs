# Tests

These tests run the real `index.html` and `app.js` in [jsdom](https://github.com/jsdom/jsdom) against a pretend GitHub API and a pretend Gemini. They don't touch the network or the live repo.

```sh
sh tests/run.sh                    # every test file
sh tests/run.sh test-save.js       # just one
```

**Requirements:** Node 18+, npm, and python3 with the `cryptography` package. jsdom 24.1.3 is installed into the work folder on the first run. Set `T=/some/dir` to choose that folder; the default is `$TMPDIR/celebs-tests`.

**Fixtures:** `make-fixtures.py` builds `users.json` for three test players (Akimei is an admin) with the repo's own `tools/users.py` and `tools/ai-key.py`. All three unlock the fake token `dummy-token-for-tests` with the password `<Name>-test-pw`, and there is a fake Gemini key. The shared data is the repo's real `data.json`.

Each test prints `PASS …` or `FAIL …` per check.

| File | Covers |
|---|---|
| `test-login.js` | login screen, wrong password, opening the requested page after login, staying logged in, log out, owner sign-in |
| `test-owner.js` | owner sign-in: Owner menu, editing shared topics, sign out |
| `test-admin.js` | account menu, admin console, working on another player's data or on the shared topics, password reset, admin on/off, adding and removing players |
| `test-valorant-lock.js` | fixed list of names (Valorant), Fields & filters two-column layout, admin rights picked up on load, removed player logged out |
| `test-fields-unit.js` | bulk add, Edit details, fields (add, change, move, remove), several-answer questions, players vs shared data (calls the change functions directly) |
| `test-fields-ui.js` | the same through the page: Add names dialog, Fields & filters, Edit details, several-answer question |
| `test-ai.js` | AI pre-load on New topic (busy model and backup model, allowance used up), Suggest with AI, Remove names |
| `test-delete.js` | deleting own topics and, as admin, shared topics |
| `test-home.js` | home page, adding a field then filling it in, empty filters, who may fill which fields |
| `test-save.js` | the every-name page's Save bar, unsaved-changes prompt, several-values fields, Unknown / None / Not set labels |

When behaviour changes on purpose, update the checks that described the old behaviour (see git history for examples).
