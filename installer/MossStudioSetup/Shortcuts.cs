using System.Runtime.InteropServices;

namespace MossStudio.Setup;

internal static class Shortcuts
{
    private const string LinkName = "MossStudio.lnk";

    public static string DesktopLink =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), LinkName);

    public static string StartMenuFolder =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "MossStudio");

    public static string StartMenuLink => Path.Combine(StartMenuFolder, LinkName);

    public static bool TryCreateForInstall(string installDirectory, out string? error)
    {
        var target = Path.Combine(installDirectory, "MossStudio.exe");
        var failures = new List<string>();

        foreach (var linkPath in new[] { DesktopLink, StartMenuLink })
        {
            if (!TryCreate(linkPath, target, installDirectory, out var failure))
            {
                failures.Add($"{linkPath}: {failure}");
            }
        }

        error = failures.Count == 0 ? null : string.Join("; ", failures);
        return failures.Count == 0;
    }

    public static void RemoveForUninstall()
    {
        TryDelete(DesktopLink);
        TryDelete(StartMenuLink);

        try
        {
            if (Directory.Exists(StartMenuFolder) &&
                !Directory.EnumerateFileSystemEntries(StartMenuFolder).Any())
            {
                Directory.Delete(StartMenuFolder);
            }
        }
        catch
        {
            // A leftover empty start-menu folder is harmless.
        }
    }

    private static bool TryCreate(string linkPath, string targetPath, string workingDirectory, out string? error)
    {
        object? shell = null;
        object? shortcut = null;
        try
        {
            var directory = Path.GetDirectoryName(linkPath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            if (File.Exists(linkPath))
            {
                File.Delete(linkPath);
            }

            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType is null)
            {
                error = "WScript.Shell 不可用";
                return false;
            }

            shell = Activator.CreateInstance(shellType);
            if (shell is null)
            {
                error = "无法创建 WScript.Shell";
                return false;
            }

            dynamic shellObject = shell;
            shortcut = shellObject.CreateShortcut(linkPath);
            dynamic link = shortcut;
            link.TargetPath = targetPath;
            link.WorkingDirectory = workingDirectory;
            link.Description = "MossStudio";
            link.IconLocation = targetPath + ",0";
            link.Save();

            if (!File.Exists(linkPath))
            {
                error = "快捷方式文件未生成";
                return false;
            }

            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
        finally
        {
            ReleaseComObject(shortcut);
            ReleaseComObject(shell);
        }
    }

    private static void ReleaseComObject(object? value)
    {
        if (value is null)
        {
            return;
        }

        try
        {
            if (Marshal.IsComObject(value))
            {
                Marshal.FinalReleaseComObject(value);
            }
        }
        catch
        {
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }
}
