using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using StorageAtlas;

// Owned fixture-only checks: Program.Main, TCP serving and native Shell operations are never invoked.
internal static class ArtworkChecks
{
    static readonly List<string> Checks = new List<string>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly BindingFlags Flags = BindingFlags.Static | BindingFlags.NonPublic;
    static string Root, Inventory, GamePath, CacheRoot;
    static int Main(string[] args)
    {
        try
        {
            Root=args[0]; Inventory=Path.Combine(Root,"inventory");
            string steam=Path.Combine(Inventory,"Steam"), apps=Path.Combine(steam,"steamapps"), common=Path.Combine(apps,"common");
            GamePath=Path.Combine(common,"Valid"); CacheRoot=Path.Combine(steam,"appcache","librarycache");
            Write(Path.Combine(GamePath,"game.bin"),new byte[17]); Write(Path.Combine(GamePath,"assets","notes.txt"),new byte[11]);
            Write(Path.Combine(common,"Unknown","orphan.txt"),new byte[19]); Write(Path.Combine(common,"Mismatch","data.bin"),new byte[23]);
            Write(Path.Combine(Inventory,"Other","readme.txt"),new byte[29]); Write(Path.Combine(Inventory,"Manual","Unmatched Title","data.bin"),new byte[31]);
            Directory.CreateDirectory(Path.Combine(Inventory,"Manual","Empty Game"));
            Write(Path.Combine(apps,"appmanifest_12345.acf"),Encoding.UTF8.GetBytes("\"AppState\" { \"appid\" \"12345\" \"name\" \"Fixture Artwork\" \"installdir\" \"Valid\" }"));
            Write(Path.Combine(apps,"appmanifest_9999.acf"),Encoding.UTF8.GetBytes("\"AppState\" { \"appid\" \"8888\" \"name\" \"Mismatched identity\" \"installdir\" \"Mismatch\" }"));
            byte[] png=ImageBytes(12,8,ImageFormat.Png), jpeg=ImageBytes(12,8,ImageFormat.Jpeg);
            Write(Path.Combine(CacheRoot,"12345","library_hero.jpg"),jpeg);
            Write(Path.Combine(CacheRoot,"12345_library_600x900.png"),png);
            Set("AppDirectory",Root); Set("GameLibrariesFile",Path.Combine(Root,"game-libraries-test.json"));
            Scan(Inventory);
            var overview=Overview(); string baseline=Stats(overview); long bytes=Convert.ToInt64(overview["size"]);
            string[] physical=Directory.GetFiles(Inventory,"*",SearchOption.AllDirectories).OrderBy(p=>p).ToArray();
            var games=Rows(overview["games"]); var valid=games.Single(g=>(string)g["name"]=="Fixture Artwork"); var artwork=(Dictionary<string,object>)valid["artwork"];
            Assert(Convert.ToInt64(valid["files"])==2 && Convert.ToInt64(valid["fileCount"])==2 && Convert.ToInt64(valid["folderCount"])==1, "Complete Steam game rows retain legacy files and expose exact descendant file/folder count aliases");
            Assert(games.All(g=>Convert.ToInt64(g["files"])==Convert.ToInt64(g["fileCount"])), "All initial game sources expose the compatible fileCount alias");
            Assert((string)artwork["source"]=="Steam library" && (string)artwork["steamAppId"]=="12345", "Game artwork identity comes only from validated Steam manifest metadata");
            string hero=(string)artwork["url"], capsule=(string)artwork["fallbackUrl"];
            Assert(hero.StartsWith("/api/game-artwork?path=") && hero.EndsWith("&kind=hero") && capsule.EndsWith("&kind=capsule") && hero.Contains("&scan="+(string)Get("ScanId")), "Metadata uses exact scanned-path same-origin URLs and a current scan token");
            Assert(games.Where(g=>(string)g["name"]!="Fixture Artwork").All(g=>!g.ContainsKey("artwork")), "Known-layout and mismatched-ID games receive no guessed artwork");
            var parent=Api("/api/node?path="+HttpUtility.UrlEncode(common),null); var folder=Rows(parent["children"]).Single(g=>(string)g["name"]=="Valid");
            Assert(folder.ContainsKey("artwork"), "Exact Steam installation folder is annotated in normal folder rows");
            var node=Api("/api/node?path="+HttpUtility.UrlEncode(GamePath),null);
            Assert(node["artwork"]!=null && Rows(node["children"]).All(g=>!g.ContainsKey("artwork")), "Game node has artwork while internal folders and files keep category colors");
            Assert(((Dictionary<string,ArtworkEntry>)Get("ArtworkCache")).Count==0, "Overview/node metadata performs no eager image I/O or caching");
            // Constrain even local-cache lookup to this owned fixture for every binary-read check.
            ((HashSet<string>)Get("SteamArtworkRoots")).Clear(); ((HashSet<string>)Get("SteamArtworkRoots")).Add(CacheRoot);
            Assert((bool)Call("SafeArtworkFile",Path.Combine(CacheRoot,"12345","library_hero.jpg")), "Owned cache path and every ancestor are regular non-linked filesystem items");
            Assert(Call("ReadArtwork",new MemoryStream(jpeg),null)!=null, "Generated owned JPEG passes artwork validation");
            using(FileStream probe=(FileStream)Call("OpenArtworkFile",Path.Combine(CacheRoot,"12345","library_hero.jpg"))) Assert(probe.Length==jpeg.Length,"Native read-only file handle opens extended cache paths");
            ArtworkData heroImage=Image(hero);
            Assert(heroImage.Mime=="image/jpeg" && heroImage.Bytes.SequenceEqual(jpeg), "Modern Steam cache supplies bounded JPEG hero bytes");
            ArtworkData capsuleImage=Image(capsule);
            Assert(capsuleImage.Mime=="image/png" && capsuleImage.Bytes.SequenceEqual(png), "Legacy numeric Steam cache supplies PNG capsule bytes");
            Assert(Object.ReferenceEquals(heroImage.Bytes,Image(hero).Bytes), "Repeated artwork requests reuse the same cached bytes");
            ArtworkData[] concurrent=new ArtworkData[8]; Thread[] workers=new Thread[8]; Exception workerError=null;
            for(int i=0;i<workers.Length;i++) { int n=i; workers[i]=new Thread(delegate(){try{concurrent[n]=Image(hero);}catch(Exception ex){workerError=ex;}}); workers[i].Start(); }
            foreach(Thread worker in workers) worker.Join(); if(workerError!=null)throw workerError;
            Assert(concurrent.All(i=>Object.ReferenceEquals(i.Bytes,heroImage.Bytes)), "Concurrent requests share a single cached artwork result");
            Expect(400,delegate{Image("/api/game-artwork?path="+HttpUtility.UrlEncode(GamePath)+"&kind=../private");}, "Artwork kind cannot become an arbitrary file name");
            Expect(400,delegate{Image(hero+"&url=https://example.com/");}, "Caller-supplied artwork URLs are rejected");
            Expect(400,delegate{Image(hero+"&appid=570");}, "Caller-supplied app IDs are rejected");
            Expect(400,delegate{Image(hero+"&kind=capsule");}, "Duplicate artwork query fields are rejected");
            Expect(400,delegate{Image("/api/game-artwork?kind=hero");}, "Artwork requires a scanned path");
            Expect(400,delegate{Image("/api/game-artwork?path=relative&kind=hero");}, "Artwork paths must be absolute");
            Expect(409,delegate{Image(hero.Replace((string)Get("ScanId"),"expired-scan"));}, "Stale scan tokens cannot fetch artwork");
            Expect(404,delegate{Image("/api/game-artwork?path="+HttpUtility.UrlEncode(Path.Combine(Root,"not-scanned")));}, "Unscanned artwork paths are rejected before cache lookup");
            Expect(404,delegate{Image("/api/game-artwork?path="+HttpUtility.UrlEncode(Path.Combine(Inventory,"Other")));}, "Unregistered folders cannot access Steam artwork");
            Expect(404,delegate{Image("/api/game-artwork?path="+HttpUtility.UrlEncode(Path.Combine(GamePath,"game.bin")));}, "Regular files are not artwork folder requests");
            Expect(404,delegate{Image("/api/game-artwork?path="+HttpUtility.UrlEncode(Path.Combine(common,"Unknown")));}, "Known-layout fallback without a manifest ID receives no artwork");
            Expect(404,delegate{Image("/api/game-artwork?path="+HttpUtility.UrlEncode(Path.Combine(common,"Mismatch")));}, "Mismatching manifest IDs cannot fetch artwork");
            Expect(405,delegate{Call("GameArtwork",RequestFor(hero,new{path=GamePath}));}, "POST cannot invoke the image endpoint");
            Assert((bool)Call("SafeArtworkFile",Path.Combine(CacheRoot,"12345","library_hero.jpg")) && !(bool)Call("SafeArtworkFile",Path.Combine(CacheRoot,"12345")), "Local artwork reader accepts regular files and rejects directories");
            Assert(Call("ReadArtwork",new MemoryStream(Encoding.UTF8.GetBytes("<svg>bad</svg>")),null)==null, "SVG/text responses are never served as Steam artwork");
            Assert(Call("ReadArtwork",new MemoryStream(new byte[]{137,80,78,71,13,10,26,10}),null)==null, "Truncated image signatures are rejected");
            Assert(Call("ReadArtwork",new MemoryStream(new byte[8*1024*1024+1]),null)==null, "Image reading stops at the 8 MiB byte limit");
            Assert(Call("ReadArtwork",new MemoryStream(ImageBytes(8193,1,ImageFormat.Png)),null)==null, "Image dimensions beyond8192 pixels are rejected");
            byte[] wide=ImageBytes(2048,64,ImageFormat.Jpeg); ArtworkData resized=(ArtworkData)Call("ReadArtwork",new MemoryStream(wide),null);
            using(System.Drawing.Image image=System.Drawing.Image.FromStream(new MemoryStream(resized.Bytes))) Assert(image.Width==1024 && image.Height==32 && resized.Mime=="image/jpeg" && !resized.Bytes.SequenceEqual(wide), "Large JPEG artwork is downsampled once to1024 pixels while preserving its aspect ratio");
            ArtworkData tall=(ArtworkData)Call("ReadArtwork",new MemoryStream(ImageBytes(64,2048,ImageFormat.Png)),null);
            using(System.Drawing.Image image=System.Drawing.Image.FromStream(new MemoryStream(tall.Bytes))) Assert(image.Width==32 && image.Height==1024 && tall.Mime=="image/png", "Large PNG artwork retains its format and bounded portrait dimensions");
            Assert(Call("ReadArtwork",new MemoryStream(png),DateTime.UtcNow.AddSeconds(-1))==null, "Expired image-transfer deadlines stop reading immediately");
            var cache=(Dictionary<string,ArtworkEntry>)Get("ArtworkCache");
            ArtworkData absent=(ArtworkData)Call("CachedArtwork","4294900001","hero",new string[0]);
            Assert(absent==null && cache["4294900001/hero"].Expires>DateTime.UtcNow.AddMinutes(4), "Unavailable artwork is negatively cached without network access in tests");
            Call("TrimArtworkCache",0,0L);
            Assert(cache.Count==0 && (long)Get("ArtworkCacheBytes")==0, "Cache trimming removes image bytes and negative entries exactly");
            for(int i=0;i<260;i++)cache[i+"/hero"]=new ArtworkEntry{Used=DateTime.UtcNow.AddSeconds(i),Data=new ArtworkData{Bytes=new byte[1],Mime="image/png"}};
            Set("ArtworkCacheBytes",260L); Call("TrimArtworkCache",256,32L*1024*1024);
            Assert(cache.Count==256 && (long)Get("ArtworkCacheBytes")==256, "Cache bounds entries by least-recent use");
            cache.Clear(); Set("ArtworkCacheBytes",0L);
            for(int i=0;i<33;i++)cache[i+"/hero"]=new ArtworkEntry{Used=DateTime.UtcNow.AddSeconds(i),Data=new ArtworkData{Bytes=new byte[1024*1024],Mime="image/png"}};
            Set("ArtworkCacheBytes",33L*1024*1024); Call("TrimArtworkCache",256,32L*1024*1024);
            Assert(cache.Count==32 && (long)Get("ArtworkCacheBytes")==32L*1024*1024, "Cache evicts to the32 MiB byte budget");
            cache.Clear(); Set("ArtworkCacheBytes",0L);
            for(int i=0;i<256;i++)cache[i+"/hero"]=new ArtworkEntry{Loading=true};
            Expect(503,delegate{Call("CachedArtwork","4294900002","hero",new string[0]);}, "An entirely in-flight cache applies bounded backpressure");
            cache.Clear(); Set("ArtworkCacheBytes",0L);
            ((HashSet<string>)Get("SteamArtworkRoots")).Clear();
            Expect(404,delegate{Image(hero);}, "Missing hero artwork returns404 without a native or remote launch");
            ((HashSet<string>)Get("SteamArtworkRoots")).Add(CacheRoot);
            Assert(Image(capsule).Bytes.SequenceEqual(png), "A missing hero does not suppress the valid capsule fallback cache key");
            Assert(Stats(Overview())==baseline && Convert.ToInt64(Overview()["size"])==bytes, "Artwork requests leave bytes/counts/categories/extensions/revision unchanged");
            Api("/api/game-library",new{path=Path.Combine(Inventory,"Manual"),enabled=true});
            Assert(Rows(Overview()["games"]).Where(g=>(string)g["source"]=="Custom game library").All(g=>!g.ContainsKey("artwork")), "Custom-only game titles never acquire guessed Steam identities");
            var customGames=Rows(Overview()["games"]).Where(g=>(string)g["source"]=="Custom game library").ToArray();
            var nonemptyCustom=customGames.Single(g=>(string)g["name"]=="Unmatched Title");
            var emptyCustom=customGames.Single(g=>(string)g["name"]=="Empty Game");
            Assert(Convert.ToInt64(nonemptyCustom["files"])==1 && Convert.ToInt64(nonemptyCustom["fileCount"])==1 && Convert.ToInt64(nonemptyCustom["folderCount"])==0, "Custom game rows expose accurate count aliases without inventing a root folder count");
            Assert(Convert.ToInt64(emptyCustom["files"])==0 && Convert.ToInt64(emptyCustom["fileCount"])==0 && Convert.ToInt64(emptyCustom["folderCount"])==0, "Empty custom game rows retain zero file and descendant-folder count aliases");
            Assert(Get("ShellDispatcher")==null, "Artwork retrieval starts no native Shell worker");
            Expect(404,delegate{Api("/api/properties",new{path=Path.Combine(Root,"not-scanned")});}, "Properties retains exact-inventory validation before its mock Shell call");
            bool inventoryAvailable=false;
            Native.PropertiesObserver=delegate{object gate=Get("Gate");inventoryAvailable=Monitor.TryEnter(gate);if(inventoryAvailable)Monitor.Exit(gate);};
            var properties=Api("/api/properties",new{path=Path.Combine(GamePath,"game.bin")});
            Assert((bool)properties["opened"], "Validated Properties request succeeds through a no-launch native mock");
            Assert(inventoryAvailable, "Native Properties invocation never holds the shared inventory lock");
            int firstThread=0, secondThread=0; bool sta=false, loop=false;
            Call("RunShellThread",(Action)delegate{firstThread=Thread.CurrentThread.ManagedThreadId;sta=Thread.CurrentThread.GetApartmentState()==ApartmentState.STA;loop=Application.MessageLoop;});
            Assert(sta && loop, "Properties dispatcher executes on a persistent STA Windows message loop");
            Thread.Sleep(50); Call("RunShellThread",(Action)delegate{secondThread=Thread.CurrentThread.ManagedThreadId;});
            Assert(firstThread==secondThread, "Subsequent Properties work uses the same surviving apartment");
            using(ManualResetEvent tick=new ManualResetEvent(false))
            {
                System.Windows.Forms.Timer timer=null;
                Call("RunShellThread",(Action)delegate{timer=new System.Windows.Forms.Timer{Interval=20};timer.Tick+=delegate{timer.Stop();timer.Dispose();tick.Set();};timer.Start();});
                Assert(tick.WaitOne(3000), "Modeless Windows messages continue after a Properties request returns");
            }
            Expect(typeof(InvalidOperationException),delegate{Call("RunShellThread",(Action)delegate{throw new InvalidOperationException("fixture-only error");});}, "Shell-worker errors are propagated to the caller");
            Call("RunShellThread",(Action)delegate{secondThread=Thread.CurrentThread.ManagedThreadId;});
            Assert(firstThread==secondThread, "A failed Shell callback leaves the Properties worker usable");
            Scan(Path.Combine(GamePath,"assets"));
            var partial=Overview(); var partialGame=Rows(partial["games"]).Single();
            Assert(Convert.ToInt64(partialGame["files"])==1 && Convert.ToInt64(partialGame["fileCount"])==1 && Convert.ToInt64(partialGame["folderCount"])==0, "Partial-game count aliases describe only the scanned scope and retain legacy files");
            Assert(partialGame.ContainsKey("artwork") && (string)partialGame["path"]==Path.Combine(GamePath,"assets") && (string)partialGame["installationPath"]==GamePath, "A selected partial-game root retains recognized artwork and clickable scope");
            Assert(Rows(partial["roots"]).Single().ContainsKey("artwork") && Api("/api/node?path="+HttpUtility.UrlEncode(Path.Combine(GamePath,"assets")),null)["artwork"]!=null, "Partial scan-root folder rows expose the same artwork metadata");
            Assert(physical.SequenceEqual(Directory.GetFiles(Inventory,"*",SearchOption.AllDirectories).OrderBy(p=>p)), "Every physical fixture path remains unchanged after artwork and Shell mocks");
            Console.WriteLine(Json.Serialize(new{checks=Checks.ToArray()}));return 0;
        }
        catch(Exception ex){Console.Error.WriteLine(ex.ToString());return 1;}
    }
    static object Get(string name){return typeof(Program).GetField(name,Flags).GetValue(null);}
    static void Set(string name,object value){typeof(Program).GetField(name,Flags).SetValue(null,value);}
    static object Call(string name,params object[] args){try{return typeof(Program).GetMethod(name,Flags).Invoke(null,args);}catch(TargetInvocationException ex){throw ex.InnerException;}}
    static Request RequestFor(string route,object body){int mark=route.IndexOf('?');return new Request{Path=mark<0?route:route.Substring(0,mark),Query=mark<0?"":route.Substring(mark+1),Method=body==null?"GET":"POST",Body=body==null?"":Json.Serialize(body)};}
    static Dictionary<string,object> Api(string route,object body){return Json.Deserialize<Dictionary<string,object>>(Json.Serialize(Call("Api",RequestFor(route,body))));}
    static ArtworkData Image(string route){return (ArtworkData)Call("GameArtwork",RequestFor(route,null));}
    static Dictionary<string,object> Overview(){return Api("/api/overview",null);}
    static List<Dictionary<string,object>> Rows(object value){return ((IEnumerable)value).Cast<Dictionary<string,object>>().ToList();}
    static string Stats(Dictionary<string,object> value){return Json.Serialize(new{size=value["size"],files=value["files"],folders=value["folders"],categories=value["categories"],extensions=value["extensions"],revision=value["revision"]});}
    static void Scan(string path){Api("/api/scan",new{paths=new[]{path}});DateTime end=DateTime.UtcNow.AddSeconds(30);while((string)Get("State")=="running" && DateTime.UtcNow<end)Thread.Sleep(20);Assert((string)Get("State")=="complete","Owned fixture scan completes without app startup");}
    static void Write(string path,byte[] data){Directory.CreateDirectory(Path.GetDirectoryName(path));File.WriteAllBytes(path,data);}
    static byte[] ImageBytes(int width,int height,ImageFormat format){using(Bitmap bitmap=new Bitmap(width,height))using(Graphics graphics=Graphics.FromImage(bitmap))using(MemoryStream stream=new MemoryStream()){graphics.Clear(Color.MediumPurple);bitmap.Save(stream,format);return stream.ToArray();}}
    static void Assert(bool value,string description){if(!value)throw new Exception("Failed: "+description);Checks.Add(description);}
    static void Expect(int code,Action action,string description){try{action();}catch(HttpError ex){Assert(ex.Code==code,description);return;}throw new Exception("Unexpected success: "+description);}
    static void Expect(Type type,Action action,string description){try{action();}catch(Exception ex){Assert(type.IsInstanceOfType(ex),description);return;}throw new Exception("Unexpected success: "+description);}
}
