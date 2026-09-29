// Control Room's handoff wrapper for Windows -- set as the Claude extension's
// `claudeCode.claudeProcessWrapper`. The posix one is extension/handoff/claude-handoff (sh).
//
// The Claude extension runs:   claude-handoff.exe <its bundled claude.exe> <arguments...>
//
// ⛔ WHY IT EXISTS. When the Claude window opens a conversation that the room is running as a
// BACKGROUND session, `claude --resume <id>` refuses to start -- "That session is running in the
// background" -- and the window shows "Claude Code process exited with code 1" over a page of debug
// output. A conversation runs in one place at a time, and opening it in the window is the reader
// choosing where: so before a resume this releases it from the room (`claude stop` touches
// background sessions only), and then the resume succeeds.
//
// ⛔ AN .EXE, NOT A SCRIPT. The Claude extension spawns the wrapper with shell:false, and on Windows
// that starts only real executables: a .cmd fails with EINVAL, and a .js is run as `node <claude.exe>
// <wrapper.js>`. That is why the sh wrapper was switched off here -- and why this is C#, compiled by
// the csc.exe every Windows ships with .NET Framework, so the build needs nothing installed.
//
// Everything else passes through untouched. Whatever goes wrong in here, claude still starts.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class Handoff
{
    static int Main(string[] argv)
    {
        if (argv.Length < 1)
        {
            Console.Error.WriteLine("claude-handoff: no claude binary given");
            return 127;
        }
        string real = argv[0];
        string[] rest = new string[argv.Length - 1];
        Array.Copy(argv, 1, rest, 0, rest.Length);

        string sid = ResumedSession(rest);
        if (sid != null)
        {
            try { Release(real, sid); } catch { /* never in the way of claude starting */ }
        }

        // Sessions the Claude window hosts are marked, so the room's session-start hook never tells
        // them to watch a room: they cannot keep a watch, and a second watcher answers twice.
        Environment.SetEnvironmentVariable("CONTROL_ROOM_HOST", "claude-window");
        Environment.SetEnvironmentVariable("CONTROL_ROOM_HOST_PID",
            Process.GetCurrentProcess().Id.ToString());

        return Run(real, rest);
    }

    /// <summary>The id after --resume / -r / --resume=, when it looks like a session id.</summary>
    static string ResumedSession(string[] args)
    {
        string sid = null;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a.StartsWith("--resume=")) sid = a.Substring(9);
            else if ((a == "--resume" || a == "-r") && i + 1 < args.Length && !args[i + 1].StartsWith("-"))
                sid = args[i + 1];
        }
        if (sid != null && Regex.IsMatch(sid, "^[0-9a-f]{8}-")) return sid;
        return null;
    }

    static void Release(string real, string sid)
    {
        string shortId = sid.Substring(0, 8);
        if (Quiet(real, "stop " + shortId, null, 15000) != 0) return;   // not a background session

        string state = Environment.GetEnvironmentVariable("CONTROL_ROOM_STATE");
        if (string.IsNullOrEmpty(state))
            state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "control-room");
        try
        {
            Directory.CreateDirectory(state);
            File.AppendAllText(Path.Combine(state, "handoff.log"),
                DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss") + " released " + sid +
                " for the Claude window (cwd " + Environment.CurrentDirectory + ")\n");
        }
        catch { }

        // Tell the room it lost its session, in the room itself. Best effort: no python, no notice.
        foreach (string py in new[] { "python", "py" })
        {
            if (Quiet(py, "- " + Arg(Environment.CurrentDirectory) + " " + Arg(sid), NOTICE, 15000) != -1) break;
        }
    }

    /// <summary>Run hidden and wait. Returns the exit code, or -1 when it could not start.</summary>
    static int Quiet(string exe, string args, string stdin, int ms)
    {
        var psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = stdin != null;
        if (stdin != null) psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        Process p;
        try { p = Process.Start(psi); } catch { return -1; }
        if (stdin != null)
        {
            var w = new StreamWriter(p.StandardInput.BaseStream, new UTF8Encoding(false));
            w.Write(stdin);
            w.Close();
        }
        p.StandardOutput.ReadToEndAsync();
        p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(ms)) { try { p.Kill(); } catch { } return -2; }
        return p.ExitCode;
    }

    // ---- running claude: same stdio, same console, dies with us -------------------------------

    /// <summary>Windows command-line quoting, the inverse of CommandLineToArgvW.</summary>
    static string Arg(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return s;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in s)
        {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1).Append('"'); bs = 0; continue; }
            sb.Append('\\', bs).Append(c);
            bs = 0;
        }
        sb.Append('\\', bs * 2).Append('"');
        return sb.ToString();
    }

    /// <summary>Start claude on OUR standard handles and wait for it.
    ///
    /// ⛔ INSIDE A KILL-ON-CLOSE JOB. There is no exec on Windows, so claude is a child of this
    /// process -- and the Claude extension stops a conversation by killing the process it started,
    /// which is this one. Without the job, claude would outlive the kill, orphaned and still holding
    /// the conversation, and the next open would fail the same way this wrapper exists to prevent.
    /// </summary>
    static int Run(string real, string[] rest)
    {
        var cmd = new StringBuilder(Arg(real));
        foreach (string a in rest) cmd.Append(' ').Append(Arg(a));

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000;          // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr p = Marshal.AllocHGlobal(len);
            Marshal.StructureToPtr(info, p, false);
            SetInformationJobObject(job, 9, p, (uint)len);            // JobObjectExtendedLimitInformation
            Marshal.FreeHGlobal(p);
        }

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 0x100;                                            // STARTF_USESTDHANDLES
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
        if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                           CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi))
        {
            Console.Error.WriteLine("claude-handoff: could not start " + real + " (error " + Marshal.GetLastWin32Error() + ")");
            return 127;
        }
        if (job != IntPtr.Zero) AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hProcess);
        return (int)code;
    }

    // The room notice, run by python so it goes through the room's own chatlog.py (and its lock).
    const string NOTICE = @"
import glob, json, os, sys
cwd, sid = sys.argv[1], sys.argv[2]

def title():
    for t in glob.glob(os.path.expanduser('~/.claude/projects/*/%s.jsonl' % sid)):
        try:
            with open(t, 'rb') as fh:
                fh.seek(0, 2); fh.seek(max(0, fh.tell() - 262144))
                tail = fh.read().decode('utf-8', 'replace').splitlines()
        except OSError:
            continue
        for line in reversed(tail):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get('type') == 'ai-title' and d.get('aiTitle'):
                return d['aiTitle']
    return sid[:8]

for room in sorted(glob.glob(os.path.join(cwd, 'control-room*'))):
    bound = [os.path.join(room, n) for n in ('.watch.' + sid, '.session.' + sid)]
    if not any(os.path.exists(p) for p in bound) or not os.path.exists(os.path.join(room, 'chatlog.py')):
        continue
    for gone in ('.watch.' + sid, '.session.' + sid):
        try:
            os.unlink(os.path.join(room, gone))
        except OSError:
            pass
    os.environ['CONTROL_ROOM_DIR'] = room
    sys.path.insert(0, room)
    import chatlog
    name = title()
    text = '\n'.join([
        '::warn ' + name + ' moved to the Claude window',
        '::say You opened this conversation in the Claude window, so the room let go of it: a '
        'conversation runs in one place at a time, and the window could not have opened it otherwise.',
        '::note Nothing is lost. Writing to it here brings it back, and closes it in the Claude window.',
    ])
    try:
        chatlog.append_message('assistant', text, about=sid)
    except TypeError:
        chatlog.append_message('assistant', text)
    sys.path.pop(0)
    del sys.modules['chatlog']
";

    // ---- Win32 ---------------------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
}
