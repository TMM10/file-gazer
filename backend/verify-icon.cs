using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

internal static class VerifyFileGazerIcon
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr icon);
    static Icon NativeExecutableIcon(string path)
    {
        IntPtr[] large = new IntPtr[1], small = new IntPtr[1];
        try
        {
            if (ExtractIconEx(path, 0, large, small, 1) == 0 || large[0] == IntPtr.Zero) return null;
            using (Icon native = Icon.FromHandle(large[0])) return (Icon)native.Clone();
        }
        finally { if (large[0] != IntPtr.Zero) DestroyIcon(large[0]); if (small[0] != IntPtr.Zero) DestroyIcon(small[0]); }
    }
    static readonly List<string> Checks = new List<string>();
    static void Check(bool condition, string description)
    {
        if (!condition) throw new Exception(description);
        Checks.Add(description);
        Console.WriteLine("PASS: " + description);
    }
    static string Hash(byte[] data)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(data)).Replace("-", "");
    }
    static string Pixels(Icon icon)
    {
        using (Bitmap bitmap = icon.ToBitmap())
        using (MemoryStream bytes = new MemoryStream())
        using (BinaryWriter writer = new BinaryWriter(bytes))
        {
            writer.Write(bitmap.Width); writer.Write(bitmap.Height);
            for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++)
            {
                Color pixel = bitmap.GetPixel(x, y);
                writer.Write(pixel.A == 0 ? 0 : pixel.ToArgb());
            }
            writer.Flush(); return Hash(bytes.ToArray());
        }
    }
    static bool SameArtwork(Icon expected, Icon actual)
    {
        if (actual == null || actual.Size != expected.Size) return false;
        using (Bitmap a = new Bitmap(expected.Width, expected.Height))
        using (Bitmap b = new Bitmap(actual.Width, actual.Height))
        {
            using (Graphics graphics = Graphics.FromImage(a)) { graphics.Clear(Color.FromArgb(32, 32, 32)); graphics.DrawIcon(expected, new Rectangle(Point.Empty, expected.Size)); }
            using (Graphics graphics = Graphics.FromImage(b)) { graphics.Clear(Color.FromArgb(32, 32, 32)); graphics.DrawIcon(actual, new Rectangle(Point.Empty, actual.Size)); }
            int matches = 0;
            for (int y = 0; y < a.Height; y++) for (int x = 0; x < a.Width; x++)
            {
                Color source = a.GetPixel(x, y), native = b.GetPixel(x, y);
                if (Math.Abs(source.R-native.R)<=1 && Math.Abs(source.G-native.G)<=1 && Math.Abs(source.B-native.B)<=1) matches++;
            }
            Console.WriteLine("Windows icon artwork: " + matches + "/" + (a.Width * a.Height) + " rendered pixels match");
            return matches >= a.Width * a.Height * .99;
        }
    }
    static int Main(string[] args)
    {
        try
        {
            string candidate = Path.GetFullPath(args[0]), asset = Path.GetFullPath(args[1]);
            byte[] iconBytes = File.ReadAllBytes(asset);
            Check(iconBytes.Length > 6 && BitConverter.ToUInt16(iconBytes, 0) == 0 && BitConverter.ToUInt16(iconBytes, 2) == 1 && BitConverter.ToUInt16(iconBytes, 4) == 9, "Star asset contains nine Windows icon resolutions");
            Assembly assembly = Assembly.LoadFile(candidate);
            Check(assembly.GetManifestResourceNames().Contains("FileGazer.Icon"), "Candidate embeds the exact FileGazer.Icon resource name");
            using (Stream resource = assembly.GetManifestResourceStream("FileGazer.Icon"))
            using (MemoryStream copy = new MemoryStream())
            {
                resource.CopyTo(copy);
                Check(Hash(copy.ToArray()) == Hash(iconBytes), "Managed resource bytes exactly match the star asset");
            }
            MethodInfo loader = assembly.GetType("StorageAtlas.Program", true).GetMethod("LoadTrayIcon", BindingFlags.Static | BindingFlags.NonPublic);
            using (Icon assetIcon = new Icon(asset, new Size(32, 32)))
            using (Icon first = (Icon)loader.Invoke(null, null))
            using (Icon second = (Icon)loader.Invoke(null, null))
            using (Icon executable = NativeExecutableIcon(args.Length > 3 ? args[3] : candidate))
            {
                string expected = Pixels(assetIcon);
                Check(first.Width == 32 && first.Height == 32 && Pixels(first) == expected, "Tray loader returns the star pixels after its resource stream closes");
                Check(!Object.ReferenceEquals(first, second), "Tray icons are independently owned instances");
                first.Dispose();
                Check(Pixels(second) == expected, "Disposing one tray icon leaves the other valid");
                using (Icon matchingAsset = new Icon(asset, executable == null ? new Size(32, 32) : executable.Size))
                    Check(SameArtwork(matchingAsset, executable), "Windows extracts the star artwork from the executable icon resource");
                using (Bitmap bitmap = second.ToBitmap())
                    Check(bitmap.GetPixel(0, 0).A == 0 && Enumerable.Range(0, bitmap.Width).Any(x => Enumerable.Range(0, bitmap.Height).Any(y => bitmap.GetPixel(x, y).A > 0)), "Star icon retains transparency and visible artwork");
                Check(Pixels(second) != Pixels(SystemIcons.Application), "Star tray artwork differs from the generic Windows application icon");
            }
            File.WriteAllText(args[2], new JavaScriptSerializer().Serialize(new { passed = Checks.Count, failed = 0, checks = Checks, candidate = candidate, candidateSha256 = Hash(File.ReadAllBytes(candidate)), asset = asset, assetSha256 = Hash(iconBytes), appStarted = false, testedAt = DateTime.UtcNow.ToString("o") }));
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
