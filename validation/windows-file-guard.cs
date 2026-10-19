// P1 native Windows experiment, loaded by the pinned PowerShell runtime.
// Kept outside the model process. Not yet a distributed application component.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public sealed class GuardEntry {
    public string relative { get; set; }
    public string sha256 { get; set; }
    public string base64 { get; set; }
}
public sealed class GuardCapture {
    public List<GuardEntry> files { get; set; } = new List<GuardEntry>();
    public List<string> excluded { get; set; } = new List<string>();
}
public sealed class WindowsFileGuard : IDisposable {
    const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000;
    const uint OpenReparse = 0x200000, Backup = 0x2000000;
    const int FileLimit = 1024, ByteLimit = 16 * 1024 * 1024, SingleLimit = 1024 * 1024;
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Disposition { public int DeleteFile; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition data, uint size);
    readonly List<IDisposable> held = new List<IDisposable>();
    FileStream target;
    SafeFileHandle targetHandle;
    public string status { get; private set; } = "ready";
    static Exception Error(string code) { return new IOException("GUARD_" + code); }
    public static string Hash(byte[] bytes) { return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(); }
    static void TextOnly(byte[] bytes) {
        if (bytes.Length > SingleLimit || Array.IndexOf(bytes, (byte)0) >= 0) throw Error("TEXT_LIMIT");
        try { new UTF8Encoding(false, true).GetString(bytes); } catch { throw Error("TEXT_ENCODING"); }
    }
    static void Segment(string part) {
        if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
            part.IndexOfAny(new [] {'\\', '/', ':', '<', '>', '"', '|', '?', '*'}) >= 0 || part.Any(c => c < 32) ||
            Regex.IsMatch(part, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", RegexOptions.IgnoreCase)) throw Error("PATH_REFUSED");
    }
    public static bool Excluded(string part) {
        string lower = part.ToLowerInvariant();
        return new [] { ".git", ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".npmrc", ".pypirc", ".git-credentials", "credentials.json", "node_modules" }.Contains(lower) ||
            lower == ".env" || lower.StartsWith(".env.") || Regex.IsMatch(lower, @"^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)|\.(pem|key|p12|pfx|keystore)$");
    }
    SafeFileHandle Open(string name, uint access, uint share, uint creation, bool directory) {
        var handle = CreateFileW(name, access, share, IntPtr.Zero, creation, OpenReparse | (directory ? Backup : 0), IntPtr.Zero);
        if (handle.IsInvalid) {
            int code = Marshal.GetLastWin32Error(); handle.Dispose();
            if (code == 2 || code == 3) throw Error("MISSING");
            if (code == 80 || code == 183) throw Error("EXISTS");
            throw Error("OPEN_REFUSED");
        }
        held.Add(handle);
        Info info;
        if (!GetFileInformationByHandle(handle, out info)) throw Error("INFO_FAILED");
        if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1)) throw Error("TYPE_REFUSED");
        return handle;
    }
    string Root(string root) {
        // Local drive paths only; explicitly refuse namespace/device/UNC syntax.
        if (!Regex.IsMatch(root, @"^[A-Za-z]:\\") || root.Contains('/')) throw Error("ROOT_REFUSED");
        string normalized = Path.GetFullPath(root).TrimEnd('\\');
        if (!String.Equals(root.TrimEnd('\\'), normalized, StringComparison.OrdinalIgnoreCase) || normalized.Length < 4) throw Error("ROOT_REFUSED");
        string current = normalized.Substring(0, 3);
        Open(current, 0x80, 1, 3, true);
        foreach (string part in normalized.Substring(3).Split('\\')) {
            Segment(part); current = Path.Combine(current, part); Open(current, 0x80, 1, 3, true);
        }
        return normalized;
    }
    byte[] ReadAll(FileStream stream) {
        if (stream.Length > SingleLimit) throw Error("TEXT_LIMIT");
        byte[] bytes = new byte[(int)stream.Length]; stream.Position = 0; stream.ReadExactly(bytes); TextOnly(bytes); return bytes;
    }
    public GuardCapture Capture(string root) {
        string canonical = Root(root); var result = new GuardCapture(); int total = 0, entries = 0;
        Action<string, string> walk = null;
        walk = (dir, prefix) => {
            foreach (string file in Directory.GetFileSystemEntries(dir).OrderBy(p => p, StringComparer.OrdinalIgnoreCase)) {
                if (++entries > FileLimit) throw Error("ENTRY_LIMIT");
                string name = Path.GetFileName(file); Segment(name); string relative = prefix + name;
                if (Excluded(name)) { result.excluded.Add(relative); continue; }
                // Attributes are used only to select the expected handle type; the handle is authoritative.
                bool directory = (File.GetAttributes(file) & FileAttributes.Directory) != 0;
                var handle = Open(file, directory ? 0x80 : Read, 1, 3, directory);
                if (directory) walk(file, relative + "/");
                else {
                    var stream = new FileStream(handle, FileAccess.Read); held.Add(stream);
                    byte[] bytes = ReadAll(stream); total += bytes.Length;
                    if (total > ByteLimit) throw Error("TOTAL_LIMIT");
                    result.files.Add(new GuardEntry { relative = relative, sha256 = Hash(bytes), base64 = Convert.ToBase64String(bytes) });
                }
            }
        };
        walk(canonical, ""); return result;
    }
    public void Prepare(string root, string relative, string expected, bool createNew) {
        string current = Root(root); string[] parts = relative.Split('/');
        foreach (string part in parts) { Segment(part); if (Excluded(part)) throw Error("EXCLUDED"); }
        for (int i = 0; i < parts.Length - 1; i++) { current = Path.Combine(current, parts[i]); Open(current, 0x80, 1, 3, true); }
        string file = Path.Combine(current, parts[parts.Length - 1]);
        // CREATE_NEW refuses an occupied path atomically; OPEN_EXISTING never truncates.
        targetHandle = Open(file, Read | Write | Delete, 0, createNew ? 1u : 3u, false);
        target = new FileStream(targetHandle, FileAccess.ReadWrite); held.Add(target);
        if (!createNew && Hash(ReadAll(target)) != expected) status = "conflict";
    }
    public void Apply(byte[] bytes, bool deletion) {
        if (status != "ready" || target == null) throw Error("NOT_READY");
        if (deletion) {
            var disposition = new Disposition { DeleteFile = 1 };
            if (!SetFileInformationByHandle(targetHandle, 4, ref disposition, 4)) throw Error("DELETE_FAILED");
        } else {
            TextOnly(bytes); target.Position = 0; target.Write(bytes, 0, bytes.Length); target.SetLength(bytes.Length); target.Flush(true);
            if (Hash(ReadAll(target)) != Hash(bytes)) throw Error("WRITE_VERIFY_FAILED");
        }
        status = "applied";
    }
    public void Dispose() { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); held.Clear(); }
}
