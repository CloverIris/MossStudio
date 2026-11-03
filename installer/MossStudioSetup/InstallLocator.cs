using System.Diagnostics;
using System.Text.RegularExpressions;

namespace MossStudio.Setup;

internal static class InstallLocator
{
    private static readonly Regex VersionPattern = new(
        @"(?<![\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static bool IsInstallDirectory(string directory)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(directory))
            {
                return false;
            }

            return File.Exists(InstallRecord.PathFor(directory)) ||
                   (File.Exists(Path.Combine(directory, "MossStudio.exe")) &&
                    Directory.Exists(Path.Combine(directory, "resources")));
        }
        catch
        {
            return false;
        }
    }

    public static string? ReadInstalledVersion(string directory)
    {
        var record = InstallRecord.TryRead(directory);
        if (record is not null && !string.IsNullOrWhiteSpace(record.Version))
        {
            return record.Version;
        }

        try
        {
            var executable = Path.Combine(directory, "MossStudio.exe");
            if (File.Exists(executable))
            {
                var info = FileVersionInfo.GetVersionInfo(executable);
                var candidate = CleanVersion(info.ProductVersion) ?? CleanVersion(info.FileVersion);
                if (candidate is not null)
                {
                    return candidate;
                }
            }
        }
        catch
        {
        }

        try
        {
            var releaseNote = Path.Combine(directory, "resources", "release", "release.md");
            if (File.Exists(releaseNote))
            {
                var match = VersionPattern.Match(File.ReadAllText(releaseNote));
                if (match.Success)
                {
                    return match.Groups[1].Value;
                }
            }
        }
        catch
        {
        }

        return null;
    }

    /// <summary>Picks the directory the GUI should show on startup.</summary>
    public static string FindInitialDirectory(string? requested, string? setupExeDirectory)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            return SafeFullPath(requested) ?? PathSafety.DefaultInstallDirectory;
        }

        if (!string.IsNullOrWhiteSpace(setupExeDirectory) && IsInstallDirectory(setupExeDirectory))
        {
            return SafeFullPath(setupExeDirectory) ?? PathSafety.DefaultInstallDirectory;
        }

        var registered = RegistryRegistration.TryReadInstallLocation();
        if (!string.IsNullOrWhiteSpace(registered) && IsInstallDirectory(registered))
        {
            return SafeFullPath(registered) ?? PathSafety.DefaultInstallDirectory;
        }

        return PathSafety.DefaultInstallDirectory;
    }

    /// <summary>Resolves the uninstall target when --dir is omitted.</summary>
    public static string ResolveUninstallDirectory(string? requested, bool allowSystemDirectory)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            return PathSafety.ResolveInstallDirectory(requested, allowSystemDirectory);
        }

        var registered = RegistryRegistration.TryReadInstallLocation();
        if (!string.IsNullOrWhiteSpace(registered) && IsInstallDirectory(registered))
        {
            return PathSafety.ResolveInstallDirectory(registered, allowSystemDirectory);
        }

        var setupDirectory = SafeDirectoryName(Environment.ProcessPath);
        if (setupDirectory is not null && IsInstallDirectory(setupDirectory))
        {
            return PathSafety.ResolveInstallDirectory(setupDirectory, allowSystemDirectory);
        }

        return PathSafety.ResolveInstallDirectory(null, allowSystemDirectory);
    }

    public static string? SafeDirectoryName(string? path)
    {
        try
        {
            return string.IsNullOrWhiteSpace(path) ? null : Path.GetDirectoryName(Path.GetFullPath(path));
        }
        catch
        {
            return null;
        }
    }

    private static string? SafeFullPath(string path)
    {
        try
        {
            return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        }
        catch
        {
            return null;
        }
    }

    private static string? CleanVersion(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var match = VersionPattern.Match(value);
        return match.Success ? match.Groups[1].Value : null;
    }
}
