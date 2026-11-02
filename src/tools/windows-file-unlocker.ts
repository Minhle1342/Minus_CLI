import { spawn } from 'node:child_process';

const PS_UNLOCK_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$target = $env:MINUS_UNLOCK_TARGET
$currPid = [int]$env:MINUS_UNLOCK_CURRENT_PID

$csharp = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class WinFileUnlocker {
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
    public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, IntPtr rgApplications, uint nServices, IntPtr rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    public static List<int> ForceReleaseLock(string path, int currentPid) {
        var pids = new List<int>();
        uint handle;
        string key = Guid.NewGuid().ToString();
        int res = RmStartSession(out handle, 0, key);
        if (res != 0) return pids;

        try {
            string[] resources = new string[] { path };
            res = RmRegisterResources(handle, 1, resources, 0, IntPtr.Zero, 0, IntPtr.Zero);
            if (res != 0) return pids;

            uint nProcInfoNeeded = 0;
            uint nProcInfo = 0;
            uint lpdwRebootReasons = 0;
            res = RmGetList(handle, out nProcInfoNeeded, ref nProcInfo, null, ref lpdwRebootReasons);
            if (res == 234) {
                RM_PROCESS_INFO[] processInfo = new RM_PROCESS_INFO[nProcInfoNeeded];
                nProcInfo = nProcInfoNeeded;
                res = RmGetList(handle, out nProcInfoNeeded, ref nProcInfo, processInfo, ref lpdwRebootReasons);
                if (res == 0) {
                    for (int i = 0; i < nProcInfo; i++) {
                        int pid = processInfo[i].Process.dwProcessId;
                        if (pid > 4 && pid != currentPid) {
                            pids.Add(pid);
                        }
                    }
                }
            }

            // RmShutdown(RmForceShutdown) blocks for ~20s on console processes
            // that never acknowledge the shutdown request, so the call was
            // killed by the timeout before it returned any PID. Terminate the
            // holders found above directly: the OS releases their handles.
            foreach (var pid in pids) {
                try {
                    var p = Process.GetProcessById(pid);
                    if (!p.HasExited) p.Kill();
                } catch {}
            }

            return pids;
        } finally {
            RmEndSession(handle);
        }
    }
}
'@
Add-Type -TypeDefinition $csharp
$pids = [WinFileUnlocker]::ForceReleaseLock($target, $currPid)
Write-Output "PIDS:$($pids -join ',')"
`;

// Base64 encoded UTF-16LE buffer for PowerShell -EncodedCommand (avoids escaping issues)
const ENCODED_UNLOCK_SCRIPT = Buffer.from(PS_UNLOCK_SCRIPT, 'utf16le').toString('base64');

/**
 * forceReleaseWindowsFileLock:
 * Sử dụng Windows Restart Manager API (rstrtmgr.dll) để tìm kiếm và đóng cưỡng bức
 * các handle đang khóa file / thư mục mục tiêu trên Windows.
 * An toàn: Loại trừ System process (PID <= 4) và tiến trình Node.js hiện tại.
 */
export async function forceReleaseWindowsFileLock(targetPath: string): Promise<number[]> {
  if (process.platform !== 'win32') return [];

  return new Promise<number[]>((resolve) => {
    let stdoutData = '';
    const child = spawn('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      ENCODED_UNLOCK_SCRIPT,
    ], {
      env: {
        ...process.env,
        MINUS_UNLOCK_TARGET: targetPath,
        MINUS_UNLOCK_CURRENT_PID: String(process.pid),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve([]);
      // Restart Manager + Add-Type compilation routinely exceed 4s on cold
      // PowerShell startup; killing early returned no PIDs and left the file
      // locked, so the caller's retry still saw EBUSY.
    }, 15_000);

    child.stdout?.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    child.on('close', () => {
      clearTimeout(timeout);
      const match = stdoutData.match(/PIDS:([0-9,]*)/);
      if (!match || !match[1]) {
        resolve([]);
        return;
      }
      const pids = match[1]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids);
    });

    child.on('error', () => {
      clearTimeout(timeout);
      resolve([]);
    });
  });
}
