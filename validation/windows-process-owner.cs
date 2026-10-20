using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

// Owns only the child created below. No PID discovery, breakaway permission,
// command parsing, elevation, or changes to the child's sandbox.
public static class WindowsProcessOwner {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long User, Job; public uint Flags; public UIntPtr Min, Max;
        public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long A, B, C, D; public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public uint Size; public string Reserved, Desktop, Title; public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Need(bool value) { if (!value) throw new Exception("ENGINE_OWNER_FAILED"); }
    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); text.Append(c); slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    static IntPtr Stdio(int kind) {
        IntPtr value; Need(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out value, 0, true, 2)); return value;
    }
    public static int Run(string executable, string[] args, string cwd, int parentPid, string stopFile, string resultFile) {
        IntPtr job = IntPtr.Zero, parent = IntPtr.Zero;
        var process = new ProcessInfo(); var startup = new Startup();
        bool assigned = false, forced = false; uint exitCode = 0;
        try {
            parent = OpenProcess(0x00100000, false, parentPid); Need(parent != IntPtr.Zero);
            job = CreateJobObject(IntPtr.Zero, null); Need(job != IntPtr.Zero);
            var limits = new Limits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
            Need(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Limits>()));
            startup.Size = (uint)Marshal.SizeOf<Startup>(); startup.Flags = 0x100;
            startup.Input = Stdio(-10); startup.Output = Stdio(-11); startup.Error = Stdio(-12);
            var command = new StringBuilder(Quote(executable));
            foreach (var arg in args) command.Append(' ').Append(Quote(arg));
            // Assignment before the first instruction prevents a child escaping
            // through an early spawn. Failure terminates the suspended process.
            Need(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out process));
            Need(AssignProcessToJobObject(job, process.Process)); assigned = true;
            Need(ResumeThread(process.Thread) != 0xffffffff);
            CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
            CloseHandle(startup.Input); startup.Input = IntPtr.Zero;
            CloseHandle(startup.Output); startup.Output = IntPtr.Zero;
            CloseHandle(startup.Error); startup.Error = IntPtr.Zero;
            var lifetimeDeadline = Environment.TickCount64 + 300000;
            while (true) {
                uint state = WaitForSingleObject(process.Process, 100);
                if (state == 0) break;
                Need(state == 258);
                if (File.Exists(stopFile) || WaitForSingleObject(parent, 0) == 0 || Environment.TickCount64 >= lifetimeDeadline) { forced = true; break; }
            }
            if (!forced) Need(GetExitCodeProcess(process.Process, out exitCode));
            // A normally exited engine can leave a helper behind. Reap the
            // entire job, including descendants whose immediate parent exited.
            Need(TerminateJobObject(job, 1));
            var deadline = Environment.TickCount64 + 5000;
            while (true) {
                Accounting accounting;
                Need(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
                if (accounting.Active == 0) break;
                Need(Environment.TickCount64 < deadline); Thread.Sleep(20);
            }
            var result = "{\"version\":1,\"processesEnded\":true,\"forced\":" + (forced ? "true" : "false") +
                ",\"engineExitCode\":" + (forced ? "null" : exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture)) + "}";
            File.WriteAllText(resultFile, result, new UTF8Encoding(false));
            return 0;
        } finally {
            if (!assigned && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            foreach (var handle in new[] { job, process.Thread, process.Process, parent, startup.Input, startup.Output, startup.Error })
                if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
}
