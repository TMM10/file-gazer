using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace StorageAtlas
{
    // Scan enumeration is read-only. Explicit file actions are separately guarded and inventory scoped.
    // File contents are never read except bounded launcher metadata.
    internal sealed class Entry
    {
        internal string Name, RootPath;
        internal Entry Parent;
        internal bool Folder;
        internal long Size, Files, Folders;
        internal int Category;
        internal List<Entry> Children;
        internal long[] CategorySizes, CategoryFiles;
        internal string Path { get { return Parent == null ? RootPath : Parent.Path.TrimEnd('\\') + "\\" + Name; } }
    }
    internal sealed class Game
    {
        internal string Name, Path, Source, SteamAppId;
    }
    internal sealed class Frame
    {
        internal Entry Node;
        internal string Path;
    }
    internal sealed class Request
    {
        internal string Method, Path, Query, Body;
        internal Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }
    internal sealed class HttpError : Exception
    {
        internal int Code;
        internal HttpError(int code, string message) : base(message) { Code = code; }
    }

    internal static class Program
    {
        internal static readonly string[] Categories = { "Games", "Applications", "System", "Videos", "Images", "Audio", "Documents", "Archives", "Code", "Other" };
        static readonly object Gate = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 512 };
        static List<Entry> Roots = new List<Entry>();
        static Dictionary<string, Entry> Folders = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        static Dictionary<string, Game> Games = new Dictionary<string, Game>(StringComparer.OrdinalIgnoreCase);
        static HashSet<string> GameLibraries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static HashSet<string> InactiveGameLibraries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static Dictionary<string, long[]> Extensions = new Dictionary<string, long[]>(StringComparer.OrdinalIgnoreCase);
        static List<string> Warnings = new List<string>();
        static string State = "idle", ScanId = "", CurrentPath = "", StartedAt, FinishedAt;
        static long FilesCount, FoldersCount, BytesCount, ErrorsCount, Revision;
        static volatile bool Cancel;
        static string AppDirectory, Instance, Origin;
        static int Port;
        static Mutex InstanceMutex;
        static TcpListener Server;
        static bool NoBrowser;
        static string PortFile;
        static string GameLibrariesFile, SettingsWarning;
        static bool GameLibrariesDirty;

        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                AppDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(System.IO.Path.DirectorySeparatorChar);
                int requestedPort = 0;
                string portArgument = args.FirstOrDefault(a => a.StartsWith("--port=", StringComparison.Ordinal));
                if (portArgument != null && (!Int32.TryParse(portArgument.Substring(7), out requestedPort) || requestedPort < 1024 || requestedPort > 65535)) throw new Exception("Choose a test port between 1024 and 65535.");
                PortFile = System.IO.Path.Combine(AppDirectory, "backend", requestedPort == 0 ? "server.port" : "server-" + requestedPort + ".port");
                GameLibrariesFile = System.IO.Path.Combine(AppDirectory, requestedPort == 0 ? "game-libraries.json" : "game-libraries-" + requestedPort + ".json");
                using (SHA256 sha = SHA256.Create()) Instance = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(AppDirectory.ToLowerInvariant() + "|FileGazer|" + requestedPort))).Replace("-", "").Substring(0, 24);
                bool created;
                InstanceMutex = new Mutex(true, "Local\\StorageAtlas_" + Instance, out created);
                bool noBrowser = NoBrowser = args.Contains("--no-browser");
                if (!created)
                {
                    for (int retry = 0; retry < 20; retry++)
                    {
                        try
                        {
                            int existing = Int32.Parse(File.ReadAllText(PortFile), CultureInfo.InvariantCulture);
                            using (WebClient web = new WebClient())
                            {
                                string health = web.DownloadString("http://127.0.0.1:" + existing + "/api/health");
                                if (health.Contains(Instance)) { if (!noBrowser) OpenBrowser(existing); return 0; }
                            }
                        }
                        catch { }
                        Thread.Sleep(100);
                    }
                    Console.Error.WriteLine("File Gazer is already starting. Try opening it again in a moment.");
                    return 1;
                }
                LoadGameLibraries();
                TcpListener listener = null;
                if (requestedPort != 0) { listener = new TcpListener(IPAddress.Loopback, requestedPort); listener.Start(); Port = requestedPort; }
                for (int candidate = 47831; listener == null && candidate <= 47850; candidate++)
                {
                    try { listener = new TcpListener(IPAddress.Loopback, candidate); listener.Start(); Port = candidate; break; }
                    catch (SocketException) { listener = null; }
                }
                if (listener == null) { listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port; }
                Origin = "http://127.0.0.1:" + Port;
                Server = listener;
                Directory.CreateDirectory(System.IO.Path.Combine(AppDirectory, "backend"));
                File.WriteAllText(PortFile, Port.ToString(CultureInfo.InvariantCulture));
                Console.WriteLine("File Gazer is ready at " + Origin + ". Exit from the tray icon to stop it.");
                if (!noBrowser) { StartTray(); OpenBrowser(Port); }
                while (true)
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(delegate { Handle(client); });
                }
            }
            catch (Exception ex) { string error = "File Gazer could not start: " + ex.Message; Console.Error.WriteLine(error); if (!NoBrowser) MessageBox.Show(error, "File Gazer", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
        }

        static void StartTray()
        {
            Thread tray = new Thread(delegate()
            {
                Application.EnableVisualStyles();
                using (Icon trayIcon = LoadTrayIcon())
                using (NotifyIcon icon = new NotifyIcon { Text = "File Gazer", Icon = trayIcon, Visible = true })
                using (ContextMenuStrip menu = new ContextMenuStrip())
                {
                    menu.Items.Add("Open File Gazer", null, delegate { OpenBrowser(Port); });
                    menu.Items.Add("Exit", null, delegate { Cancel = true; icon.Visible = false; icon.Dispose(); menu.Dispose(); trayIcon.Dispose(); try { Server.Stop(); } catch { } Environment.Exit(0); });
                    icon.ContextMenuStrip = menu;
                    icon.DoubleClick += delegate { OpenBrowser(Port); };
                    icon.BalloonTipTitle = "File Gazer is ready";
                    icon.BalloonTipText = "Open the storage map or exit from this tray icon.";
                    icon.ShowBalloonTip(3000);
                    Application.Run();
                }
            }) { IsBackground = true, Name = "Storage Atlas tray" };
            tray.SetApartmentState(ApartmentState.STA); tray.Start();
        }
        static Icon LoadTrayIcon()
        {
            try
            {
                using (Stream stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("FileGazer.Icon"))
                {
                    if (stream != null) using (Icon embedded = new Icon(stream, new Size(32, 32))) return (Icon)embedded.Clone();
                }
            }
            catch { }
            try
            {
                using (Icon associated = Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location))
                {
                    if (associated != null) return (Icon)associated.Clone();
                }
            }
            catch { }
            return (Icon)SystemIcons.Application.Clone();
        }

        static void OpenBrowser(int port) { try { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/") { UseShellExecute = true }); } catch { } }
        static object SerializeStatus() { return new { id = ScanId, revision = Revision, state = State, files = FilesCount, folders = FoldersCount, bytes = BytesCount, currentPath = CurrentPath, errors = ErrorsCount, startedAt = StartedAt, finishedAt = FinishedAt }; }
        static string Serialize(object value) { lock (Json) return Json.Serialize(value); }
        static T Deserialize<T>(string value) { lock (Json) return Json.Deserialize<T>(value); }
        static string Normalize(string path)
        {
            bool driveAbsolute = path != null && path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/');
            bool uncAbsolute = path != null && path.StartsWith("\\\\", StringComparison.Ordinal);
            if (String.IsNullOrWhiteSpace(path) || (!driveAbsolute && !uncAbsolute) || path.IndexOf('\0') >= 0 || path.StartsWith("\\\\.\\", StringComparison.Ordinal) || path.StartsWith("\\\\?\\", StringComparison.Ordinal)) throw new HttpError(400, "Choose a normal absolute folder path, such as C:\\Games.");
            StringBuilder full = new StringBuilder(32768);
            uint length = Native.GetFullPathName(path, (uint)full.Capacity, full, IntPtr.Zero);
            if (length == 0 || length >= full.Capacity) throw new HttpError(400, "This path is invalid or too long.");
            string p = full.ToString();
            string root = p.StartsWith("\\\\", StringComparison.Ordinal) ? UncRoot(p) : p.Substring(0, 3);
            return p.Length > root.Length ? p.TrimEnd('\\', '/') : root;
        }
        static string UncRoot(string path)
        {
            int serverEnd = path.IndexOf('\\', 2);
            if (serverEnd < 3) throw new HttpError(400, "A network folder needs a server and share name.");
            int shareEnd = path.IndexOf('\\', serverEnd + 1);
            if (serverEnd + 1 >= path.Length) throw new HttpError(400, "A network folder needs a share name.");
            return shareEnd < 0 ? path + "\\" : path.Substring(0, shareEnd + 1);
        }
        static string ParentPath(string path)
        {
            int split = path.TrimEnd('\\').LastIndexOf('\\');
            if (split < 0) return null;
            return split == 2 && path[1] == ':' ? path.Substring(0, 3) : path.Substring(0, split);
        }
        static string BaseName(string path) { string trimmed = (path ?? "").TrimEnd('\\'); return trimmed.Substring(trimmed.LastIndexOf('\\') + 1); }
        static bool Within(string child, string parent) { return child.Equals(parent, StringComparison.OrdinalIgnoreCase) || child.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
        static string LongPath(string path) { return path.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + path.Substring(2) : "\\\\?\\" + path; }
        static string Extension(string name) { string ext = System.IO.Path.GetExtension(name).ToLowerInvariant(); return ext.Length == 0 ? "(none)" : ext; }
        static int CategoryIndex(string category)
        {
            if (String.IsNullOrEmpty(category) || category.Equals("all", StringComparison.OrdinalIgnoreCase)) return -1;
            for (int i = 0; i < Categories.Length; i++) if (Categories[i].Equals(category, StringComparison.OrdinalIgnoreCase)) return i;
            throw new HttpError(400, "Unknown category.");
        }
        static int Number(string value, int fallback, int min, int max) { int parsed; return Int32.TryParse(value, out parsed) ? Math.Max(min, Math.Min(max, parsed)) : fallback; }

        static Request ReadRequest(NetworkStream stream)
        {
            // Read bytes rather than a buffered text reader so the Content-Length body is exact.
            MemoryStream header = new MemoryStream();
            int last = 0, b;
            while ((b = stream.ReadByte()) >= 0)
            {
                header.WriteByte((byte)b);
                last = (last << 8) | b;
                if (last == 0x0d0a0d0a) break;
                if (header.Length > 32768) throw new HttpError(413, "Request headers are too large.");
            }
            if (header.Length == 0) return null;
            string[] lines = Encoding.ASCII.GetString(header.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
            string[] first = lines[0].Split(' ');
            if (first.Length != 3 || !first[1].StartsWith("/")) throw new HttpError(400, "Invalid HTTP request.");
            Request req = new Request { Method = first[0] };
            int query = first[1].IndexOf('?');
            req.Path = Uri.UnescapeDataString(query < 0 ? first[1] : first[1].Substring(0, query));
            req.Query = query < 0 ? "" : first[1].Substring(query + 1);
            foreach (string line in lines.Skip(1)) { int sep = line.IndexOf(':'); if (sep > 0) req.Headers[line.Substring(0, sep)] = line.Substring(sep + 1).Trim(); }
            string host;
            if (!req.Headers.TryGetValue("Host", out host) || !host.Equals("127.0.0.1:" + Port, StringComparison.OrdinalIgnoreCase)) throw new HttpError(403, "Only the local Storage Atlas address is allowed.");
            string source;
            if (req.Headers.TryGetValue("Origin", out source) && !source.Equals(Origin, StringComparison.OrdinalIgnoreCase)) throw new HttpError(403, "Requests from other websites are not allowed.");
            string fetchSite;
            if (req.Headers.TryGetValue("Sec-Fetch-Site", out fetchSite) && fetchSite.Equals("cross-site", StringComparison.OrdinalIgnoreCase)) throw new HttpError(403, "Requests from other websites are not allowed.");
            int length = 0; string rawLength;
            if (req.Headers.TryGetValue("Content-Length", out rawLength) && (!Int32.TryParse(rawLength, out length) || length < 0 || length > 1048576)) throw new HttpError(413, "Request body is too large.");
            if (req.Headers.ContainsKey("Transfer-Encoding")) throw new HttpError(400, "Chunked requests are not supported.");
            byte[] body = new byte[length]; int read = 0;
            while (read < length) { int n = stream.Read(body, read, length - read); if (n == 0) throw new HttpError(400, "Incomplete request body."); read += n; }
            req.Body = Encoding.UTF8.GetString(body);
            return req;
        }

        static void Handle(TcpClient client)
        {
            using (client)
            {
                client.ReceiveTimeout = 15000; client.SendTimeout = 30000;
                NetworkStream stream = client.GetStream();
                try
                {
                    Request req = ReadRequest(stream); if (req == null) return;
                    if (req.Method != "GET" && req.Method != "POST") throw new HttpError(405, "Use GET or POST.");
                    if (req.Path == "/api/export")
                    {
                        Require(req, "GET");
                        SendHeader(stream, 200, "application/json; charset=utf-8", null, "Content-Disposition: attachment; filename=file-gazer-inventory.json\r\n");
                        using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false), 65536, true)) { lock (Gate) WriteExport(writer); writer.Flush(); }
                        return;
                    }
                    if (req.Path.StartsWith("/api/", StringComparison.Ordinal))
                    {
                        object response = Api(req);
                        Send(stream, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(Serialize(response)));
                    }
                    else
                    {
                        Require(req, "GET");
                        string relative = req.Path == "/" ? "index.html" : req.Path.TrimStart('/').Replace('/', System.IO.Path.DirectorySeparatorChar);
                        string ui = System.IO.Path.GetFullPath(System.IO.Path.Combine(AppDirectory, "ui"));
                        string file = System.IO.Path.GetFullPath(System.IO.Path.Combine(ui, relative));
                        if (!Within(file, ui) || !File.Exists(file)) throw new HttpError(404, "File not found.");
                        string ext = System.IO.Path.GetExtension(file).ToLowerInvariant();
                        string mime = ext == ".html" ? "text/html; charset=utf-8" : ext == ".css" ? "text/css; charset=utf-8" : ext == ".js" ? "text/javascript; charset=utf-8" : ext == ".svg" ? "image/svg+xml" : ext == ".png" ? "image/png" : ext == ".ico" ? "image/x-icon" : "application/octet-stream";
                        Send(stream, 200, mime, File.ReadAllBytes(file));
                    }
                }
                catch (HttpError ex) { TrySendError(stream, ex.Code, ex.Message); }
                catch (Exception ex) { TrySendError(stream, 500, ex.Message); }
            }
        }
        static void Require(Request req, string method) { if (req.Method != method) throw new HttpError(405, "Use " + method + " for this action."); }
        static void TrySendError(NetworkStream stream, int code, string message) { try { Send(stream, code, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(Serialize(new { error = message }))); } catch { } }
        static void SendHeader(NetworkStream stream, int code, string mime, long? length, string extra)
        {
            string reason = code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : code == 405 ? "Method Not Allowed" : code == 409 ? "Conflict" : code == 413 ? "Payload Too Large" : "Internal Server Error";
            string header = "HTTP/1.1 " + code + " " + reason + "\r\nContent-Type: " + mime + "\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n" + (length.HasValue ? "Content-Length: " + length.Value + "\r\n" : "") + extra + "\r\n";
            byte[] bytes = Encoding.ASCII.GetBytes(header); stream.Write(bytes, 0, bytes.Length);
        }
        static void Send(NetworkStream stream, int code, string mime, byte[] body) { SendHeader(stream, code, mime, body.Length, ""); stream.Write(body, 0, body.Length); }

        static object Api(Request req)
        {
            var query = HttpUtility.ParseQueryString(req.Query);
            if (req.Path == "/api/health") { Require(req, "GET"); return new { app = "StorageAtlas", product = "File Gazer", instance = Instance, port = Port, version = "1.1" }; }
            if (req.Path == "/api/drives")
            {
                Require(req, "GET"); var drives = new List<object>();
                foreach (DriveInfo drive in DriveInfo.GetDrives())
                {
                    try { if (drive.IsReady) drives.Add(new { path = drive.RootDirectory.FullName, name = String.IsNullOrEmpty(drive.VolumeLabel) ? drive.Name.TrimEnd('\\') : drive.VolumeLabel, total = drive.TotalSize, free = drive.AvailableFreeSpace, type = drive.DriveType.ToString() }); } catch { }
                }
                return new { drives = drives };
            }
            if (req.Path == "/api/scan")
            {
                Require(req, "POST"); Dictionary<string, object> body;
                try { body = Deserialize<Dictionary<string, object>>(req.Body); } catch { throw new HttpError(400, "Provide a JSON object with paths."); }
                object raw;
                if (body == null || !body.TryGetValue("paths", out raw) || !(raw is System.Collections.IEnumerable) || raw is string) throw new HttpError(400, "Choose at least one folder or drive.");
                List<string> paths = new List<string>();
                foreach (object value in (System.Collections.IEnumerable)raw)
                {
                    if (!(value is string)) throw new HttpError(400, "Paths must be strings.");
                    string path = Normalize((string)value);
                    uint attr = Native.GetFileAttributes(LongPath(path));
                    if (attr == UInt32.MaxValue || (attr & Native.Directory) == 0) throw new HttpError(400, "Folder is unavailable: " + path);
                    if ((attr & Native.Reparse) != 0) throw new HttpError(400, "Choose the target folder rather than a shortcut or linked folder: " + path);
                    if (!paths.Any(p => Within(path, p))) { paths.RemoveAll(p => Within(p, path)); paths.Add(path); }
                }
                if (paths.Count == 0 || paths.Count > 64) throw new HttpError(400, "Choose between 1 and 64 folders or drives.");
                lock (Gate)
                {
                    if (State == "running") throw new HttpError(409, "A scan is running. Cancel it before starting another.");
                    Roots = new List<Entry>(); Folders = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase); Games = new Dictionary<string, Game>(StringComparer.OrdinalIgnoreCase); InactiveGameLibraries.Clear(); Extensions = new Dictionary<string, long[]>(StringComparer.OrdinalIgnoreCase); Warnings = new List<string>();
                    ScanId = Guid.NewGuid().ToString("N"); Revision = 0; State = "running"; Cancel = false; FilesCount = FoldersCount = BytesCount = ErrorsCount = 0; CurrentPath = ""; StartedAt = DateTime.UtcNow.ToString("o"); FinishedAt = null;
                    foreach (string path in paths) { Entry root = NewFolder(path, null, -1); Roots.Add(root); Folders[path] = root; FoldersCount++; }
                    Thread thread = new Thread(Scan) { IsBackground = true, Name = "Storage Atlas inventory" }; thread.Start();
                    return new { id = ScanId };
                }
            }
            if (req.Path == "/api/cancel") { Require(req, "POST"); Cancel = true; lock (Gate) return SerializeStatus(); }
            if (req.Path == "/api/game-library") return SetGameLibrary(req);
            if (req.Path == "/api/steam-library") return SteamLibrary(req);
            if (req.Path == "/api/open" || req.Path == "/api/properties" || req.Path == "/api/rename" || req.Path == "/api/recycle") return FileAction(req);
            if (req.Path == "/api/reveal")
            {
                Require(req, "POST"); Dictionary<string, string> body;
                try { body = Deserialize<Dictionary<string, string>>(req.Body); } catch { throw new HttpError(400, "Provide a scanned path."); }
                string path;
                if (body == null || !body.TryGetValue("path", out path)) throw new HttpError(400, "Provide a scanned path.");
                path = Normalize(path);
                lock (Gate) { if (FindEntry(path) == null) throw new HttpError(404, "Choose an item from this scan."); }
                if (path.IndexOf('"') >= 0) throw new HttpError(400, "Invalid path.");
                Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + path + "\"") { UseShellExecute = true });
                return new { opened = true };
            }
            Require(req, "GET");
            lock (Gate)
            {
                if (req.Path == "/api/status") return SerializeStatus();
                if (req.Path == "/api/overview") return Overview();
                int category = CategoryIndex(query["category"]);
                if (req.Path == "/api/node")
                {
                    string path = query["path"];
                    Entry node = String.IsNullOrEmpty(path) ? null : FindEntry(Normalize(path));
                    if (!String.IsNullOrEmpty(path) && node == null) throw new HttpError(404, "This item is not in the current scan.");
                    List<Entry> children = node == null ? Roots : node.Folder ? node.Children : new List<Entry>();
                    List<Entry> selected = children.Where(e => Included(e, category)).OrderByDescending(e => Size(e, category)).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase).ToList();
                    int offset = Number(query["offset"], 0, 0, Int32.MaxValue), limit = Number(query["limit"], 500, 1, 5000);
                    return new { path = node == null ? "" : node.Path, name = node == null ? "All scanned locations" : node.Name, kind = node == null || node.Folder ? "folder" : "file", size = node == null ? Roots.Sum(e => Size(e, category)) : Size(node, category), fileCount = node == null ? Roots.Sum(e => FileCount(e, category)) : FileCount(node, category), folderCount = node == null ? FoldersCount : node.Folders, parent = node == null || node.Parent == null ? "" : node.Parent.Path, category = node == null || node.Folder ? null : Categories[node.Category], extension = node == null || node.Folder ? null : Extension(node.Name), children = selected.Skip(offset).Take(limit).Select(e => Item(e, category)).ToArray(), totalChildren = selected.Count, childrenSizeTotal = selected.Sum(e => Size(e, category)), remainingSize = selected.Skip(offset).Sum(e => Size(e, category)), offset = offset, limit = limit, state = State, revision = Revision };
                }
                if (req.Path == "/api/search")
                {
                    string q = (query["q"] ?? "").Trim(), extension = query["extension"], scope = query["path"];
                    if (extension == "[no extension]" || extension == "none" || extension == "") extension = "(none)";
                    if (extension != null && extension != "(none)" && !extension.StartsWith(".")) extension = "." + extension;
                    if (!String.IsNullOrEmpty(scope)) scope = Normalize(scope);
                    int limit = Number(query["limit"], 100, 1, 5000), offset = Number(query["offset"], 0, 0, 1000000);
                    List<Entry> matches = new List<Entry>();
                    Stack<Entry> stack = new Stack<Entry>(Roots);
                    while (stack.Count > 0)
                    {
                        Entry e = stack.Pop();
                        if (e.Folder) foreach (Entry child in e.Children) stack.Push(child);
                        if (!Included(e, category)) continue;
                        if (extension != null && (e.Folder || !Extension(e.Name).Equals(extension, StringComparison.OrdinalIgnoreCase))) continue;
                        if (q.Length > 0 && e.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0 && e.Path.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        if (!String.IsNullOrEmpty(scope) && !Within(e.Path, scope)) continue;
                        matches.Add(e);
                    }
                    return new { items = matches.OrderByDescending(e => Size(e, category)).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase).Skip(offset).Take(limit).Select(e => Item(e, category)).ToArray(), total = matches.Count, offset = offset, limit = limit, state = State, revision = Revision };
                }
            }
            throw new HttpError(404, "Unknown API endpoint.");
        }
        static bool Included(Entry e, int category) { return category < 0 || (e.Folder ? e.CategoryFiles[category] > 0 : e.Category == category); }
        static long Size(Entry e, int category) { return category < 0 ? e.Size : e.Folder ? e.CategorySizes[category] : e.Category == category ? e.Size : 0; }
        static long FileCount(Entry e, int category) { return category < 0 ? e.Files : e.Folder ? e.CategoryFiles[category] : e.Category == category ? 1 : 0; }
        static object Item(Entry e, int category) { return new { path = e.Path, name = e.Name, kind = e.Folder ? "folder" : "file", size = Size(e, category), fileCount = FileCount(e, category), folderCount = e.Folders, category = e.Folder ? null : Categories[e.Category], extension = e.Folder ? null : Extension(e.Name), parent = e.Parent == null ? "" : e.Parent.Path }; }
        static Entry FindEntry(string path)
        {
            Entry e; if (Folders.TryGetValue(path, out e)) return e;
            string parent = ParentPath(path);
            string name = path.Substring(path.LastIndexOf('\\') + 1);
            if (parent != null && Folders.TryGetValue(parent, out e)) return e.Children.FirstOrDefault(n => !n.Folder && n.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
            return null;
        }
        static object CategorySummary() { return Enumerable.Range(0, Categories.Length).Select(i => new { name = Categories[i], size = Roots.Sum(r => r.CategorySizes[i]), files = Roots.Sum(r => r.CategoryFiles[i]) }).ToArray(); }
        static object ExtensionSummary() { return Extensions.OrderByDescending(e => e.Value[0]).ThenBy(e => e.Key).Select(e => new { name = e.Key, size = e.Value[0], files = e.Value[1] }).ToArray(); }
        static object GameSummary()
        {
            var games = new List<Dictionary<string, object>>();
            foreach (Game game in Games.Values)
            {
                Entry node;
                if (Folders.TryGetValue(game.Path, out node))
                {
                    if (node.Files > 0 || CustomLibraryForGame(game.Path) != null) games.Add(GameRow(game, game.Name, game.Path, node));
                }
                else
                {
                    // A selected subfolder must remain clickable even when its installation ancestor was not scanned.
                    List<Entry> partialRoots = Roots.Where(r => Within(r.Path, game.Path) && (r.Files > 0 || CustomLibraryForGame(game.Path) != null)).ToList();
                    foreach (Entry root in partialRoots) games.Add(GameRow(game, partialRoots.Count == 1 ? game.Name : game.Name + " / " + root.Name, root.Path, root));
                }
            }
            return games.OrderByDescending(g => (long)g["size"]).ToArray();
        }
        static Dictionary<string, object> GameRow(Game game, string name, string path, Entry node)
        {
            var row = new Dictionary<string, object> { { "name", name }, { "path", path }, { "installationPath", game.Path }, { "size", node.Size }, { "source", game.Source }, { "files", node.Files } };
            if (game.SteamAppId != null) row["steamAppId"] = game.SteamAppId;
            string library = CustomLibraryForGame(game.Path); if (library != null) row["libraryPath"] = library;
            return row;
        }
        static object Overview() { return new { roots = Roots.OrderByDescending(r => r.Size).Select(r => Item(r, -1)).ToArray(), size = BytesCount, files = FilesCount, folders = FoldersCount, categories = CategorySummary(), games = GameSummary(), gameLibraries = GameLibraries.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray(), inactiveGameLibraries = InactiveGameLibraries.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray(), extensions = ExtensionSummary(), warnings = SettingsWarning == null ? Warnings.ToArray() : Warnings.Concat(new[] { SettingsWarning }).ToArray(), warningCount = ErrorsCount + (SettingsWarning == null ? 0 : 1), state = State, id = ScanId, revision = Revision, sizeBasis = "logical file bytes", reparsePointsSkipped = true }; }

        static void LoadGameLibraries()
        {
            try
            {
                if (!File.Exists(GameLibrariesFile)) return;
                if (new FileInfo(GameLibrariesFile).Length > 1048576) throw new Exception("The settings file is too large.");
                Dictionary<string, object> settings = Deserialize<Dictionary<string, object>>(File.ReadAllText(GameLibrariesFile));
                object raw;
                if (settings == null || !settings.TryGetValue("paths", out raw) || !(raw is System.Collections.IEnumerable) || raw is string) throw new Exception("The settings file must contain a paths array.");
                var loaded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (object value in (System.Collections.IEnumerable)raw)
                {
                    if (!(value is string)) throw new Exception("Library paths must be strings.");
                    string path = Normalize((string)value);
                    if (loaded.Any(p => !p.Equals(path, StringComparison.OrdinalIgnoreCase) && (Within(path, p) || Within(p, path)))) throw new Exception("Nested game libraries are ambiguous.");
                    loaded.Add(path);
                    if (loaded.Count > 256) throw new Exception("Save at most 256 game libraries.");
                }
                GameLibraries = loaded;
            }
            catch (Exception ex) { SettingsWarning = "Saved game libraries could not be loaded: " + ex.Message; }
        }
        static void SaveGameLibraries(HashSet<string> paths)
        {
            string temporary = GameLibrariesFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, Serialize(new { version = 1, paths = paths.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray() }), new UTF8Encoding(false));
            if (File.Exists(GameLibrariesFile)) File.Replace(temporary, GameLibrariesFile, null);
            else File.Move(temporary, GameLibrariesFile);
            SettingsWarning = null; GameLibrariesDirty = false;
        }
        static void PersistGameLibraryChanges()
        {
            if (!GameLibrariesDirty) return;
            try { SaveGameLibraries(GameLibraries); }
            catch (Exception ex) { SettingsWarning = "The file action succeeded, but updated game library paths could not be saved. They remain active for this session: " + ex.Message; }
        }
        static List<string> DirectGamePaths(string library)
        {
            Entry folder;
            if (Folders.TryGetValue(library, out folder)) return folder.Children.Where(e => e.Folder).Select(e => e.Path).ToList();
            return Roots.Where(r => !r.Path.Equals(library, StringComparison.OrdinalIgnoreCase) && Within(r.Path, library)).Select(r => GameChildPath(r.Path, library)).Where(p => p != null).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }
        static string GameChildPath(string path, string library)
        {
            string prefix = library.TrimEnd('\\') + "\\";
            if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
            int end = path.IndexOf('\\', prefix.Length);
            return end < 0 ? path : path.Substring(0, end);
        }
        static string CustomLibraryForGame(string path)
        {
            return GameLibraries.FirstOrDefault(l => !InactiveGameLibraries.Contains(l) && String.Equals(path, GameChildPath(path, l), StringComparison.OrdinalIgnoreCase));
        }
        static string LibraryGameConflict(string library)
        {
            List<string> children = DirectGamePaths(library);
            foreach (Game game in Games.Values.Where(g => g.Source != "Custom game library"))
            {
                if (Within(library, game.Path)) return "This folder is already inside the recognized game '" + game.Name + "'. Choose a folder that contains games directly.";
                if (children.Any(p => !p.Equals(game.Path, StringComparison.OrdinalIgnoreCase) && (Within(p, game.Path) || Within(game.Path, p)))) return "A child folder overlaps the recognized game '" + game.Name + "' at " + game.Path + ". Choose the folder whose immediate children are the game installations.";
            }
            return null;
        }
        static void RefreshCustomGames(bool reportConflicts)
        {
            var previouslyInactive = new HashSet<string>(InactiveGameLibraries, StringComparer.OrdinalIgnoreCase);
            foreach (string path in Games.Keys.Where(p => Games[p].Source == "Custom game library").ToArray()) Games.Remove(path);
            InactiveGameLibraries.Clear();
            foreach (string library in GameLibraries)
            {
                string conflict = LibraryGameConflict(library);
                if (conflict != null)
                {
                    InactiveGameLibraries.Add(library);
                    if (reportConflicts) Warn("Custom game library is inactive: " + library + ". " + conflict);
                    continue;
                }
                foreach (string path in DirectGamePaths(library)) RegisterGame(path, BaseName(path), "Custom game library");
            }
            foreach (string library in previouslyInactive.Union(InactiveGameLibraries).Where(p => previouslyInactive.Contains(p) != InactiveGameLibraries.Contains(p))) ReclassifyLibrary(library);
        }
        static void ReclassifyLibrary(string library)
        {
            Entry folder;
            if (Folders.TryGetValue(library, out folder)) ReclassifySubtree(folder);
            else foreach (Entry root in Roots.Where(r => Within(r.Path, library))) ReclassifySubtree(root);
        }
        static object SetGameLibrary(Request req)
        {
            Dictionary<string, object> body = ActionBody(req); object raw;
            if (!body.TryGetValue("enabled", out raw) || !(raw is bool)) throw new HttpError(400, "Provide enabled as true or false.");
            bool enabled = (bool)raw;
            lock (Gate)
            {
                if (State == "running") throw new HttpError(409, "Wait for the scan to finish before marking game libraries.");
                Entry entry = GuardAction(Normalize(BodyString(body, "path")), false);
                if (!entry.Folder) throw new HttpError(400, "Choose a folder to mark as a game library.");
                string path = entry.Path;
                if (enabled == GameLibraries.Contains(path)) return new { path = path, enabled = enabled, revision = Revision, overview = Overview() };
                if (enabled)
                {
                    if (GameLibraries.Count >= 256) throw new HttpError(400, "Save at most 256 game libraries.");
                    if (GameLibraries.Any(p => Within(path, p) || Within(p, path))) throw new HttpError(409, "Nested game libraries would count the same games twice. Remove the overlapping library mark first.");
                    string conflict = LibraryGameConflict(path); if (conflict != null) throw new HttpError(409, conflict);
                }
                var proposed = new HashSet<string>(GameLibraries, StringComparer.OrdinalIgnoreCase);
                if (enabled) proposed.Add(path); else proposed.Remove(path);
                try { SaveGameLibraries(proposed); }
                catch (Exception ex) { throw new HttpError(400, "Game library settings could not be saved; the mark was not changed: " + ex.Message); }
                GameLibraries = proposed;
                RefreshCustomGames(false);
                ReclassifySubtree(entry);
                Revision++;
                return new { path = path, enabled = enabled, revision = Revision, overview = Overview() };
            }
        }

        static Dictionary<string, object> ActionBody(Request req)
        {
            Require(req, "POST");
            try { var body = Deserialize<Dictionary<string, object>>(req.Body); if (body != null) return body; } catch { }
            throw new HttpError(400, "Provide a JSON object with a scanned path.");
        }
        static string BodyString(Dictionary<string, object> body, string key)
        {
            object value; if (!body.TryGetValue(key, out value) || !(value is string)) throw new HttpError(400, "Provide " + key + " as a string.");
            return (string)value;
        }
        static Entry GuardAction(string path, bool mutation)
        {
            Entry entry = FindEntry(path);
            if (entry == null) throw new HttpError(404, "Choose an item from the current scan.");
            if (mutation && State == "running") throw new HttpError(409, "Wait for the scan to finish before changing files.");
            if (mutation && entry.Parent == null) throw new HttpError(403, "Drive and selected scan roots cannot be renamed or recycled.");
            // Do not follow a folder that was replaced by a junction since the snapshot.
            for (Entry check = entry; check != null; check = check.Parent)
            {
                uint attributes = Native.GetFileAttributes(LongPath(check.Path));
                if (attributes == UInt32.MaxValue) throw new HttpError(409, "This item changed or is unavailable. Scan again before acting on it.");
                if ((attributes & Native.Reparse) != 0) throw new HttpError(403, "Linked or reparse-point items cannot be changed or opened here.");
                if (((attributes & Native.Directory) != 0) != check.Folder) throw new HttpError(409, "This item changed since the scan. Scan again.");
            }
            return entry;
        }
        static object SteamLibrary(Request req)
        {
            Dictionary<string, object> body = ActionBody(req);
            if (body.Count != 1 || !body.ContainsKey("path")) throw new HttpError(400, "Provide only a scanned path. Steam addresses and application IDs are not accepted.");
            string path = Normalize(BodyString(body, "path")), appId;
            lock (Gate)
            {
                GuardAction(path, false);
                Game game = Games.Values.Where(g => g.Source == "Steam manifest" && g.SteamAppId != null && Within(path, g.Path)).OrderByDescending(g => g.Path.Length).FirstOrDefault();
                if (game == null) throw new HttpError(404, "This scanned item is not inside a recognized Steam game.");
                appId = CanonicalSteamAppId(game.SteamAppId);
                if (appId == null) throw new HttpError(400, "The Steam manifest does not contain a valid application ID.");
            }
            string address = "steam://nav/games/details/" + appId;
            try
            {
                RunSta(delegate
                {
#if !FILEGAZER_STEAM_TEST
                    Process.Start(new ProcessStartInfo(address) { UseShellExecute = true, Verb = "open" });
#endif
                    return true;
                });
            }
            catch (Exception ex) { throw new HttpError(400, "Windows could not open Steam: " + ex.Message); }
            return new { opened = true, steamAppId = appId };
        }
        static object FileAction(Request req)
        {
            Dictionary<string, object> body = ActionBody(req);
            lock (Gate)
            {
                if (req.Path == "/api/recycle") return Recycle(body);
                if (req.Path == "/api/rename" && State == "running") throw new HttpError(409, "Wait for the scan to finish before changing files.");
                string path = Normalize(BodyString(body, "path"));
                Entry entry = GuardAction(path, req.Path == "/api/rename");
                if (req.Path == "/api/open")
                {
                    if (entry.Folder) throw new HttpError(400, "Use Open in File Explorer for folders.");
                    string extension = Extension(entry.Name);
                    if ("|.exe|.com|.bat|.cmd|.ps1|.psm1|.psd1|.vbs|.vbe|.js|.jse|.wsf|.wsh|.msc|.scr|.pif|.cpl|.msi|.msp|.mst|.reg|.lnk|.url|.application|.appref-ms|.gadget|.hta|.inf|.jar|.py|.pyw|.sh|.bash|.zsh|.rb|.pl|.php|.dll|.sys|.ocx|.appx|.msix|.appxbundle|.msixbundle|.sct|.scf|".Contains("|" + extension + "|")) throw new HttpError(403, "Executable, script, installer, and shortcut files must be opened manually in File Explorer.");
                    try { RunSta(delegate { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true, Verb = "open", WorkingDirectory = ParentPath(path) }); return true; }); }
                    catch (Exception ex) { throw new HttpError(400, "Windows could not open this file: " + ex.Message); }
                    return new { opened = true };
                }
                if (req.Path == "/api/properties")
                {
                    try { RunSta(delegate { Native.ShowProperties(path); return true; }); }
                    catch (Exception ex) { throw new HttpError(400, "Windows could not show properties: " + ex.Message); }
                    return new { opened = true };
                }
                string name = BodyString(body, "name");
                ValidateName(name);
                string destination = entry.Parent.Path.TrimEnd('\\') + "\\" + name;
                if (destination.Equals(path, StringComparison.Ordinal)) return new { renamed = true, path = path, oldPath = path, revision = Revision, overview = Overview() };
                if (!destination.Equals(path, StringComparison.OrdinalIgnoreCase) && Native.GetFileAttributes(LongPath(destination)) != UInt32.MaxValue) throw new HttpError(409, "An item with that name already exists. Choose a different name.");
                if (!Native.MoveFile(LongPath(path), LongPath(destination))) throw new HttpError(400, "Windows could not rename this item: " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
                UpdateRename(entry, path, name);
                Revision++;
                return new { renamed = true, path = destination, oldPath = path, revision = Revision, persistenceWarning = SettingsWarning, overview = Overview() };
            }
        }
        static T RunSta<T>(Func<T> action)
        {
            T result = default(T); Exception error = null;
            Thread thread = new Thread(delegate() { try { result = action(); } catch (Exception ex) { error = ex; } }) { IsBackground = true };
            thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
            if (error != null) throw error; return result;
        }
        static void ValidateName(string name)
        {
            if (String.IsNullOrWhiteSpace(name) || name.Length > 255 || name == "." || name == ".." || name.EndsWith(".") || name.EndsWith(" ") || name.IndexOfAny(new[] { '<', '>', ':', '"', '/', '\\', '|', '?', '*' }) >= 0 || name.Any(c => c < 32)) throw new HttpError(400, "Use a single valid file or folder name, without separators or a trailing dot or space.");
            if (Regex.IsMatch(name, @"^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase)) throw new HttpError(400, "That name is reserved by Windows.");
        }
        static List<Entry> Subtree(Entry root)
        {
            var nodes = new List<Entry>(); var stack = new Stack<Entry>(); stack.Push(root);
            while (stack.Count > 0) { Entry node = stack.Pop(); nodes.Add(node); if (node.Folder) foreach (Entry child in node.Children) stack.Push(child); }
            return nodes;
        }
        static void ExtensionDelta(string extension, long size, long files)
        {
            long[] stats; if (!Extensions.TryGetValue(extension, out stats)) Extensions[extension] = stats = new long[2];
            stats[0] += size; stats[1] += files; if (stats[1] <= 0) Extensions.Remove(extension);
        }
        static void UpdateRename(Entry entry, string oldPath, string name)
        {
            if (!entry.Folder)
            {
                string oldExtension = Extension(entry.Name); int oldCategory = entry.Category;
                entry.Name = name; entry.Category = FileCategory(name, entry.Parent.Category);
                ExtensionDelta(oldExtension, -entry.Size, -1); ExtensionDelta(Extension(name), entry.Size, 1);
                if (oldCategory != entry.Category) for (Entry ancestor = entry.Parent; ancestor != null; ancestor = ancestor.Parent) { ancestor.CategorySizes[oldCategory] -= entry.Size; ancestor.CategoryFiles[oldCategory]--; ancestor.CategorySizes[entry.Category] += entry.Size; ancestor.CategoryFiles[entry.Category]++; }
                return;
            }
            List<Entry> nodes = Subtree(entry);
            foreach (Entry node in nodes) if (node.Folder) Folders.Remove(node.Path);
            List<Game> movedGames = Games.Values.Where(g => Within(g.Path, oldPath)).ToList();
            foreach (Game game in movedGames) Games.Remove(game.Path);
            entry.Name = name;
            foreach (Game game in movedGames) { game.Path = entry.Path + game.Path.Substring(oldPath.Length); if (game.Source == "Custom game library") game.Name = BaseName(game.Path); Games[game.Path] = game; }
            if (GameLibraries.Any(p => Within(p, oldPath)))
            {
                GameLibraries = new HashSet<string>(GameLibraries.Select(p => Within(p, oldPath) ? entry.Path + p.Substring(oldPath.Length) : p), StringComparer.OrdinalIgnoreCase);
                InactiveGameLibraries = new HashSet<string>(InactiveGameLibraries.Select(p => Within(p, oldPath) ? entry.Path + p.Substring(oldPath.Length) : p), StringComparer.OrdinalIgnoreCase);
                GameLibrariesDirty = true;
            }
            foreach (Entry node in nodes) if (node.Folder) Folders[node.Path] = node;
            RegisterFallbackGame(entry.Parent.Path, entry.Path, name);
            RefreshCustomGames(false);
            ReclassifySubtree(entry);
            PersistGameLibraryChanges();
        }
        static void ReclassifySubtree(Entry entry)
        {
            long[] oldSizes = (long[])entry.CategorySizes.Clone(), oldFiles = (long[])entry.CategoryFiles.Clone();
            List<Entry> nodes = Subtree(entry);
            // Rebuild only this subtree's category aggregates; byte sizes and file counts do not change.
            foreach (Entry node in nodes)
            {
                if (node.Folder) { node.Category = FolderCategory(node.Path, node.Parent == null ? -1 : node.Parent.Category); Array.Clear(node.CategorySizes, 0, Categories.Length); Array.Clear(node.CategoryFiles, 0, Categories.Length); }
                else node.Category = FileCategory(node.Name, node.Parent.Category);
            }
            for (int i = nodes.Count - 1; i >= 0; i--)
            {
                Entry node = nodes[i]; if (node == entry) continue;
                if (node.Folder) for (int cat = 0; cat < Categories.Length; cat++) { node.Parent.CategorySizes[cat] += node.CategorySizes[cat]; node.Parent.CategoryFiles[cat] += node.CategoryFiles[cat]; }
                else { node.Parent.CategorySizes[node.Category] += node.Size; node.Parent.CategoryFiles[node.Category]++; }
            }
            for (Entry ancestor = entry.Parent; ancestor != null; ancestor = ancestor.Parent) for (int cat = 0; cat < Categories.Length; cat++) { ancestor.CategorySizes[cat] += entry.CategorySizes[cat] - oldSizes[cat]; ancestor.CategoryFiles[cat] += entry.CategoryFiles[cat] - oldFiles[cat]; }
        }
        static object Recycle(Dictionary<string, object> body)
        {
            if (State == "running") throw new HttpError(409, "Wait for the scan to finish before changing files.");
            var requested = new List<string>(); object raw;
            if (body.TryGetValue("paths", out raw))
            {
                if (!(raw is System.Collections.IEnumerable) || raw is string) throw new HttpError(400, "Provide paths as an array.");
                foreach (object value in (System.Collections.IEnumerable)raw) { if (!(value is string)) throw new HttpError(400, "Paths must be strings."); requested.Add(Normalize((string)value)); }
            }
            else requested.Add(Normalize(BodyString(body, "path")));
            if (requested.Count < 1 || requested.Count > 200) throw new HttpError(400, "Select between 1 and 200 items.");
            // Validate the complete batch before any native operation, including entries later suppressed by an ancestor.
            var entries = new List<Entry>();
            foreach (string path in requested) { Entry entry = GuardAction(path, true); try { ShellRecycle.RequireSupportedLocation(path); } catch (Exception ex) { throw new HttpError(400, ex.Message); } if (!entries.Contains(entry)) entries.Add(entry); }
            entries = entries.Where(e => !entries.Any(parent => parent != e && parent.Folder && Within(e.Path, parent.Path))).ToList();
            var results = new List<object>(); var recycled = new List<string>(); var errors = new List<object>();
            foreach (Entry entry in entries)
            {
                string path = entry.Path;
                string failure = null;
                try { RunSta(delegate { ShellRecycle.RecycleOnly(path); return true; }); }
                catch (Exception ex) { failure = ex.Message; }
                if (failure == null)
                {
                    RemoveInventory(entry); recycled.Add(path); results.Add(new { path = path, success = true, error = (string)null });
                }
                else { errors.Add(new { path = path, error = failure }); results.Add(new { path = path, success = false, error = failure }); }
            }
            if (recycled.Count > 0) { RefreshCustomGames(false); PersistGameLibraryChanges(); Revision++; }
            return new { results = results, recycled = recycled, errors = errors, revision = Revision, persistenceWarning = SettingsWarning, overview = Overview() };
        }
        static void RemoveInventory(Entry entry)
        {
            List<Entry> nodes = Subtree(entry);
            foreach (Entry node in nodes) { if (node.Folder) Folders.Remove(node.Path); else ExtensionDelta(Extension(node.Name), -node.Size, -1); }
            string path = entry.Path; foreach (string game in Games.Keys.Where(p => Within(p, path)).ToArray()) Games.Remove(game);
            if (GameLibraries.RemoveWhere(p => Within(p, path)) > 0) { InactiveGameLibraries.RemoveWhere(p => Within(p, path)); GameLibrariesDirty = true; }
            long folders = entry.Folder ? entry.Folders + 1 : 0;
            for (Entry ancestor = entry.Parent; ancestor != null; ancestor = ancestor.Parent)
            {
                ancestor.Size -= entry.Size; ancestor.Files -= entry.Files; ancestor.Folders -= folders;
                for (int cat = 0; cat < Categories.Length; cat++) { ancestor.CategorySizes[cat] -= entry.Folder ? entry.CategorySizes[cat] : entry.Category == cat ? entry.Size : 0; ancestor.CategoryFiles[cat] -= entry.Folder ? entry.CategoryFiles[cat] : entry.Category == cat ? 1 : 0; }
            }
            entry.Parent.Children.Remove(entry); BytesCount -= entry.Size; FilesCount -= entry.Files; FoldersCount -= folders;
        }

        static Entry NewFolder(string path, Entry parent, int inherited)
        {
            string trimmed = path.TrimEnd('\\');
            string name = trimmed.Substring(trimmed.LastIndexOf('\\') + 1);
            if (String.IsNullOrEmpty(name) || name.EndsWith(":")) name = path.TrimEnd('\\');
            return new Entry { Name = name, RootPath = parent == null ? path : null, Parent = parent, Folder = true, Children = new List<Entry>(), CategorySizes = new long[Categories.Length], CategoryFiles = new long[Categories.Length], Category = FolderCategory(path, inherited) };
        }
        static int FolderCategory(string path, int inherited)
        {
            if (inherited == 0 || Games.Keys.Any(p => Within(path, p))) return 0;
            if (inherited == 1 || inherited == 2) return inherited;
            string lower = path.ToLowerInvariant();
            string[] segments = lower.Split('\\');
            if (segments.Any(s => s == "windows" || s == "system volume information" || s == "$recycle.bin" || s == "recovery" || s == "$windows.~bt" || s == "$windows.~ws")) return 2;
            if (segments.Any(s => s == "program files" || s == "program files (x86)" || s == "windowsapps")) return 1;
            return -1;
        }
        static int FileCategory(string name, int inherited)
        {
            if (inherited >= 0) return inherited;
            string lower = name.ToLowerInvariant();
            if (lower == "pagefile.sys" || lower == "hiberfil.sys" || lower == "swapfile.sys") return 2;
            string ext = Extension(name);
            if ("|.mp4|.mkv|.avi|.mov|.webm|.wmv|.m4v|.mpeg|.mpg|.flv|.mts|.m2ts|".Contains("|" + ext + "|")) return 3;
            if ("|.png|.jpg|.jpeg|.gif|.webp|.bmp|.tif|.tiff|.svg|.ico|.heic|.heif|.avif|.raw|.cr2|.nef|.psd|.ai|".Contains("|" + ext + "|")) return 4;
            if ("|.mp3|.wav|.flac|.aac|.ogg|.m4a|.wma|.aiff|.opus|.mid|.midi|".Contains("|" + ext + "|")) return 5;
            if ("|.pdf|.doc|.docx|.xls|.xlsx|.ppt|.pptx|.txt|.rtf|.odt|.ods|.odp|.epub|.csv|.md|".Contains("|" + ext + "|")) return 6;
            if ("|.zip|.7z|.rar|.tar|.gz|.bz2|.xz|.iso|.cab|.zst|.tgz|".Contains("|" + ext + "|")) return 7;
            if ("|.cs|.js|.jsx|.ts|.tsx|.py|.java|.c|.cpp|.h|.hpp|.go|.rs|.rb|.php|.html|.htm|.css|.scss|.json|.yaml|.yml|.xml|.sql|.sh|.ps1|.bat|.cmd|.toml|.ini|.ipynb|".Contains("|" + ext + "|")) return 8;
            if ("|.exe|.dll|.msi|.msix|.appx|.com|.msp|".Contains("|" + ext + "|")) return 1;
            return 9;
        }
        static void Warn(string text) { lock (Gate) { ErrorsCount++; if (Warnings.Count < 100) Warnings.Add(text); } }
        static void Scan()
        {
            try
            {
                DiscoverInstalledGames();
                Stack<Frame> stack = new Stack<Frame>();
                lock (Gate) foreach (Entry root in Roots) { InferGameRoot(root.Path); root.Category = FolderCategory(root.Path, -1); stack.Push(new Frame { Node = root, Path = root.Path }); }
                while (stack.Count > 0 && !Cancel)
                {
                    Frame frame = stack.Pop();
                    lock (Gate) CurrentPath = frame.Path;
                    if (frame.Node.Name.Equals("steamapps", StringComparison.OrdinalIgnoreCase)) DiscoverSteam(frame.Path);
                    Native.FindData data;
                    IntPtr handle = Native.FindFirstFile(LongPath(frame.Path.TrimEnd('\\') + "\\*"), out data);
                    if (handle == Native.Invalid)
                    {
                        int error = Marshal.GetLastWin32Error(); if (error != 2 && error != 18) Warn("Could not read " + frame.Path + " (Windows error " + error + ").");
                        continue;
                    }
                    try
                    {
                        bool more = true;
                        while (more && !Cancel)
                        {
                            if (data.Name != "." && data.Name != "..")
                            {
                                string path = System.IO.Path.Combine(frame.Path, data.Name);
                                if ((data.Attributes & Native.Reparse) != 0) Warn("Skipped linked or reparse-point item: " + path);
                                else if ((data.Attributes & Native.Directory) != 0)
                                {
                                    lock (Gate)
                                    {
                                        RegisterFallbackGame(frame.Path, path, data.Name);
                                        Entry directory = NewFolder(path, frame.Node, frame.Node.Category);
                                        frame.Node.Children.Add(directory); Folders[path] = directory; FoldersCount++;
                                        for (Entry ancestor = frame.Node; ancestor != null; ancestor = ancestor.Parent) ancestor.Folders++;
                                        stack.Push(new Frame { Node = directory, Path = path });
                                    }
                                }
                                else
                                {
                                    long size = ((long)data.SizeHigh << 32) + data.SizeLow;
                                    int category = FileCategory(data.Name, frame.Node.Category);
                                    lock (Gate)
                                    {
                                        frame.Node.Children.Add(new Entry { Name = data.Name, Parent = frame.Node, Size = size, Files = 1, Folder = false, Category = category });
                                        FilesCount++; BytesCount += size;
                                        for (Entry ancestor = frame.Node; ancestor != null; ancestor = ancestor.Parent) { ancestor.Size += size; ancestor.Files++; ancestor.CategorySizes[category] += size; ancestor.CategoryFiles[category]++; }
                                        string ext = Extension(data.Name); long[] stats; if (!Extensions.TryGetValue(ext, out stats)) Extensions[ext] = stats = new long[2]; stats[0] += size; stats[1]++;
                                    }
                                }
                            }
                            more = Native.FindNextFile(handle, out data);
                        }
                        if (!Cancel) { int error = Marshal.GetLastWin32Error(); if (!more && error != 18 && error != 0) Warn("Enumeration ended early in " + frame.Path + " (Windows error " + error + ")."); }
                    }
                    finally { Native.FindClose(handle); }
                }
                lock (Gate)
                {
                    RefreshCustomGames(true);
                    State = Cancel ? "cancelled" : "complete"; FinishedAt = DateTime.UtcNow.ToString("o"); CurrentPath = "";
                }
            }
            catch (Exception ex) { Warn("Scan stopped: " + ex.Message); lock (Gate) { State = "error"; FinishedAt = DateTime.UtcNow.ToString("o"); } }
        }

        static void RegisterGame(string path, string name, string source, string steamAppId = null)
        {
            try { path = Normalize(path); lock (Gate) { Game existing; if (!Games.TryGetValue(path, out existing) || existing.Source == "Custom game library" || (existing.Source == "Known game folder" && source != "Custom game library")) Games[path] = new Game { Path = path, Name = name, Source = source, SteamAppId = source == "Steam manifest" ? CanonicalSteamAppId(steamAppId) : null }; } } catch { }
        }
        static string CanonicalSteamAppId(string value)
        {
            uint id;
            return value != null && Regex.IsMatch(value, "^[0-9]{1,10}$") && UInt32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id > 0 ? id.ToString(CultureInfo.InvariantCulture) : null;
        }
        static void InferGameRoot(string path)
        {
            foreach (string library in GameLibraries)
            {
                string game = GameChildPath(path, library);
                if (game != null && !InactiveGameLibraries.Contains(library)) RegisterGame(game, BaseName(game), "Custom game library");
            }
            foreach (string marker in new[] { "\\steamapps\\common\\", "\\XboxGames\\", "\\GOG Games\\", "\\Epic Games\\" })
            {
                int index = path.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                if (index < 0) continue;
                if (marker == "\\steamapps\\common\\") DiscoverSteam(path.Substring(0, index) + "\\steamapps");
                int nameStart = index + marker.Length, end = path.IndexOf('\\', nameStart);
                string name = end < 0 ? path.Substring(nameStart) : path.Substring(nameStart, end - nameStart);
                if (name.Length > 0 && !(marker == "\\Epic Games\\" && name.Equals("Launcher", StringComparison.OrdinalIgnoreCase))) RegisterGame(end < 0 ? path : path.Substring(0, end), name, "Known game folder");
            }
        }
        static void RegisterFallbackGame(string parentPath, string path, string name)
        {
            if (GameLibraries.Contains(parentPath) && !InactiveGameLibraries.Contains(parentPath)) RegisterGame(path, name, "Custom game library");
            string parent = BaseName(parentPath);
            string grandparent = BaseName(ParentPath(parentPath));
            if ((parent.Equals("common", StringComparison.OrdinalIgnoreCase) && grandparent.Equals("steamapps", StringComparison.OrdinalIgnoreCase)) || parent.Equals("XboxGames", StringComparison.OrdinalIgnoreCase) || parent.Equals("GOG Games", StringComparison.OrdinalIgnoreCase) || (parent.Equals("Epic Games", StringComparison.OrdinalIgnoreCase) && !name.Equals("Launcher", StringComparison.OrdinalIgnoreCase))) RegisterGame(path, name, "Known game folder");
        }
        static string ReadMetadata(string path)
        {
            FileInfo file = new FileInfo(path); if (!file.Exists || file.Length > 1048576) return null;
            return File.ReadAllText(path);
        }
        static string VdfValue(string text, string key)
        {
            Match match = Regex.Match(text, "\\\"" + Regex.Escape(key) + "\\\"\\s*\\\"((?:\\\\.|[^\\\"])*)\\\"", RegexOptions.IgnoreCase);
            return match.Success ? match.Groups[1].Value.Replace("\\\\", "\\").Replace("\\\"", "\"") : null;
        }
        static void DiscoverSteam(string steamapps)
        {
            try
            {
                foreach (string manifest in Directory.EnumerateFiles(steamapps, "appmanifest_*.acf"))
                {
                    if (Cancel) break;
                    try
                    {
                        string text = ReadMetadata(manifest); if (text == null) continue;
                        string name = VdfValue(text, "name"), directory = VdfValue(text, "installdir"), appId = CanonicalSteamAppId(VdfValue(text, "appid"));
                        Match fileId = Regex.Match(System.IO.Path.GetFileName(manifest), "^appmanifest_([0-9]+)\\.acf$", RegexOptions.IgnoreCase);
                        if (!fileId.Success || appId != CanonicalSteamAppId(fileId.Groups[1].Value)) appId = null;
                        if (!String.IsNullOrEmpty(directory) && !String.IsNullOrEmpty(name))
                        {
                            string path = Normalize(System.IO.Path.Combine(steamapps, "common", directory));
                            if (Within(path, System.IO.Path.Combine(steamapps, "common"))) RegisterGame(path, name, "Steam manifest", appId);
                        }
                    }
                    catch { }
                }
            }
            catch { }
        }
        static void DiscoverInstalledGames()
        {
            HashSet<string> steamapps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in new[] { "HKEY_CURRENT_USER\\Software\\Valve\\Steam", "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "HKEY_LOCAL_MACHINE\\SOFTWARE\\Valve\\Steam" })
            {
                try { string root = (Registry.GetValue(key, "SteamPath", null) ?? Registry.GetValue(key, "InstallPath", null)) as string; if (!String.IsNullOrEmpty(root)) steamapps.Add(System.IO.Path.Combine(root.Replace('/', '\\'), "steamapps")); } catch { }
            }
            foreach (DriveInfo drive in DriveInfo.GetDrives())
            {
                if (Cancel) return;
                try { if (drive.IsReady) foreach (string location in new[] { "Program Files (x86)\\Steam\\steamapps", "Program Files\\Steam\\steamapps", "SteamLibrary\\steamapps", "Steam\\steamapps" }) { string path = System.IO.Path.Combine(drive.RootDirectory.FullName, location); if (Directory.Exists(path)) steamapps.Add(path); } } catch { }
            }
            foreach (string path in steamapps.ToArray())
            {
                try { string text = ReadMetadata(System.IO.Path.Combine(path, "libraryfolders.vdf")); if (text != null) foreach (Match match in Regex.Matches(text, "\\\"path\\\"\\s*\\\"((?:\\\\.|[^\\\"])*)\\\"", RegexOptions.IgnoreCase)) steamapps.Add(System.IO.Path.Combine(match.Groups[1].Value.Replace("\\\\", "\\"), "steamapps")); } catch { }
            }
            foreach (string path in steamapps) { if (Cancel) return; DiscoverSteam(path); }
            try
            {
                string manifestRoot = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Epic\\EpicGamesLauncher\\Data\\Manifests");
                if (Directory.Exists(manifestRoot)) foreach (string path in Directory.EnumerateFiles(manifestRoot, "*.item"))
                {
                    if (Cancel) return;
                    try { string text = ReadMetadata(path); if (text == null) continue; Dictionary<string, object> manifest = Deserialize<Dictionary<string, object>>(text); object name, location; if (manifest.TryGetValue("DisplayName", out name) && manifest.TryGetValue("InstallLocation", out location) && location is string && name is string) RegisterGame((string)location, (string)name, "Epic manifest"); } catch { }
                }
            }
            catch { }
        }

        static void WriteExport(StreamWriter writer)
        {
            writer.Write("{\"schemaVersion\":1,\"sizeBasis\":\"logical file bytes\",\"scan\":"); writer.Write(Serialize(SerializeStatus()));
            writer.Write(",\"categories\":"); writer.Write(Serialize(CategorySummary())); writer.Write(",\"games\":"); writer.Write(Serialize(GameSummary())); writer.Write(",\"gameLibraries\":"); writer.Write(Serialize(GameLibraries.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray())); writer.Write(",\"inactiveGameLibraries\":"); writer.Write(Serialize(InactiveGameLibraries.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray())); writer.Write(",\"extensions\":"); writer.Write(Serialize(ExtensionSummary())); writer.Write(",\"warnings\":"); writer.Write(Serialize(SettingsWarning == null ? Warnings.ToArray() : Warnings.Concat(new[] { SettingsWarning }).ToArray())); writer.Write(",\"roots\":[");
            for (int i = 0; i < Roots.Count; i++) { if (i > 0) writer.Write(','); WriteExportNode(writer, Roots[i]); }
            writer.Write("]}");
        }
        static void WriteExportNode(StreamWriter writer, Entry root)
        {
            // Explicit traversal avoids recursion limits for unusually deep folder trees.
            Stack<KeyValuePair<Entry, int>> stack = new Stack<KeyValuePair<Entry, int>>();
            WriteExportEntry(writer, root); if (!root.Folder) return;
            stack.Push(new KeyValuePair<Entry, int>(root, 0));
            while (stack.Count > 0)
            {
                var frame = stack.Pop();
                if (frame.Value >= frame.Key.Children.Count) { writer.Write("]}"); continue; }
                if (frame.Value > 0) writer.Write(',');
                Entry child = frame.Key.Children[frame.Value];
                stack.Push(new KeyValuePair<Entry, int>(frame.Key, frame.Value + 1));
                WriteExportEntry(writer, child);
                if (child.Folder) stack.Push(new KeyValuePair<Entry, int>(child, 0));
            }
        }
        static void WriteExportEntry(StreamWriter writer, Entry entry)
        {
            string metadata = Serialize(Item(entry, -1));
            if (entry.Folder) { writer.Write(metadata.Substring(0, metadata.Length - 1)); writer.Write(",\"children\":["); }
            else writer.Write(metadata);
        }
    }

    internal static class Native
    {
        internal const uint Directory = 0x10, Reparse = 0x400;
        internal static readonly IntPtr Invalid = new IntPtr(-1);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct FindData
        {
            internal uint Attributes;
            internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
            internal uint SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] internal string AlternateName;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "FindFirstFileW")] internal static extern IntPtr FindFirstFile(string file, out FindData data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "FindNextFileW")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FindNextFile(IntPtr handle, out FindData data);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FindClose(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetFileAttributesW")] internal static extern uint GetFileAttributes(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetFullPathNameW")] internal static extern uint GetFullPathName(string path, uint bufferLength, StringBuilder buffer, IntPtr filePart);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "MoveFileW")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool MoveFile(string existing, string destination);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct ShellExecuteInfo
        {
            internal int Size; internal uint Mask; internal IntPtr Window;
            [MarshalAs(UnmanagedType.LPWStr)] internal string Verb;
            [MarshalAs(UnmanagedType.LPWStr)] internal string File;
            [MarshalAs(UnmanagedType.LPWStr)] internal string Parameters;
            [MarshalAs(UnmanagedType.LPWStr)] internal string Directory;
            internal int Show; internal IntPtr Instance, IdList;
            [MarshalAs(UnmanagedType.LPWStr)] internal string Class;
            internal IntPtr ClassKey; internal uint HotKey; internal IntPtr Icon, Process;
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ShellExecuteExW")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool ShellExecuteEx(ref ShellExecuteInfo info);
        internal static void ShowProperties(string path)
        {
            ShellExecuteInfo info = new ShellExecuteInfo { Size = Marshal.SizeOf(typeof(ShellExecuteInfo)), Mask = 0x0000000c | 0x00000100, Verb = "properties", File = path, Show = 1 };
            if (!ShellExecuteEx(ref info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    // Native Shell declarations follow the Windows SDK IFileOperation vtable order.
    // No SHFileOperation/File.Delete fallback is permitted: recycle support is required.
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        [PreserveSig] int GetParent(out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint displayName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IShellItem other, uint hint, out int order);
    }
    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOperation
    {
        [PreserveSig] int Advise(IFileOperationProgressSink sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog(IntPtr dialog);
        [PreserveSig] int SetProperties(IntPtr properties);
        [PreserveSig] int SetOwnerWindow(uint window);
        [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
        [PreserveSig] int ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
        [PreserveSig] int RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
        [PreserveSig] int MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destination);
        [PreserveSig] int CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
        [PreserveSig] int CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destination);
        [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
        [PreserveSig] int DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        [PreserveSig] int NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IFileOperationProgressSink sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }
    [ComVisible(true), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOperationProgressSink
    {
        [PreserveSig] int StartOperations();
        [PreserveSig] int FinishOperations(int result);
        [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem newItem);
        [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem newItem);
        [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem newItem);
        [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
        [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem newItem);
        [PreserveSig] int PreNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attributes, int result, IShellItem newItem);
        [PreserveSig] int UpdateProgress(uint total, uint completed);
        [PreserveSig] int ResetTimer();
        [PreserveSig] int PauseTimer();
        [PreserveSig] int ResumeTimer();
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    internal sealed class RecycleSink : IFileOperationProgressSink
    {
        internal bool Confirmed, Vetoed; internal int Result = unchecked((int)0x80004004);
        public int StartOperations() { return 0; }
        public int FinishOperations(int result) { return 0; }
        public int PreRenameItem(uint flags, IShellItem item, string name) { return 0; }
        public int PostRenameItem(uint flags, IShellItem item, string name, int result, IShellItem newItem) { return 0; }
        public int PreMoveItem(uint flags, IShellItem item, IShellItem destination, string name) { return 0; }
        public int PostMoveItem(uint flags, IShellItem item, IShellItem destination, string name, int result, IShellItem newItem) { return 0; }
        public int PreCopyItem(uint flags, IShellItem item, IShellItem destination, string name) { return 0; }
        public int PostCopyItem(uint flags, IShellItem item, IShellItem destination, string name, int result, IShellItem newItem) { return 0; }
        public int PreDeleteItem(uint flags, IShellItem item)
        {
            if ((flags & 0x80) == 0) { Vetoed = true; return unchecked((int)0x80004004); }
            return 0;
        }
        public int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem newItem)
        {
            Result = result; Confirmed = result >= 0 && newItem != null;
            return Confirmed ? 0 : unchecked((int)0x80004004);
        }
        public int PreNewItem(uint flags, IShellItem destination, string name) { return 0; }
        public int PostNewItem(uint flags, IShellItem destination, string name, string template, uint attributes, int result, IShellItem newItem) { return 0; }
        public int UpdateProgress(uint total, uint completed) { return 0; }
        public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; }
        public int ResumeTimer() { return 0; }
    }
    internal static class ShellRecycle
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)] static extern int SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context, ref Guid iid, out IShellItem item);
        static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
        internal static void RequireSupportedLocation(string path)
        {
            if (Environment.OSVersion.Version < new Version(6, 2)) throw new Exception("Recycle-only actions require Windows 8 or newer.");
            if (path.StartsWith("\\\\", StringComparison.Ordinal) || new DriveInfo(path.Substring(0, 3)).DriveType != DriveType.Fixed) throw new Exception("Recycle-only actions are available on local fixed drives with a Recycle Bin.");
        }
        internal static void RecycleOnly(string path)
        {
            RequireSupportedLocation(path);
            IFileOperation operation = null; IShellItem item = null;
            try
            {
                operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
                // Recycle, stop on errors, no elevation/error UI, no connected companion deletion.
                Check(operation.SetOperationFlags(0x00080000 | 0x00100000 | 0x20000000 | 0x00000400 | 0x00000004 | 0x00000010 | 0x00002000));
                Guid shellItem = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                Check(SHCreateItemFromParsingName(path, IntPtr.Zero, ref shellItem, out item));
                RecycleSink sink = new RecycleSink(); Check(operation.DeleteItem(item, sink));
                int result = operation.PerformOperations(); bool aborted; Check(operation.GetAnyOperationsAborted(out aborted));
                if (sink.Vetoed) throw new Exception("Windows could not guarantee a Recycle Bin destination; the action was cancelled.");
                if (!sink.Confirmed) { if (result < 0) Check(result); if (sink.Result < 0) Check(sink.Result); throw new Exception("Windows did not confirm that this item reached the Recycle Bin."); }
            }
            finally { if (item != null) Marshal.FinalReleaseComObject(item); if (operation != null) Marshal.FinalReleaseComObject(operation); }
        }
    }
}
