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
node tests/verify_clusters.cjs --chrome <browser-executable>
node tests/verify_artwork.cjs --chrome <browser-executable>
node tests/verify_menus.cjs --chrome <browser-executable>
node tests/verify_extension_tail.cjs --chrome <browser-executable>
node tests/verify_performance.cjs --chrome <browser-executable>
```

Coverage includes continuous camera movement, immediate-level focus, nested folder trails, screen-space rendering, parent headers, exact areas, positive gaps, directional momentum, reduced motion, Steam identity and saved-library menu contracts. The cluster fixture includes two large files, hundreds of small real siblings, a small folder and a zero-byte file. Cluster checks exercise actual right-click exploration, Shift selection, exact paged remainders, running-scan paging guards, page-local search counts and compact layouts. The zero-coordinate keyboard context-menu case dispatches that specific browser event on a focused SVG element; the other pointer and wheel checks use browser input.

Artwork checks load only generated cover images. They verify lazy loading, hero-to-capsule fallback, missing-image and invalid-identity behavior, rejected external URLs, true circle clipping and scene cleanup. Menu checks cover synthetic category/type groups, filesystem actions in Games and folder views, repeated tree/details dialogs in full screen, search-file parent derivation, and delayed tree replies after an inventory revision changes. Native Properties requests are intercepted; no Windows dialog or personal file action is invoked.

The following suites need a running service only to serve static UI assets. API responses and native requests are intercepted. Use the dedicated service described below and pass its URL:

```powershell
node tests/verify_camera.cjs --synthetic-only --base-url http://127.0.0.1:47841 --chrome <browser-executable>
node tests/verify_actions.cjs --base-url http://127.0.0.1:47841 --chrome <browser-executable>
node tests/verify_category_context.cjs --base-url http://127.0.0.1:47841 --chrome <browser-executable>
node tests/verify_fullscreen.cjs --base-url http://127.0.0.1:47841 --chrome <browser-executable>
```

Keep `--synthetic-only` on the camera verifier to omit its optional read-only checks of a real inventory. No PC-specific diagnostic or recording helper is included.

## Animation timing and lifecycle

Run the timing suite while other browser tests are closed. It records actual painted-frame work, separately counts skipped scheduler callbacks, and compares generated workloads of 60, 240 and 600 siblings. Chromium also uses a deliberate 4× CPU throttle for the 240-item case. Browser frame availability and camera paint intervals are recorded separately; headless browser frame rates do not establish a monitor refresh rate or a performance guarantee for another PC.

```powershell
node tests/verify_performance.cjs --chrome <browser-executable>
node tests/verify_performance.cjs --skip-lifecycle --report performance-paint-report.json --chrome <browser-executable>
```

`--baseline` saves a separately named baseline report for the current checked-out source. `--skip-lifecycle` repeats only the timing workloads after a drawing optimization. `--lifecycle-only` runs only motion, settling, visibility and reduced-motion checks. `--skip-throttle` omits the Chromium throttle; `--chromium-only` omits Firefox. Reports contain source hashes and remain ignored by Git.

Lifecycle checks observe painted movement beyond 300 milliseconds, independent offsets, positive gaps, exact logical areas, settling to no scheduled frames, offscreen suspension, reentry and pan culling. Positional motion must remain at most 6.4 screen pixels and area-preserving squash/stretch at most 2 pixels. Browser SVG transform matrices use float precision, so their measured area has a separate 0.0001% tolerance; logical byte ratios retain the tighter double-precision check. Firefox reduced motion is tested using a fresh isolated browser with its native preference enabled.

The focused development run passed 60 timing/lifecycle checks and a subsequent 30-check paint-only repeat. Cluster checks passed 70/70, artwork 24/24 and menus 54/54 across Chromium and Firefox. The drawing optimization also retained the 61 rendering and 113 folder-label checks; motion and momentum passed 42 and 74 checks with the updated screen caps. Individual paint cost and animation cadence are separate measurements: fewer frames can reduce work without making each frame faster. Generated bare-camera workloads also omit image decoding and the rest of the app UI, so these observations should not be presented as an end-to-end hardware benchmark.

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
powershell -NoProfile -ExecutionPolicy Bypass -File backend/verify-artwork.ps1
```

The actions verifier renames and recycles only its owned fixture items, which remain recoverable in the Windows Recycle Bin. Steam verification compiles a fixture-only build that suppresses the native Steam protocol launch. Library verification uses an independent port and inventory-only simulations for persistence changes. Do not run native fixture checks against a service whose inventory you want to preserve. Stop the owned isolated service after testing.

The artwork verifier builds an in-process fixture harness with native Shell and remote-image access suppressed. It covers validated metadata and query scope, bounded local cache reads, image dimensions and downsampling, game-details counters, and reuse of a persistent STA message pump for Properties. Its mock checks the message-pump lifetime and inventory-lock separation; it does not substitute for manually inspecting a real Windows Properties dialog.

## Portable release

`python tools/package_release.py` verifies the runtime-only allowlist, ZIP integrity and source hashes. It includes a generic guide and the vendored license; no tests, generated fixtures, personal settings or diagnostics are included.
