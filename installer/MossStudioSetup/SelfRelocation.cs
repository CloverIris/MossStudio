using System.Diagnostics;

namespace MossStudio.Setup;

/// <summary>
/// The setup exe installed at &lt;InstallDir&gt;\MossStudio-Setup.exe cannot delete
/// itself on Windows. For uninstall it copies itself to %TEMP%, starts that copy
/// with a --wait-for argument, and lets the original process exit immediately.
/// </summary>
internal static class SelfRelocation
{
    private const string TempFilePrefix = "MossStudio-Setup-";

    public static bool IsRunningFromInstallDirectory(string installDirectory)
    {
        var self = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(self))
        {
            return false;
        }

        var fullSelf = Path.GetFullPath(self);
        return PathSafety.IsSameOrInside(installDirectory, fullSelf) &&
               !PathSafety.SamePath(fullSelf, Path.Combine(installDirectory, "MossStudio.exe"));
    }

    public static bool TryStartTempCopy(IReadOnlyList<string> arguments)
    {
        try
        {
            var self = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(self))
            {
                return false;
            }

            var tempCopy = Path.Combine(
                Path.GetTempPath(),
                $"{TempFilePrefix}{Guid.NewGuid():N}.exe");
            File.Copy(self, tempCopy, overwrite: true);

            var startInfo = new ProcessStartInfo
            {
                FileName = tempCopy,
                WorkingDirectory = Path.GetTempPath(),
                UseShellExecute = false,
                CreateNoWindow = false,
            };
            foreach (var argument in arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            startInfo.ArgumentList.Add("--relocated");

            return Process.Start(startInfo) is not null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Deletes the temp copy after this process exits (best effort).</summary>
    public static void ScheduleSelfDelete()
    {
        try
        {
            var self = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(self))
            {
                return;
            }

            var fullSelf = Path.GetFullPath(self);
            var tempRoot = Path.GetFullPath(Path.GetTempPath());
            if (!PathSafety.IsSameOrInside(tempRoot, fullSelf) ||
                PathSafety.SamePath(tempRoot, fullSelf))
            {
                return;
            }

            if (!Path.GetFileName(fullSelf).StartsWith(TempFilePrefix, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                Arguments = $"/c ping 127.0.0.1 -n 3 >nul & del /f /q \"{fullSelf}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process.Start(startInfo);
        }
        catch
        {
            // A leftover temp copy is harmless.
        }
    }
}
