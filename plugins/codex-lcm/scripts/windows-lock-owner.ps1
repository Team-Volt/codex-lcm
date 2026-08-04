param(
  [Parameter(Mandatory = $true)][int]$OwnerPid,
  [Parameter(Mandatory = $true)][string]$LockPath
)

$restartManagerSource = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class CodexLcmRestartManager
{
    private const uint ErrorSuccess = 0;
    private const uint ErrorMoreData = 234;

    [StructLayout(LayoutKind.Sequential)]
    private struct RmUniqueProcess
    {
        public int ProcessId;
        public FILETIME ProcessStartTime;
    }

    private enum RmAppType
    {
        Unknown = 0,
        MainWindow = 1,
        OtherWindow = 2,
        Service = 3,
        Explorer = 4,
        Console = 5,
        Critical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RmProcessInfo
    {
        public RmUniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string ServiceShortName;
        public RmAppType ApplicationType;
        public uint AppStatus;
        public uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern uint RmStartSession(out uint sessionHandle, uint sessionFlags, string sessionKey);

    [DllImport("rstrtmgr.dll")]
    private static extern uint RmEndSession(uint sessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern uint RmRegisterResources(
        uint sessionHandle,
        uint fileCount,
        string[] filenames,
        uint applicationCount,
        RmUniqueProcess[] applications,
        uint serviceCount,
        string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern uint RmGetList(
        uint sessionHandle,
        out uint processInfoNeeded,
        ref uint processInfoCount,
        [In, Out] RmProcessInfo[] processInfo,
        out uint rebootReasons);

    public static int OwnerHasFileOpen(int ownerPid, string lockPath)
    {
        uint sessionHandle;
        uint result = RmStartSession(out sessionHandle, 0, Guid.NewGuid().ToString("N"));
        if (result != ErrorSuccess) return 2;

        try
        {
            result = RmRegisterResources(sessionHandle, 1, new[] { lockPath }, 0, null, 0, null);
            if (result != ErrorSuccess) return 2;

            uint needed;
            uint count = 0;
            uint rebootReasons;
            RmProcessInfo[] processes = null;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                result = RmGetList(sessionHandle, out needed, ref count, processes, out rebootReasons);
                if (result == ErrorSuccess)
                {
                    if (processes == null) return 1;
                    for (int index = 0; index < count; index++)
                    {
                        if (processes[index].Process.ProcessId == ownerPid) return 0;
                    }
                    return 1;
                }
                if (result != ErrorMoreData) return 2;
                processes = new RmProcessInfo[needed];
                count = needed;
            }
            return 2;
        }
        finally
        {
            RmEndSession(sessionHandle);
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $restartManagerSource -ErrorAction Stop
  exit ([CodexLcmRestartManager]::OwnerHasFileOpen($OwnerPid, [System.IO.Path]::GetFullPath($LockPath)))
} catch {
  exit 2
}
