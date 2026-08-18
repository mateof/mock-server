# Tests

Two suites, run separately because they cost very different amounts.

| Command | What it runs |
|---------|--------------|
| `npm test` | Unit and integration, in Jest. Under a second |
| `npm run test:e2e` | Browser smoke tests, in Playwright. Around twelve seconds |
| `npm run test:all` | Both |
| `npm run test:e2e:ui` | Playwright's interactive runner, for debugging a failure |

## Unit tests

`tests/unit/` and `tests/integration/`, Jest, no browser and no server. This is where the logic lives: template rendering, scenario step selection, fault thresholds, recording conversion, the criteria evaluator, the script sandbox.

They favour boundaries over happy paths, and anything with randomness takes its random function as a parameter so it can be pinned. A "20% failure rate" tested against real randomness would fail one run in five, and a test like that gets deleted rather than fixed.

## Browser tests

`tests/e2e/`, Playwright, Chromium only. They cover the four paths you always walk: opening the panel, creating a route through the form, filtering by tag, and opening a request trace. Those are the ones that broke silently, because nothing below the UI notices.

They are smoke tests on purpose. Everything underneath is already covered by unit tests, and a browser suite that tries to cover everything becomes slow enough that people stop running it.

### How they stay reliable

- **Isolated data.** The server runs with `MOCK_SERVER_DATA_DIR` pointed at `tests/e2e/.data`, wiped before every run. Nothing touches your development database, and a test that counts rows does not depend on what the previous run left behind.
- **Serial, one worker.** The suite shares a stateful server, so parallel tests would overwrite each other's routes.
- **Waiting on data, not on time.** The log writes in 500 ms batches and the log screen queries once on load. A test that navigates too early sees an empty table forever, and Playwright's retries do not help because the DOM will never change on its own. `esperarEnElLog()` polls the API until the entry is really there, then opens the page.
- **Traces on failure only.** A failing test leaves a screenshot and a Playwright trace in `test-results/`. Open it with `npx playwright show-trace <path>`.

### Adding one

Keep it about a path a user actually walks, and assert on something the user would notice. If what you want to check is a calculation, it belongs in a unit test, where it will run in milliseconds instead of seconds.

## In CI

`.github/workflows/test.yml` runs both, in separate jobs. Downloading Chromium takes longer than every unit test put together, so it does not hold up their result. The browser job installs only Chromium, and uploads its report as an artifact when it fails.

## The data directory

`MOCK_SERVER_DATA_DIR` moves the database, the uploaded files and the auto-import folder somewhere else. Without it, everything stays where it always was. It exists so tests can be isolated, and it also means a deployment can mount its volume wherever it likes without touching code.
