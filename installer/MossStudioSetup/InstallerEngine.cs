using System.Diagnostics;
using System.Text;
using System.Windows.Forms;

namespace MossStudio.Setup;

internal sealed record InstallProgress(string Phase, int Percent, string Message);

internal sealed class InstallerEngine
{
    private readonly CliOptions _options;
    private readonly IProgress<InstallProgress>? _progress;
    private string _installDir = "";
    private string? _lastConsoleMessage;

    public InstallerEngine(CliOptions options, IProgress<InstallProgress>? progress = null)
    {
        _options = options;
        _progress = progress;
    }

    public string? LastError { get; private set; }
    public string? LastLogPath { get; private set; }

    public int Run()
    {
        try
        {
            _installDir = PathSafety.ResolveInstallDirectory(_options.Directory, _options.AllowSystemDirectory);
        }
        catch (Exception ex)
        {
            return Fail(ex);
        }

        try
        {
            return _options.Mode switch
            {
                SetupMode.Install => RunInstall(),
                SetupMode.Update => RunUpdate(),
                SetupMode.Uninstall => RunUninstall(),
                _ => throw new InstallerException($"当前模式不支持命令行执行：{_options.Mode}"),
            };
        }
        catch (Exception ex)
        {
            return Fail(ex);
        }
    }

    private int RunInstall()
    {
        try
        {
            Report("verify", 0, "正在校验安装包…");
            using var payload = PayloadArchive.Open(SelfPath());

            Report("prepare", 0, $"正在安装到 {_installDir}");
            Directory.CreateDirectory(_installDir);
            payload.ExtractTo(_installDir, percent => Report("extract", percent, $"正在解压文件… {percent}%"));

            Report("record", 0, "正在写入安装记录…");
            WriteInstallRecord(payload.Info.Sha256);

            var setupCopy = Path.Combine(_installDir, "MossStudio-Setup.exe");
            if (!PathSafety.SamePath(SelfPath(), setupCopy))
            {
                File.Copy(SelfPath(), setupCopy, overwrite: true);
            }

            if (!_options.SkipShortcuts)
            {
                Report("shortcuts", 0, "正在创建快捷方式…");
                if (!Shortcuts.TryCreateForInstall(_installDir, out var shortcutError))
                {
                    Report("shortcuts", 0, $"快捷方式创建失败（不影响安装）：{shortcutError}");
                }
            }

            if (!_options.SkipRegistry)
            {
                Report("registry", 0, "正在注册卸载信息…");
                if (!RegistryRegistration.TryRegister(_installDir, ProgramInfo.Version, _options.AllowSystemDirectory, out var registryError))
                {
                    Report("registry", 0, $"写入卸载注册表失败（不影响安装）：{registryError}");
                }
            }

            var shouldLaunch = _options.Launch || !_options.Silent;
            if (shouldLaunch)
            {
                RelaunchApp("安装完成，正在启动 MossStudio…");
            }

            Report("done", 100, "安装完成。");
            return 0;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            ConsoleSupport.WriteError($"error: {ex.Message}");
            Report("error", 0, "安装失败。");
            ShowError($"安装失败：{ex.Message}");
            return 1;
        }
    }

    private int RunUpdate()
    {
        using var log = new UpdateLog(_installDir, ProgramInfo.Version);
        LastLogPath = log.LogPath;
        string? backupDirectory = null;
        var backupReady = false;
        string? previousRecord = null;

        try
        {
            log.Info($"update to {ProgramInfo.Version} starting; install_dir={_installDir}");
            Report("wait", 0, "等待 MossStudio 退出…");
            WaitForApplicationExit(log);

            Report("verify", 0, "正在校验安装包…");
            using var payload = PayloadArchive.Open(SelfPath());
            log.Info($"payload verified; size={payload.Info.Size}; sha256={payload.Info.Sha256}");

            var currentVersion = InstallLocator.ReadInstalledVersion(_installDir) ?? "unknown";
            log.Info($"current version: {currentVersion}");

            backupDirectory = CreateBackupDirectory(currentVersion);
            Report("backup", 0, "正在备份当前程序文件…");
            var backup = BackupProgramFiles(backupDirectory);
            backupReady = true;
            log.Info($"backup ready: {backupDirectory}; files={backup.Files}; bytes={backup.Bytes}");

            var recordPath = InstallRecord.PathFor(_installDir);
            if (File.Exists(recordPath))
            {
                previousRecord = File.ReadAllText(recordPath, Encoding.UTF8);
            }

            Report("extract", 0, "正在解压新版本…");
            payload.ExtractTo(_installDir, percent => Report("extract", percent, $"正在解压新版本… {percent}%"));
            WriteInstallRecord(payload.Info.Sha256);
            log.Info("install.json updated");

            // Keep the installed uninstaller copy in step with the version that is
            // actually installed, so the HKCU UninstallString never points at an old exe.
            var setupCopy = Path.Combine(_installDir, "MossStudio-Setup.exe");
            if (!PathSafety.SamePath(SelfPath(), setupCopy))
            {
                File.Copy(SelfPath(), setupCopy, overwrite: true);
                log.Info("installed setup copy refreshed");
            }

            if (_options.Relaunch)
            {
                RelaunchApp("更新完成，正在启动 MossStudio…");
            }
            else
            {
                Report("launch", 100, "更新完成（已跳过启动）。");
            }

            log.Info("update succeeded");
            if (backupDirectory is not null)
            {
                TryDeleteDirectory(backupDirectory, message => log.Error($"backup cleanup: {message}"));
            }

            Report("done", 100, "更新完成。");
            return 0;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            log.Error($"update failed: {ex}");
            ConsoleSupport.WriteError($"error: {ex.Message}");

            if (backupReady && backupDirectory is not null)
            {
                try
                {
                    RestoreFromBackup(backupDirectory, previousRecord);
                    log.Info("rollback completed");
                    TryDeleteDirectory(backupDirectory, message => log.Error($"backup cleanup after rollback: {message}"));
                }
                catch (Exception rollbackException)
                {
                    log.Error($"rollback failed: {rollbackException}");
                    LastError = $"{ex.Message}（回滚也失败：{rollbackException.Message}）";
                }
            }
            else if (backupDirectory is not null)
            {
                TryDeleteDirectory(backupDirectory, message => log.Error($"partial backup cleanup: {message}"));
            }

            Report("error", 0, "更新失败。");
            ShowError(
                $"更新失败：{LastError}\n\n日志：{log.LogPath}",
                "MossStudio 更新");
            return 1;
        }
    }

    private int RunUninstall()
    {
        try
        {
            Report("uninstall", 0, "正在卸载 MossStudio…");

            if (!Directory.Exists(_installDir))
            {
                if (!_options.SkipShortcuts) Shortcuts.RemoveForUninstall();
                if (!_options.SkipRegistry) RegistryRegistration.TryRemove(out _);
                Report("done", 100, "MossStudio 未安装，已完成清理。");
                ShowInfo("MossStudio 未安装，已完成快捷方式与注册表清理。");
                return 0;
            }

            KillRunningApplication();

            if (!_options.SkipShortcuts)
            {
                Report("shortcuts", 0, "正在删除快捷方式…");
                Shortcuts.RemoveForUninstall();
            }

            if (!_options.SkipRegistry)
            {
                Report("registry", 0, "正在删除卸载注册表项…");
                if (!RegistryRegistration.TryRemove(out var registryError))
                {
                    Report("registry", 0, $"删除卸载注册表项失败：{registryError}");
                }
            }

            Report("remove", 0, "正在删除程序文件…");
            DeleteProgramFiles(_installDir, preserveData: !_options.PurgeData);

            var dataDirectory = Path.Combine(_installDir, "data");
            if (_options.PurgeData)
            {
                if (Directory.Exists(_installDir) && !Directory.EnumerateFileSystemEntries(_installDir).Any())
                {
                    Directory.Delete(_installDir);
                }
            }
            else if (!Directory.Exists(dataDirectory) &&
                     Directory.Exists(_installDir) &&
                     !Directory.EnumerateFileSystemEntries(_installDir).Any())
            {
                Directory.Delete(_installDir);
            }

            Report("done", 100, "卸载完成。");
            ShowInfo(_options.PurgeData
                ? "MossStudio 已卸载，用户数据已删除。"
                : "MossStudio 已卸载，用户数据已保留（data 目录）。");
            return 0;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            ConsoleSupport.WriteError($"error: {ex.Message}");
            Report("error", 0, "卸载失败。");
            ShowError($"卸载失败：{ex.Message}");
            return 1;
        }
    }

    private void WaitForApplicationExit(UpdateLog log)
    {
        if (_options.Pid is not int pid || pid <= 0 || pid == Environment.ProcessId)
        {
            return;
        }

        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            log.Info($"pid {pid} already exited");
            return;
        }

        using (process)
        {
            try
            {
                if (process.HasExited)
                {
                    return;
                }
            }
            catch (Exception ex)
            {
                log.Info($"cannot query pid {pid}: {ex.Message}");
                return;
            }

            string name;
            try
            {
                name = process.ProcessName;
            }
            catch
            {
                name = "";
            }

            if (name.Length > 0 && !name.Equals("MossStudio", StringComparison.OrdinalIgnoreCase))
            {
                log.Info($"pid {pid} belongs to '{name}', not MossStudio; skipping wait");
                return;
            }

            Report("wait", 0, "等待 MossStudio 退出…");
            log.Info($"waiting for pid {pid}");
            if (!process.WaitForExit(TimeSpan.FromMinutes(5)))
            {
                throw new InstallerException("等待 MossStudio 退出超时（5 分钟）。");
            }

            log.Info($"pid {pid} exited");
        }
    }

    private void KillRunningApplication()
    {
        Process[] processes;
        try
        {
            processes = Process.GetProcessesByName("MossStudio");
        }
        catch
        {
            return;
        }

        foreach (var process in processes)
        {
            using (process)
            {
                try
                {
                    if (process.HasExited)
                    {
                        continue;
                    }

                    string? executablePath = null;
                    try
                    {
                        executablePath = process.MainModule?.FileName;
                    }
                    catch
                    {
                    }

                    if (executablePath is not null &&
                        !PathSafety.IsSameOrInside(_installDir, executablePath))
                    {
                        continue;
                    }

                    Report("uninstall", 0, "正在关闭 MossStudio…");
                    process.Kill();
                    process.WaitForExit(TimeSpan.FromSeconds(10));
                }
                catch
                {
                    // The process may have exited between enumeration and Kill.
                }
            }
        }
    }

    private string CreateBackupDirectory(string currentVersion)
    {
        var backupsRoot = Path.Combine(_installDir, "data", "backups");
        Directory.CreateDirectory(backupsRoot);
        var stem = $"{PathSafety.SanitizeFileName(currentVersion)}-{DateTime.Now:yyyyMMdd-HHmmss}";
        var candidate = Path.Combine(backupsRoot, stem);
        var suffix = 2;
        while (Directory.Exists(candidate))
        {
            candidate = Path.Combine(backupsRoot, $"{stem}-{suffix}");
            suffix++;
        }

        Directory.CreateDirectory(candidate);
        return candidate;
    }

    private (int Files, long Bytes) BackupProgramFiles(string backupDirectory)
    {
        var files = 0;
        long bytes = 0;
        CopyProgramDirectory(_installDir, backupDirectory, isRoot: true, ref files, ref bytes);
        return (files, bytes);
    }

    private static void CopyProgramDirectory(string source, string destination, bool isRoot, ref int files, ref long bytes)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(source))
        {
            var name = Path.GetFileName(entry);
            if (isRoot && name.Equals("data", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var target = Path.Combine(destination, name);
            PathSafety.EnsureInside(destination, target);

            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                // Do not follow junctions when backing up program files.
                continue;
            }

            if ((attributes & FileAttributes.Directory) != 0)
            {
                Directory.CreateDirectory(target);
                CopyProgramDirectory(entry, target, isRoot: false, ref files, ref bytes);
            }
            else
            {
                Directory.CreateDirectory(destination);
                File.Copy(entry, target, overwrite: true);
                files++;
                bytes += new FileInfo(entry).Length;
            }
        }
    }

    private void RestoreFromBackup(string backupDirectory, string? previousRecord)
    {
        Report("rollback", 0, "正在回滚到上一个版本…");
        DeleteProgramFiles(_installDir, preserveData: true);

        Directory.CreateDirectory(_installDir);
        CopyTree(backupDirectory, _installDir);

        var recordPath = InstallRecord.PathFor(_installDir);
        try
        {
            if (previousRecord is not null)
            {
                var directory = Path.GetDirectoryName(recordPath);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(recordPath, previousRecord, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            }
            else if (File.Exists(recordPath))
            {
                File.Delete(recordPath);
            }
        }
        catch
        {
            // The program files are restored; a stale install.json is not fatal.
        }
    }

    private static void CopyTree(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var entry in Directory.EnumerateFileSystemEntries(source))
        {
            var name = Path.GetFileName(entry);
            var target = Path.Combine(destination, name);
            PathSafety.EnsureInside(destination, target);

            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                continue;
            }

            if ((attributes & FileAttributes.Directory) != 0)
            {
                CopyTree(entry, target);
            }
            else
            {
                File.Copy(entry, target, overwrite: true);
            }
        }
    }

    private static void DeleteProgramFiles(string installDirectory, bool preserveData)
    {
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(installDirectory));
        if (!Directory.Exists(root))
        {
            return;
        }

        var dataDirectory = Path.Combine(root, "data");
        var errors = new List<string>();

        foreach (var entry in Directory.EnumerateFileSystemEntries(root))
        {
            if (preserveData && PathSafety.SamePath(entry, dataDirectory))
            {
                continue;
            }

            DeleteEntry(entry, root, errors);
        }

        if (errors.Count > 0)
        {
            var details = string.Join("; ", errors.Take(5));
            if (errors.Count > 5)
            {
                details += $"（另有 {errors.Count - 5} 个错误）";
            }

            throw new InstallerException($"删除程序文件失败：{details}");
        }
    }

    private static bool DeleteEntry(string path, string root, List<string> errors)
    {
        try
        {
            if (!PathSafety.IsSameOrInside(root, path) || PathSafety.SamePath(root, path))
            {
                errors.Add($"越界路径 {path}");
                return false;
            }

            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.Directory) != 0)
            {
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    Directory.Delete(path, recursive: false);
                    return true;
                }

                var childrenOk = true;
                foreach (var child in Directory.EnumerateFileSystemEntries(path))
                {
                    childrenOk &= DeleteEntry(child, root, errors);
                }

                if (!childrenOk)
                {
                    return false;
                }

                Directory.Delete(path, recursive: false);
                return true;
            }

            if ((attributes & FileAttributes.ReadOnly) != 0)
            {
                File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
            }

            File.Delete(path);
            return true;
        }
        catch (Exception ex)
        {
            errors.Add($"{path}: {ex.Message}");
            return false;
        }
    }

    private static void TryDeleteDirectory(string path, Action<string>? onError)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception ex)
        {
            onError?.Invoke($"{path}: {ex.Message}");
        }
    }

    private void WriteInstallRecord(string payloadSha256)
    {
        var record = new InstallRecord
        {
            Version = ProgramInfo.Version,
            InstalledAt = DateTime.UtcNow.ToString("o"),
            PayloadSha256 = payloadSha256,
        };
        record.Write(_installDir);
    }

    private void RelaunchApp(string message)
    {
        var executable = Path.Combine(_installDir, "MossStudio.exe");
        if (!File.Exists(executable))
        {
            throw new InstallerException("安装目录中缺少 MossStudio.exe，无法启动。");
        }

        Report("launch", 100, message);
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                WorkingDirectory = _installDir,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            throw new InstallerException($"启动 MossStudio 失败：{ex.Message}", ex);
        }
    }

    private static string SelfPath()
    {
        var path = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InstallerException("无法确定安装器自身路径。");
        }

        return Path.GetFullPath(path);
    }

    private int Fail(Exception exception)
    {
        LastError = exception.Message;
        ConsoleSupport.WriteError($"error: {exception.Message}");
        Report("error", 0, "操作失败。");
        ShowError(exception.Message);
        return 1;
    }

    private void Report(string phase, int percent, string message)
    {
        var clamped = Math.Clamp(percent, 0, 100);
        try
        {
            _progress?.Report(new InstallProgress(phase, clamped, message));
        }
        catch
        {
            // A UI progress handler must never break the installation.
        }

        if (_options.Mode == SetupMode.Gui || _options.Silent)
        {
            return;
        }

        string? consoleMessage = message;
        if (phase == "extract" && clamped != 100 && clamped % 10 != 0)
        {
            consoleMessage = null;
        }

        if (consoleMessage is null || string.Equals(consoleMessage, _lastConsoleMessage, StringComparison.Ordinal))
        {
            return;
        }

        _lastConsoleMessage = consoleMessage;
        ConsoleSupport.WriteLine(consoleMessage);
    }

    private void ShowError(string message, string? title = null)
    {
        if (_options.Silent || !Environment.UserInteractive)
        {
            return;
        }

        try
        {
            MessageBox.Show(message, title ?? "MossStudio 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch
        {
        }
    }

    private void ShowInfo(string message)
    {
        if (_options.Silent || !Environment.UserInteractive)
        {
            return;
        }

        try
        {
            MessageBox.Show(message, "MossStudio 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch
        {
        }
    }

    private sealed class UpdateLog : IDisposable
    {
        private readonly StreamWriter? _writer;

        public UpdateLog(string installDirectory, string version)
        {
            var fileName = $"update-{PathSafety.SanitizeFileName(version)}.log";
            try
            {
                var directory = Path.Combine(installDirectory, "data", "logs");
                Directory.CreateDirectory(directory);
                LogPath = Path.Combine(directory, fileName);
                _writer = new StreamWriter(
                    new FileStream(LogPath, FileMode.Append, FileAccess.Write, FileShare.Read),
                    new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
                {
                    AutoFlush = true,
                };
            }
            catch
            {
                LogPath = Path.Combine(installDirectory, "data", "logs", fileName);
                _writer = null;
            }
        }

        public string LogPath { get; }

        public void Info(string message) => Write("INFO", message);

        public void Error(string message) => Write("ERROR", message);

        public void Dispose()
        {
            try { _writer?.Dispose(); } catch { }
        }

        private void Write(string level, string message)
        {
            try
            {
                _writer?.WriteLine($"{DateTimeOffset.Now:o} [{level}] {message}");
            }
            catch
            {
            }
        }
    }
}
