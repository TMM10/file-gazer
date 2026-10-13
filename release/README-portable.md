# File Gazer

A visual storage explorer for Windows. Bubble areas compare file and folder sizes, with smooth zooming, dragging, nested folders, categories and Games views.

## Open

1. Extract the entire ZIP into a folder you can write to, such as Documents. Keep the executable and `ui` folder together.
2. Double-click **FileGazer.exe**. File Gazer opens in your default browser.
3. Choose your own drives or folders and start a scan.

Requires Windows 10 or 11, .NET Framework 4.8, and a current Edge, Chrome or Firefox browser. No installer, Node.js, Python, Codex or developer tools are required. The app runs locally on your PC. Open the extracted executable, rather than running it from inside the ZIP.

## Explore

Scroll over the map to zoom, drag with the left mouse button to pan, and click a folder to focus its immediate contents. Faster dragging creates stronger spring movement; scrolling gives it a directional response. Use the fullscreen button for a larger map.

Smaller items gather in a quiet central cluster beside their larger siblings. Click or zoom into the cluster to bring those bubbles to life; the larger surrounding bubbles settle. There is no extra folder level. If a folder has many items, use **Load more items** inside the cluster to reveal the next batch.

Right-click an item for Explorer, properties, a traditional file tree, path copying, rename and Recycle Bin actions. Deleting requires confirmation. Shift-click selects several items. Recognized Steam games offer **View in Steam** when their installation metadata includes a valid Steam ID.

For other game collections, right-click a folder and choose **Mark as game library**. Each immediate subfolder becomes a game entry with its scanned size. Choose **Unmark game library** to undo the setting. Overlapping libraries are refused to prevent duplicate size totals.

Recognized Steam games can show library artwork. File Gazer checks Steam's local image cache first, then Steam's image servers using the game's app ID. Artwork is optional and does not require a Steam sign-in. Cards are resized and cached in memory. Unrecognized games keep their category colors.

Sizes represent logical file bytes. Protected folders and linked paths may be skipped; warnings explain incomplete results. Rescan after external file changes. Scan results remain in memory while the app runs; JSON export saves a snapshot. The ZIP contains no scan results, personal file names, saved libraries or machine settings.

Closing the browser leaves File Gazer running. Choose **Exit** from its star tray icon to stop it. File Gazer creates a small `backend/server.port` file and, when you mark libraries, `game-libraries.json` beside the executable. These are specific to your own installation and are absent from this download.

The bundled d3-hierarchy library's license is in `ui/vendor/d3-hierarchy-LICENSE.txt`.
