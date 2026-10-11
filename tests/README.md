# Verification

Generated fixture data, inventory exports, reports, screenshots and recordings are ignored by Git. Only generic test source and virtual fixture definitions belong in this repository.

## Numerical layout

Requires Node.js 20 or newer:

```powershell
npm test
```

This checks actual circle packing, proportional byte areas, strict gaps, zero weights and circular enclosure. No browser, service or network request is involved.

## Browser suites

Install the optional development dependencies with `npm install`. Use a current installed Chrome or Edge executable with `--chrome <browser-executable>` when the default Playwright Chromium is unavailable. Stock Firefox suites use Playwright's `moz-firefox` channel and require Firefox to be installed. `--playwright-module <module-directory>` can select an existing Playwright installation.

These suites serve production assets and virtual inventories through interception, or construct a standalone in-memory camera stage. They do not contact a native service or perform personal file actions:

```powershell
node tests/singleton-labels.cjs --chrome <browser-executable>
node tests/verify_motion.cjs --chrome <browser-executable>
node tests/verify_rendering.cjs --chrome <browser-executable>
node tests/verify_momentum.cjs --chrome <browser-executable>
node tests/verify_steam.cjs --chrome <browser-executable>
node tests/verify_game_libraries.cjs --chrome <browser-executable>
```

Coverage includes continuous camera movement, immediate-level focus, nested folder trails, screen-space rendering, parent headers, exact areas, positive gaps, directional momentum, reduced motion, Steam identity and saved-library menu contracts.

The following suites need a running service only to serve static UI assets. API responses and native requests are intercepted. Use the dedicated service described below and pass its URL:

```powershell
node tests/verify_camera.cjs --synthetic-only --base-url http://127.0.0.1:47841 --chrome <browser-executable>
node tests/verify_actions.cjs --base-url http://127.0.0.1:47841 --chrome <browser-executable>
node tests/verify_category_context.cjs --base-url http://127.0.0.1:47841 --chrome <browser-executable>
node tests/verify_extension_tail.cjs --base-url http://127.0.0.1:47841 --chrome <browser-executable>
node tests/verify_fullscreen.cjs --base-url http://127.0.0.1:47841 --chrome <browser-executable>
```

Keep `--synthetic-only` on the camera verifier to omit its optional read-only checks of a real inventory. No PC-specific diagnostic or recording helper is included.

## Scanner and native fixtures

Build the executable, then start an isolated instance in a separate terminal:

```powershell
.\FileGazer.exe --no-browser --port=47841
```

Python 3 with its standard library can run the scanner integration checks:

```powershell
python tests/verify_api.py --base-url http://127.0.0.1:47841
```

These checks scan only owned temporary fixtures and replace only the isolated service's inventory. The ACL case temporarily blocks access to one owned fixture directory and restores its permissions. `--skip-acl` and `--skip-cancellation` omit those cases when needed.

Additional checks that use the same manually started service:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend/verify-extra.ps1 -BaseUrl http://127.0.0.1:47841
powershell -NoProfile -ExecutionPolicy Bypass -File backend/verify-tail.ps1 -BaseUrl http://127.0.0.1:47841
powershell -NoProfile -ExecutionPolicy Bypass -File backend/verify-actions.ps1 -BaseUrl http://127.0.0.1:47841
```

Stop the manually started isolated service before these self-managed checks so their dedicated fixture ports are available:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend/verify-steam.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File backend/verify-game-libraries.ps1
```

The actions verifier renames and recycles only its owned fixture items, which remain recoverable in the Windows Recycle Bin. Steam verification compiles a fixture-only build that suppresses the native Steam protocol launch. Library verification uses an independent port and inventory-only simulations for persistence changes. Do not run native fixture checks against a service whose inventory you want to preserve. Stop the owned isolated service after testing.

## Portable release

`python tools/package_release.py` verifies the runtime-only allowlist, ZIP integrity and source hashes. It includes a generic guide and the vendored license; no tests, generated fixtures, personal settings or diagnostics are included.
