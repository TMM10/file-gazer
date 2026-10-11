using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;

// Tests inventory adjustment helpers in memory only. Never invokes a native rename, recycle, open or launch.
internal static class LibraryChecks
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    static readonly List<string> Checks = new List<string>();
    static Type Program, Request;
    static string Fixture, DirectoryRoot, Settings, Manual;
    static BindingFlags Flags = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
    static int Main(string[] args)
    {
        try
        {
            Assembly assembly = Assembly.LoadFile(Path.GetFullPath(args[0]));
            Program = assembly.GetType("StorageAtlas.Program"); Request = assembly.GetType("StorageAtlas.Request");
            Fixture = args[1]; DirectoryRoot = args[2]; Directory.CreateDirectory(DirectoryRoot);
            Settings = Path.Combine(DirectoryRoot, "game-libraries-test.json"); Manual = Path.Combine(Fixture, "Manual");
            Field("AppDirectory", DirectoryRoot); Field("GameLibrariesFile", Settings);
            Scan(Fixture); Mark(Manual, true);
            var original = Overview(); long bytes = Number(original["size"]), files = Number(original["files"]);
            string[] physical = Directory.GetFiles(Fixture, "*", SearchOption.AllDirectories).OrderBy(p => p).ToArray();
            Field("State", "running"); Expect(409, delegate { Mark(Manual, false); }, "Running scan refuses library changes"); Field("State", "complete");
            string moved = Path.Combine(Fixture, "Manual Renamed");
            Rename(Manual, "Manual Renamed");
            Assert(Saved().Single() == moved && Libraries().Single() == moved, "Successful ancestor/library rename remaps persisted marks");
            Assert(Games().Any(g => (string)g["name"] == "Alpha" && (string)g["installationPath"] == Path.Combine(moved, "Alpha")), "Library rename preserves custom child names and remaps game paths");
            string movedAlpha = Path.Combine(moved, "Alpha"); Rename(movedAlpha, "Renamed Child");
            Assert(Games().Any(g => (string)g["name"] == "Renamed Child" && (string)g["source"] == "Custom game library"), "Custom child rename updates the game display name");
            Assert(Number(Overview()["size"]) == bytes && Number(Overview()["files"]) == files && CategorySum() == bytes, "Renames preserve bytes/files and exact mutually exclusive category totals");
            object entry = Call("FindEntry", moved); string blocked = Path.Combine(DirectoryRoot, "blocked-settings"); Directory.CreateDirectory(blocked); Field("GameLibrariesFile", blocked);
            Rename(moved, "Save Failed Rename"); string failedMoved = Path.Combine(Fixture, "Save Failed Rename");
            Assert((string)Call("FindEntry", failedMoved).GetType().GetField("Name", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(Call("FindEntry", failedMoved)) == "Save Failed Rename", "Inventory rename remains successful when settings cannot be saved");
            Assert((string)Read("SettingsWarning") != null && (bool)Read("GameLibrariesDirty"), "Native-success persistence failure keeps session settings and an explicit retry warning");
            Field("GameLibrariesFile", Settings); Call("PersistGameLibraryChanges");
            Assert(Saved().Single() == failedMoved && Read("SettingsWarning") == null && !(bool)Read("GameLibrariesDirty"), "Retry saves successful file-action settings and clears the warning");
            string child = Path.Combine(failedMoved, "Renamed Child"); Call("RemoveInventory", Call("FindEntry", child)); Call("PersistGameLibraryChanges");
            Assert(Libraries().Single() == failedMoved && Saved().Single() == failedMoved, "Confirmed game-child removal retains its parent library mark");
            Call("RemoveInventory", Call("FindEntry", failedMoved)); Call("PersistGameLibraryChanges");
            Assert(Libraries().Length == 0 && Saved().Length == 0, "Confirmed library/ancestor removal drops and persists affected marks");
            Assert(physical.SequenceEqual(Directory.GetFiles(Fixture, "*", SearchOption.AllDirectories).OrderBy(p => p)), "Inventory-only rename/removal simulations leave every physical file path unchanged");
            Scan(Fixture); string common = Path.Combine(Fixture, "Steam", "steamapps", "common"); Mark(common, true);
            string steam = Path.Combine(common, "Folder"); Rename(steam, "Renamed Steam Folder");
            var steamRow = Games().Single(g => (string)g["name"] == "Manifest Title");
            Assert((string)steamRow["steamAppId"] == "12345" && (string)steamRow["installationPath"] == Path.Combine(common, "Renamed Steam Folder"), "Launcher game rename retains manifest title and trusted Steam ID");
            Mark(common, false); Scan(Fixture);
            string ambiguous = Path.Combine(Fixture, "Ambiguous");
            Field("GameLibraries", new HashSet<string>(new[] { ambiguous }, StringComparer.OrdinalIgnoreCase)); Call("SaveGameLibraries", Read("GameLibraries"));
            Scan(Fixture);
            Assert(Inactive().Single() == ambiguous && Games().All(g => !g.ContainsKey("libraryPath")), "Later discovered custom/recognized overlap suspends a saved mark without duplicate rows");
            Assert(Number(Category("Games")["size"]) == 928 && CategorySum() == Number(Overview()["size"]), "Suspending overlap restores ordinary categories and exact known-game bytes");
            Assert(((IEnumerable)Overview()["warnings"]).Cast<object>().Any(), "Suspended saved library emits a clear scan warning");
            Call("RemoveInventory", Call("FindEntry", Path.Combine(ambiguous, "Child", "XboxGames", "Nested Game")));
            Mark(Path.Combine(Fixture, "SimpleRoot"), true);
            Assert(Inactive().Length == 0 && CategorySum() == Number(Overview()["size"]) && Number(Category("Games")["size"]) == Games().Sum(g => Number(g["size"])), "Unrelated mark after conflict removal reactivates the saved library with matching category totals");
            Mark(Path.Combine(Fixture, "SimpleRoot"), false);
            Scan(Path.Combine(ambiguous, "Child", "XboxGames", "Nested Game"));
            Assert(Inactive().Single() == ambiguous, "Partial nested recognized-game scan remains safely suspended");
            Scan(Path.Combine(Fixture, "Other"));
            Assert(Inactive().Length == 0, "A new scan clears stale inactive-library state");
            Field("GameLibraries", new HashSet<string>(new[] { Manual }, StringComparer.OrdinalIgnoreCase)); Call("SaveGameLibraries", Read("GameLibraries"));
            Scan(Path.Combine(Manual, "Beta"));
            Assert(Inactive().Length == 0 && Number(Category("Games")["size"]) == 211 && Games().Single()["name"].Equals("Beta"), "A restored partial custom game reclassifies correctly after a prior suspended scan");
            string malformed = Path.Combine(DirectoryRoot, "malformed.json"); File.WriteAllText(malformed, "{invalid-json}");
            Field("GameLibraries", new HashSet<string>(StringComparer.OrdinalIgnoreCase)); Field("GameLibrariesFile", malformed); Field("SettingsWarning", null); Call("LoadGameLibraries");
            Assert(Libraries().Length == 0 && ((string)Read("SettingsWarning")).Contains("could not be loaded"), "Malformed saved settings fail closed with an actionable warning");
            File.WriteAllText(malformed, Json.Serialize(new { paths = new[] { Manual, Path.Combine(Manual, "Alpha") } })); Field("SettingsWarning", null); Call("LoadGameLibraries");
            Assert(Libraries().Length == 0 && ((string)Read("SettingsWarning")).Contains("Nested"), "Nested persisted library declarations fail closed");
            string parent = Path.Combine(Fixture, "SimpleRoot");
            File.WriteAllText(malformed, Json.Serialize(new { paths = new[] { parent, parent.ToUpperInvariant() } })); Field("SettingsWarning", null); Call("LoadGameLibraries");
            Assert(Libraries().Length == 1 && Libraries()[0] == parent && Read("SettingsWarning") == null, "Loading settings deduplicates canonical case-insensitive paths");
            Console.WriteLine(Json.Serialize(new { checks = Checks.ToArray(), nativeFileActions = 0 })); return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex.ToString()); return 1; }
    }
    static object Read(string name) { return Program.GetField(name, Flags).GetValue(null); }
    static void Field(string name, object value) { Program.GetField(name, Flags).SetValue(null, value); }
    static object Call(string name, params object[] args) { try { return Program.GetMethod(name, Flags).Invoke(null, args); } catch (TargetInvocationException ex) { throw ex.InnerException; } }
    static Dictionary<string, object> Api(string path, object body)
    {
        object req = Activator.CreateInstance(Request, true); BindingFlags fields = BindingFlags.Instance | BindingFlags.NonPublic;
        Request.GetField("Method", fields).SetValue(req, body == null ? "GET" : "POST");
        Request.GetField("Path", fields).SetValue(req, path); Request.GetField("Query", fields).SetValue(req, ""); Request.GetField("Body", fields).SetValue(req, body == null ? "" : Json.Serialize(body));
        return Json.Deserialize<Dictionary<string, object>>(Json.Serialize(Call("Api", req)));
    }
    static void Scan(params string[] paths)
    {
        Api("/api/scan", new { paths = paths }); DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while ((string)Read("State") == "running" && DateTime.UtcNow < deadline) Thread.Sleep(20);
        Assert((string)Read("State") == "complete", "Read-only helper fixture scan completes");
    }
    static Dictionary<string, object> Mark(string path, bool enabled) { return Api("/api/game-library", new { path = path, enabled = enabled }); }
    static Dictionary<string, object> Overview() { return Api("/api/overview", null); }
    static List<Dictionary<string, object>> Games() { return ((IEnumerable)Overview()["games"]).Cast<Dictionary<string, object>>().ToList(); }
    static Dictionary<string, object> Category(string name) { return ((IEnumerable)Overview()["categories"]).Cast<Dictionary<string, object>>().Single(c => (string)c["name"] == name); }
    static long CategorySum() { return ((IEnumerable)Overview()["categories"]).Cast<Dictionary<string, object>>().Sum(c => Number(c["size"])); }
    static string[] Libraries() { return ((HashSet<string>)Read("GameLibraries")).ToArray(); }
    static string[] Inactive() { return ((HashSet<string>)Read("InactiveGameLibraries")).ToArray(); }
    static string[] Saved() { return ((IEnumerable)Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Settings))["paths"]).Cast<string>().ToArray(); }
    static long Number(object value) { return Convert.ToInt64(value); }
    static void Rename(string oldPath, string name) { object node = Call("FindEntry", oldPath); if (node == null) throw new Exception("Missing inventory node: " + oldPath); Call("UpdateRename", node, oldPath, name); }
    static void Assert(bool condition, string description) { if (!condition) throw new Exception("Failed: " + description); Checks.Add(description); }
    static void Expect(int code, Action action, string description) { try { action(); } catch (Exception ex) { FieldInfo field = ex.GetType().GetField("Code", BindingFlags.Instance | BindingFlags.NonPublic); if (field != null && (int)field.GetValue(ex) == code) { Checks.Add(description); return; } throw; } throw new Exception("Unexpected success: " + description); }
}
