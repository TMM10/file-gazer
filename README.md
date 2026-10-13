# File Gazer

Explore Windows storage as an interactive map of folders, files and games. Bubble areas represent logical file sizes: among siblings, twice the bytes means twice the area.

## Use the app

Download [FileGazer-Portable.zip](https://github.com/TMM10/file-gazer/releases/latest/download/FileGazer-Portable.zip), extract the entire folder, and open **FileGazer.exe**. Select your own drives or folders to scan.

Requires Windows 10 or 11, .NET Framework 4.8 and a current Edge, Chrome or Firefox browser. The portable app needs no installer, administrator access, Node.js, Python or developer tools. Keep the executable and `ui` folder together in a writable location.

- Scroll to zoom continuously, drag to pan and click a folder to focus its immediate contents.
- Compare the folder hierarchy, categories, installed games and file types.
- Search, browse a traditional file tree, and export a JSON inventory.
- Enter fullscreen with floating navigation, contents and tools.
- Right-click for Explorer, properties, path copying, rename and confirmed Recycle Bin actions. Shift-click selects multiple items.
- Mark a folder as a game library: each immediate subfolder becomes its own game entry. Steam and Epic metadata retain their launcher identities.
- Open recognized Steam installations directly in the Steam library.
- Recognized Steam game bubbles use library artwork, with a quiet color fallback when a card is unavailable.
- Smaller siblings sit together in a central cluster. Click or zoom into it to explore them without adding a folder level; surrounding larger bubbles settle while the cluster moves.
- Bubble motion responds to gesture momentum with slower settling, while the starry background is drawn once for each viewport size.

Each sibling group uses one size scale; nested groups use a local scale inside their parent. Logical bytes can differ from physical disk usage because of compression, sparse files, hard links and protected storage. Linked paths are skipped to prevent loops. Scans are read-only; file changes require choosing an explicit action.

File Gazer runs locally on `127.0.0.1`. Scan results stay in memory until the app exits. Saved game-library choices are specific to the installation. No personal inventory, settings, screenshots or machine data are included in this repository or the portable download. Closing the browser leaves the service running; use **Exit** from the star tray icon to stop it.

Steam artwork uses the local Steam cache first. Missing cards can be fetched from Steam's image servers using the recognized app ID; this does not require signing in to Steam or sending your file inventory. Custom libraries without launcher IDs keep their category colors. Artwork is resized and held in a bounded memory cache.

## Build on Windows

The backend uses the .NET Framework compiler provided with Windows. There are no NuGet packages or frontend build steps.

From the repository root, with an existing File Gazer process stopped:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend/build.ps1
.\FileGazer.exe
```

The build creates `FileGazer.exe` beside the `ui` folder. The icon is embedded from `ui/file-gazer.ico`. Native runtime artifacts are ignored by Git.

To build the portable ZIP, use Python 3.9 or newer:

```powershell
python tools/package_release.py
```

This produces `FileGazer-Portable.zip` from an explicit runtime-only allowlist: the executable, UI assets, third-party license and generic user guide. It excludes source tests, settings, scan exports, reports and captures. Publish the ZIP as a release asset rather than committing it to Git.

To prepare a separate local preview without replacing the shared release ZIP:

```powershell
python tools/package_release.py --output release/preview/FileGazer-Portable.zip --stage release/preview/FileGazer --manifest release/preview/package-manifest.json
```

## Development and tests

The UI uses plain HTML, CSS and JavaScript with a vendored d3-hierarchy library. The native service supplies paginated hierarchy and category data to a persistent browser camera. See [backend/API.md](backend/API.md) for endpoint and inventory contracts.

Optional test dependencies require Node.js 20 or newer:

```powershell
npm install
npm test
```

`npm test` runs numerical layout checks without a browser or service. Other suites use Playwright and virtual inventories; native scanner tests use a separate fixture-only service. See [tests/README.md](tests/README.md) for setup and commands.

Keep private data out of commits. Generated settings, inventories, diagnostics, fixture directories, binary builds and recordings are excluded by `.gitignore`.

## License

The bundled d3-hierarchy library retains its license in [ui/vendor/d3-hierarchy-LICENSE.txt](ui/vendor/d3-hierarchy-LICENSE.txt). A separate application license for File Gazer has not been specified.
