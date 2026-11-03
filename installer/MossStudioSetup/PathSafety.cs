namespace MossStudio.Setup;

internal sealed class InstallerException : Exception
{
    public InstallerException(string message) : base(message)
    {
    }

    public InstallerException(string message, Exception innerException) : base(message, innerException)
    {
    }
}

/// <summary>
/// All filesystem paths that the engine creates, overwrites or deletes go through
/// these helpers. Nothing outside the resolved install directory may be touched
/// (shortcuts and the HKCU uninstall key are the intentional exceptions).
/// </summary>
internal static class PathSafety
{
    public static string DefaultInstallDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "MossStudio");

    public static string ResolveInstallDirectory(string? requested, bool allowSystemDirectory)
    {
        var value = string.IsNullOrWhiteSpace(requested) ? DefaultInstallDirectory : requested.Trim();
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
        {
            value = value[1..^1];
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(value);
        }
        catch (Exception ex)
        {
            throw new InstallerException($"安装目录无效：{value}（{ex.Message}）", ex);
        }

        fullPath = Path.TrimEndingDirectorySeparator(fullPath);
        if (fullPath.Length == 0)
        {
            throw new InstallerException("安装目录为空。");
        }

        var root = Path.GetPathRoot(fullPath);
        if (!string.IsNullOrEmpty(root) && SamePath(Path.TrimEndingDirectorySeparator(root), fullPath))
        {
            throw new InstallerException($"不允许把磁盘根目录作为安装目录：{fullPath}");
        }

        if (!allowSystemDirectory)
        {
            foreach (var protectedPath in ProtectedTrees())
            {
                if (string.IsNullOrWhiteSpace(protectedPath))
                {
                    continue;
                }

                if (IsSameOrInside(protectedPath, fullPath))
                {
                    throw new InstallerException(
                        $"拒绝使用系统目录：{fullPath}。如果确有需要，请显式传入 --allow-system-dir。");
                }
            }

            foreach (var protectedPath in ProtectedExact())
            {
                if (string.IsNullOrWhiteSpace(protectedPath))
                {
                    continue;
                }

                if (SamePath(protectedPath, fullPath))
                {
                    throw new InstallerException(
                        $"拒绝使用系统目录：{fullPath}。如果确有需要，请显式传入 --allow-system-dir。");
                }
            }
        }

        return fullPath;
    }

    public static bool IsSameOrInside(string root, string candidate)
    {
        var fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var fullCandidate = Path.TrimEndingDirectorySeparator(Path.GetFullPath(candidate));
        if (SamePath(fullRoot, fullCandidate))
        {
            return true;
        }

        var prefix = fullRoot.EndsWith(Path.DirectorySeparatorChar)
            ? fullRoot
            : fullRoot + Path.DirectorySeparatorChar;
        return fullCandidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    public static bool SamePath(string? left, string? right)
    {
        if (left is null || right is null)
        {
            return false;
        }

        return string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
            StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Throws unless <paramref name="candidate"/> is strictly below <paramref name="root"/>.</summary>
    public static string EnsureInside(string root, string candidate)
    {
        var fullCandidate = Path.GetFullPath(candidate);
        if (!IsSameOrInside(root, fullCandidate) || SamePath(root, fullCandidate))
        {
            throw new InstallerException($"拒绝操作安装目录之外的路径：{fullCandidate}");
        }

        return fullCandidate;
    }

    public static string SanitizeFileName(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "unknown";
        }

        var invalid = Path.GetInvalidFileNameChars();
        var chars = value.Trim().Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray();
        var result = new string(chars).Trim().TrimEnd('.');
        return result.Length == 0 ? "unknown" : result;
    }

    private static IEnumerable<string> ProtectedTrees()
    {
        yield return Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.System);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
    }

    private static IEnumerable<string> ProtectedExact()
    {
        yield return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    }
}
