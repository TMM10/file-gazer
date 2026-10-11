"""Observable API integration checks for File Gazer; standard library only.

Creates a small fixture under tests/.fixtures, checks logical bytes and read-only
behavior, and writes a machine-readable report. Never scans real drive roots.
Run after launching FileGazer.exe --no-browser --port=47841:
    python tests/verify_api.py [--base-url http://127.0.0.1:47841]
"""
from __future__ import annotations

import argparse
import csv
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


CATEGORY_NAMES = {
    "Games", "Applications", "System", "Videos", "Images", "Audio",
    "Documents", "Archives", "Code", "Other",
}
TERMINAL_STATES = {"completed", "complete", "cancelled", "canceled", "failed", "error"}


def normal_path(value):
    return os.path.normcase(os.path.normpath(str(value)))


def is_reparse(path: Path):
    return bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def snapshot(root: Path):
    files = {}
    for current, directories, names in os.walk(root, followlinks=False):
        directories[:] = [d for d in directories if not is_reparse(Path(current, d))]
        for name in names:
            path = Path(current, name)
            if not is_reparse(path):
                files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


class SavedWindowsAcl:
    """Retain a DACL before denial, then restore with WRITE_DAC only.

    icacls /remove and Set-Acl first read target permissions, which a deny RX
    ACE also blocks. SetFileSecurity can restore a saved DACL directly.
    """
    def __init__(self, path: Path):
        self.api = ctypes.WinDLL("advapi32", use_last_error=True)
        self.descriptor = ctypes.c_void_p()
        self.dacl = ctypes.c_void_p()
        result = self.api.GetNamedSecurityInfoW(
            ctypes.c_wchar_p(str(path)), 1, 4, None, None,
            ctypes.byref(self.dacl), None, ctypes.byref(self.descriptor))
        if result:
            raise OSError(result, "Cannot capture fixture ACL")

    def restore(self, path: Path):
        result = self.api.SetFileSecurityW(ctypes.c_wchar_p(str(path)), 4, self.descriptor)
        if not result:
            raise OSError(ctypes.get_last_error(), "Cannot restore fixture ACL")

    def close(self):
        if self.descriptor:
            ctypes.WinDLL("kernel32").LocalFree(self.descriptor)
            self.descriptor = ctypes.c_void_p()


def create_fixture(parent: Path):
    parent.mkdir(parents=True, exist_ok=True)
    fixture = Path(tempfile.mkdtemp(prefix="api-", dir=parent))
    primary, secondary = fixture / "primary", fixture / "secondary"
    manifest = ('"AppState"\n{\n "appid" "12345"\n "name" "Fixture Galaxy"\n'
                ' "installdir" "Fixture Game"\n}\n').encode("utf-8")
    definitions = {
        "primary/Loose.txt": (111, "Documents"),
        "primary/Résumé 雪.txt": (41, "Documents"),
        "primary/portrait.png": (223, "Images"),
        "primary/clip.mp4": (337, "Videos"),
        "primary/archive.zip": (449, "Archives"),
        "primary/Music/song.flac": (557, "Audio"),
        "primary/Documents/notes.pdf": (661, "Documents"),
        "primary/Documents/nested/data.json": (773, "Code"),
        "primary/Documents/empty.txt": (0, "Documents"),
        "primary/Downloads/install.exe": (887, "Applications"),
        "primary/steamapps/common/Fixture Game/game.bin": (997, "Games"),
        "primary/steamapps/common/Fixture Game/assets/galaxy.pak": (1103, "Games"),
        "primary/steamapps/common/Fixture Game/readme.txt": (127, "Games"),
        "primary/Sub/a.txt": (73, "Documents"),
        "primary/Submarine/b.txt": (79, "Documents"),
        "secondary/extra.jpeg": (123, "Images"),
        "secondary/sample.dat": (97, "Other"),
    }
    for relative, (size, _) in definitions.items():
        path = fixture / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes([size % 251]) * size)
    manifest_path = primary / "steamapps/appmanifest_12345.acf"
    manifest_path.write_bytes(manifest)
    definitions[str(manifest_path.relative_to(fixture)).replace("\\", "/")] = (len(manifest), "Other")
    (primary / "Empty folder").mkdir()
    (primary / "steamapps/common/Fixture Game/empty-assets").mkdir()

    junction_created = False
    if os.name == "nt":
        # The junction stays wholly inside the fixture. Scanner must skip it.
        command = ("New-Item -ItemType Junction -Path '" + str(primary / "loop").replace("'", "''")
                   + "' -Target '" + str(primary).replace("'", "''") + "' | Out-Null")
        result = subprocess.run(["powershell", "-NoProfile", "-Command", command],
                                capture_output=True, text=True)
        junction_created = result.returncode == 0
    return fixture, primary, secondary, definitions, junction_created


class Runner:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.checks = []

    def check(self, name, condition, detail=None):
        entry = {"name": name, "passed": bool(condition)}
        if detail is not None:
            entry["detail"] = detail
        self.checks.append(entry)
        print(("PASS " if condition else "FAIL ") + name)
        if not condition and detail is not None:
            print("  " + json.dumps(detail, ensure_ascii=False))
        return bool(condition)

    def request(self, path, payload=None, method=None):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"} if data is not None else {}
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers,
                                         method=method or ("POST" if data is not None else "GET"))
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")
            return json.loads(raw) if "json" in content_type else raw.decode("utf-8-sig")

    def node(self, path, **options):
        return self.request("/api/node?" + urllib.parse.urlencode({"path": str(path), **options}))

    def start_scan(self, paths):
        response = self.request("/api/scan", {"paths": [str(p) for p in paths]})
        return response.get("id")

    def wait_scan(self, scan_id, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.request("/api/status")
            if str(status.get("state", "")).lower() in TERMINAL_STATES:
                self.check("scan id tracks requested scan", status.get("id") == scan_id,
                           {"requested": scan_id, "status": status})
                return status
            time.sleep(0.05)
        raise TimeoutError("Scan did not terminate within the fixture timeout")


def category_totals(overview):
    categories = overview.get("categories", [])
    if isinstance(categories, dict):
        return {key: value if isinstance(value, int) else value.get("size", 0)
                for key, value in categories.items()}
    return {item.get("name", item.get("category")): item.get("size", 0) for item in categories}


def result_list(response):
    if isinstance(response, list):
        return response
    return response.get("results", response.get("items", []))


def run(args):
    test_dir = Path(__file__).resolve().parent
    fixture, primary, secondary, definitions, junction = create_fixture(test_dir / ".fixtures")
    before = snapshot(fixture)
    runner = Runner(args.base_url)
    metadata = {"fixture": str(fixture), "baseUrl": args.base_url,
                "junctionCreated": junction}
    baseline_total = sum(size for size, _ in definitions.values())
    primary_total = sum(size for path, (size, _) in definitions.items() if path.startswith("primary/"))
    primary_count = sum(path.startswith("primary/") for path in definitions)
    try:
        health = runner.request("/api/health")
        runner.check("health identifies Storage Atlas", health.get("app") == "StorageAtlas", health)
        drives = runner.request("/api/drives")
        drive_items = drives if isinstance(drives, list) else drives.get("drives", [])
        runner.check("drive inventory returns at least one real drive", len(drive_items) > 0)

        duplicate_case = str(primary).upper() if os.name == "nt" else str(primary)
        scan_id = runner.start_scan([primary, secondary, duplicate_case, primary / "Documents"])
        status = runner.wait_scan(scan_id)
        runner.check("small scan completes", str(status.get("state")).lower() in {"completed", "complete"}, status)
        overview = runner.request("/api/overview")
        runner.check("overlapping and duplicate roots counted once", overview.get("size") == baseline_total,
                     {"expected": baseline_total, "actual": overview.get("size")})
        runner.check("deduplicated roots retained", len(overview.get("roots", [])) == 2, overview.get("roots"))
        runner.check("logical scan byte counter exact", status.get("bytes") == baseline_total, status.get("bytes"))
        runner.check("logical file counter includes zero-byte file", status.get("files") == len(definitions), status.get("files"))

        node = runner.node(primary)
        runner.check("nested folder aggregates exact bytes", node.get("size") == primary_total,
                     {"expected": primary_total, "actual": node.get("size")})
        runner.check("nested folder aggregates exact file count", node.get("fileCount") == primary_count,
                     {"expected": primary_count, "actual": node.get("fileCount")})
        children = node.get("children", [])
        child_names = {c.get("name") for c in children}
        runner.check("files and folders coexist in node children", {"Loose.txt", "Documents"}.issubset(child_names), list(child_names))
        positive_sizes = [c.get("size", 0) for c in children]
        runner.check("children sorted by descending bytes", positive_sizes == sorted(positive_sizes, reverse=True))
        runner.check("empty folder remains visible", "Empty folder" in child_names)
        documents = runner.node(primary / "Documents")
        runner.check("zero-byte item remains visible", any(c.get("name") == "empty.txt" and c.get("size") == 0
                                                           for c in documents.get("children", [])))

        expected_categories = {}
        for size, category in definitions.values():
            expected_categories[category] = expected_categories.get(category, 0) + size
        actual_categories = category_totals(overview)
        runner.check("category bytes sum to scan bytes", sum(actual_categories.values()) == baseline_total, actual_categories)
        runner.check("category labels are recognizable", set(actual_categories).issubset(CATEGORY_NAMES), actual_categories)
        for category, expected in expected_categories.items():
            runner.check(f"{category} totals match known fixture", actual_categories.get(category, 0) == expected,
                         {"expected": expected, "actual": actual_categories.get(category, 0)})
        images = runner.node(primary, category="Images")
        runner.check("category-filtered root reports filtered bytes", images.get("size") == 223, images.get("size"))
        runner.check("category-filtered children contain matching bytes only",
                     sum(c.get("size", 0) for c in images.get("children", [])) == 223, images.get("children"))
        images_lower = runner.node(primary, category="images")
        runner.check("category filters accept case-insensitive labels", images_lower.get("size") == 223)
        absent = runner.node(primary / "Documents", category="Videos")
        runner.check("category with no matching bytes produces empty view", absent.get("size") == 0
                     and not absent.get("children"), absent)
        game_node = runner.node(primary / "steamapps/common/Fixture Game", category="Games")
        runner.check("game folder includes all descendant file types", game_node.get("size") == 2227, game_node)
        games = overview.get("games", [])
        game_matches = [g for g in games if g.get("name") == "Fixture Galaxy"]
        runner.check("Steam manifest supplies human game name", len(game_matches) == 1, games)
        runner.check("Steam game total exact", len(game_matches) == 1 and game_matches[0].get("size") == 2227, game_matches)

        search = result_list(runner.request("/api/search?" + urllib.parse.urlencode({"q": "GALAXY"})))
        runner.check("search is case insensitive and finds nested file",
                     any(normal_path(r.get("path", "")) == normal_path(primary / "steamapps/common/Fixture Game/assets/galaxy.pak")
                         for r in search), search)
        empty_search = result_list(runner.request("/api/search?q=no-such-fixture-file-79df"))
        runner.check("search miss returns no results", not empty_search)
        unicode_search = result_list(runner.request("/api/search?" + urllib.parse.urlencode({"q": "雪"})))
        runner.check("Unicode file names survive scan and search", len(unicode_search) == 1
                     and unicode_search[0].get("name") == "Résumé 雪.txt", unicode_search)
        image_search = result_list(runner.request("/api/search?" + urllib.parse.urlencode(
            {"q": "", "extension": ".png", "category": "Images", "path": str(primary)})))
        runner.check("search supports combined extension, category and path scope",
                     len(image_search) == 1 and image_search[0].get("name") == "portrait.png", image_search)
        page = runner.node(primary, offset=1, limit=2)
        runner.check("node pagination respects limit", len(page.get("children", [])) == 2, page)
        runner.check("node pagination preserves totalChildren", page.get("totalChildren") == len(children), page.get("totalChildren"))
        runner.check("node pagination returns requested ordered slice",
                     [c.get("path") for c in page.get("children", [])] == [c.get("path") for c in children[1:3]])
        runner.check("paged node retains total child byte size", page.get("childrenSizeTotal") == primary_total,
                     {"expected": primary_total, "actual": page.get("childrenSizeTotal")})
        exported = runner.request("/api/export")
        export_string = json.dumps(exported) if not isinstance(exported, str) else exported
        runner.check("export includes scanned file structure", "Loose.txt" in export_string and "Fixture Game" in export_string)
        runner.check("export includes exact root bytes", str(primary_total) in export_string)
        export_files = {}
        def collect_files(items):
            for item in items:
                if str(item.get("kind", "")).lower() == "file":
                    export_files[normal_path(item.get("path"))] = item.get("size")
                collect_files(item.get("children", []))
        if isinstance(exported, dict):
            collect_files(exported.get("roots", []))
        expected_export_files = {normal_path(fixture / path): size for path, (size, _) in definitions.items()}
        runner.check("JSON export preserves every file path and exact size", export_files == expected_export_files,
                     {"expectedFiles": len(expected_export_files), "actualFiles": len(export_files)})
        if junction:
            runner.check("junction loop is skipped without byte duplication", overview.get("size") == baseline_total)
            warnings = overview.get("warnings", [])
            runner.check("junction skip is reported", bool(warnings), warnings)

        # Prefix similarity must not be mistaken for ancestry during root deduplication.
        scan_id = runner.start_scan([primary / "Sub", primary / "Submarine"])
        status = runner.wait_scan(scan_id)
        prefix_overview = runner.request("/api/overview")
        runner.check("sibling path prefixes remain separate roots", len(prefix_overview.get("roots", [])) == 2
                     and prefix_overview.get("size") == 152, prefix_overview)

        missing = fixture / "this-path-does-not-exist"
        prior_status = runner.request("/api/status")
        missing_rejected = False
        try:
            runner.start_scan([primary / "Documents", missing])
        except urllib.error.HTTPError as error:
            missing_rejected = error.code == 400
        runner.check("missing root produces explicit bad-request response", missing_rejected)
        missing_overview = runner.request("/api/overview")
        runner.check("rejected roots preserve previous inventory", missing_overview.get("size") == 152
                     and runner.request("/api/status").get("id") == prior_status.get("id"), missing_overview)

        game_installation = primary / "steamapps/common/Fixture Game"
        game_assets = game_installation / "assets"
        scan_id = runner.start_scan([game_assets])
        status = runner.wait_scan(scan_id)
        asset_overview = runner.request("/api/overview")
        asset_games = asset_overview.get("games", [])
        runner.check("game subfolder scan retains surrounding Steam metadata",
                     len(asset_games) == 1 and asset_games[0].get("name") == "Fixture Galaxy", asset_games)
        runner.check("game subfolder category total matches only scanned bytes",
                     asset_overview.get("size") == 1103 and category_totals(asset_overview).get("Games") == 1103,
                     asset_overview)
        if asset_games:
            game_row = asset_games[0]
            runner.check("game subfolder row navigates to scanned inventory node",
                         normal_path(game_row.get("path")) == normal_path(game_assets)
                         and runner.node(game_row.get("path")).get("size") == 1103, game_row)
            runner.check("game subfolder row preserves true installation location",
                         normal_path(game_row.get("installationPath")) == normal_path(game_installation), game_row)

        if os.name == "nt" and not args.skip_acl:
            permission_root = fixture / "permission-case"
            denied = permission_root / "blocked"
            denied.mkdir(parents=True)
            (denied / "private.dat").write_bytes(b"p" * 101)
            (permission_root / "visible.txt").write_bytes(b"v" * 37)
            permission_before = snapshot(permission_root)
            saved_acl = SavedWindowsAcl(denied)
            user_result = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"],
                                         capture_output=True, text=True, check=True)
            sid = next(csv.reader(user_result.stdout.strip().splitlines()))[1]
            deny_result = subprocess.run(["icacls", str(denied), "/deny", f"*{sid}:(RX)"],
                                         capture_output=True, text=True)
            if deny_result.returncode == 0:
                try:
                    inaccessible = False
                    try:
                        list(denied.iterdir())
                    except PermissionError:
                        inaccessible = True
                    runner.check("permission fixture is demonstrably inaccessible", inaccessible)
                    scan_id = runner.start_scan([permission_root])
                    status = runner.wait_scan(scan_id)
                    protected_overview = runner.request("/api/overview")
                    runner.check("inaccessible child does not prevent readable sibling scan",
                                 protected_overview.get("size") == 37, protected_overview)
                    runner.check("inaccessible child reports partial coverage",
                                 bool(protected_overview.get("warnings")) and status.get("errors", 0) > 0,
                                 protected_overview.get("warnings"))
                    metadata["inaccessibleFolderTest"] = "verified using temporary deny ACL on owned fixture only"
                finally:
                    saved_acl.restore(denied)
                    saved_acl.close()
                    runner.check("temporary fixture deny ACL restored", True)
                runner.check("permission scan leaves fixture bytes intact", snapshot(permission_root) == permission_before)
            else:
                saved_acl.close()
                metadata["inaccessibleFolderTest"] = "ACL creation unavailable: " + deny_result.stderr.strip()
        else:
            metadata["inaccessibleFolderTest"] = "skipped by option or non-Windows platform"

        if not args.skip_cancellation:
            cancellation = fixture / "cancellation"
            cancellation.mkdir()
            for i in range(6000):
                directory = cancellation / f"branch-{i % 60:02d}"
                directory.mkdir(exist_ok=True)
                (directory / f"item-{i:05d}.dat").write_bytes(b"x")
            cancel_before = snapshot(cancellation)
            scan_id = runner.start_scan([cancellation])
            runner.request("/api/cancel", {}, method="POST")
            status = runner.wait_scan(scan_id)
            runner.check("cancel request reaches cancelled terminal state", str(status.get("state")).lower() in {"cancelled", "canceled"}, status)
            runner.check("cancellation retains readable partial snapshot", isinstance(runner.request("/api/overview"), dict))
            runner.check("cancelled scan leaves fixture content intact", snapshot(cancellation) == cancel_before)
        else:
            metadata["cancellation"] = "explicitly skipped"
    except Exception as error:
        runner.check("integration runner finishes without protocol error", False,
                     {"type": type(error).__name__, "message": str(error)})
    finally:
        after = snapshot(fixture)
        unchanged = all(after.get(path) == digest for path, digest in before.items())
        runner.check("all original fixture files remain byte-for-byte intact", unchanged)
        report = {**metadata, "checks": runner.checks,
                  "passed": sum(c["passed"] for c in runner.checks),
                  "failed": sum(not c["passed"] for c in runner.checks)}
        report_path = test_dir / "api-report.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Report: {report_path}")
        print(f"Result: {report['passed']} passed, {report['failed']} failed")
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:47841")
    parser.add_argument("--skip-cancellation", action="store_true")
    parser.add_argument("--skip-acl", action="store_true")
    raise SystemExit(run(parser.parse_args()))
