using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace MossStudio.Setup;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ConsoleSupport.Initialize();

        CliOptions options;
        try
        {
            options = CliOptions.Parse(args);
        }
        catch (UsageException ex)
        {
            ConsoleSupport.WriteError($"error: {ex.Message}");
            ConsoleSupport.WriteError(CliOptions.Usage);
            return 2;
        }

        if (options.ShowHelp)
        {
            ConsoleSupport.WriteLine(CliOptions.Usage);
            return 0;
        }

        if (options.Mode == SetupMode.Version)
        {
            ConsoleSupport.WriteLine(ProgramInfo.Version);
            return 0;
        }

        try
        {
            if (options.Mode == SetupMode.Gui)
            {
                // The GUI owns the process lifetime, but console output is still useful when
                // the same executable is started from a terminal without arguments.
                Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(ProgramInfo.Version, options.Directory));
                return 0;
            }

            if (options.Mode == SetupMode.Uninstall)
            {
                // The uninstaller usually runs from <InstallDir>\MossStudio-Setup.exe, which it
                // must delete. Hand the work to a temp copy, wait for this process to exit, and
                // return immediately. The copy is not a descendant of the application and is
                // not inside the directory it removes.
                var installDir = InstallLocator.ResolveUninstallDirectory(options.Directory, options.AllowSystemDirectory);
                options.Directory = installDir;
                if (SelfRelocation.IsRunningFromInstallDirectory(installDir))
                {
                    var childArgs = BuildUninstallChildArguments(options, installDir);
                    if (SelfRelocation.TryStartTempCopy(childArgs))
                    {
                        return 0;
                    }
                }
            }

            if (options.WaitForPid is int waitFor && waitFor > 0 && waitFor != Environment.ProcessId)
            {
                WaitForProcess(waitFor, TimeSpan.FromMinutes(1));
            }

            var engine = new InstallerEngine(options);
            return engine.Run();
        }
        catch (Exception ex)
        {
            ConsoleSupport.WriteError($"error: {ex.Message}");
            return 1;
        }
        finally
        {
            SelfRelocation.ScheduleSelfDelete();
        }
    }

    private static List<string> BuildUninstallChildArguments(CliOptions options, string installDir)
    {
        var args = new List<string> { "--uninstall", "--dir", installDir };
        if (options.Silent) args.Add("--silent");
        if (options.KeepData) args.Add("--keep-data");
        if (options.PurgeData) args.Add("--purge-data");
        if (options.AllowSystemDirectory) args.Add("--allow-system-dir");
        if (options.SkipShortcuts) args.Add("--skip-shortcuts");
        if (options.SkipRegistry) args.Add("--skip-registry");
        args.Add("--wait-for");
        args.Add(Environment.ProcessId.ToString());
        return args;
    }

    private static void WaitForProcess(int pid, TimeSpan timeout)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            process.WaitForExit(timeout);
        }
        catch (ArgumentException)
        {
            // Already exited.
        }
    }
}

internal static class ProgramInfo
{
    public const string ProductName = "MossStudio";
    public const string DisplayName = "MossStudio";
    public const string Publisher = "MossStudio";

    public static string Version { get; } = ResolveVersion();

    private static string ResolveVersion()
    {
        var assembly = typeof(ProgramInfo).Assembly;
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            var plus = informational.IndexOf('+');
            var value = (plus >= 0 ? informational[..plus] : informational).Trim();
            if (value.Length > 0)
            {
                return value;
            }
        }

        var version = assembly.GetName().Version;
        return version is null ? "0.0.0" : $"{version.Major}.{version.Minor}.{version.Build}";
    }
}

/// <summary>
/// A WinExe has no console of its own. When it is launched from a terminal (or its
/// output is redirected by a test harness) attach to the parent console and refresh
/// the standard writers so CLI modes can report results.
/// </summary>
internal static class ConsoleSupport
{
    private const int AttachParentProcess = -1;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    public static bool IsAttached { get; private set; }

    public static void Initialize()
    {
        try
        {
            if (AttachConsole(AttachParentProcess))
            {
                IsAttached = true;
                try
                {
                    Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), Console.OutputEncoding) { AutoFlush = true });
                }
                catch
                {
                    // Redirected handles still work through the default writer.
                }

                try
                {
                    Console.SetError(new StreamWriter(Console.OpenStandardError(), Console.OutputEncoding) { AutoFlush = true });
                }
                catch
                {
                }
            }
        }
        catch
        {
            // No console, no problem.
        }
    }

    public static void WriteLine(string text)
    {
        try { Console.WriteLine(text); } catch { }
    }

    public static void WriteError(string text)
    {
        try { Console.Error.WriteLine(text); } catch { }
    }
}
