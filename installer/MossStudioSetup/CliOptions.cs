namespace MossStudio.Setup;

internal enum SetupMode
{
    Gui,
    Install,
    Update,
    Uninstall,
    Version,
}

internal sealed class UsageException : Exception
{
    public UsageException(string message) : base(message)
    {
    }
}

internal sealed class CliOptions
{
    public SetupMode Mode { get; set; } = SetupMode.Gui;
    public string? Directory { get; set; }
    public bool Silent { get; set; }
    public bool Launch { get; set; }
    public bool Relaunch { get; set; } = true;
    public bool KeepData { get; set; }
    public bool PurgeData { get; set; }
    public bool AllowSystemDirectory { get; set; }
    public bool SkipShortcuts { get; set; }
    public bool SkipRegistry { get; set; }
    public int? Pid { get; set; }
    public int? WaitForPid { get; set; }
    public bool Relocated { get; set; }
    public bool ShowHelp { get; set; }

    public const string Usage = """
        MossStudio 安装程序

        用法：
          MossStudio-Setup.exe                                  打开安装向导
          MossStudio-Setup.exe --install [--dir <目录>] [--silent] [--launch]
          MossStudio-Setup.exe --update --dir <目录> --pid <进程号> [--relaunch=false]
          MossStudio-Setup.exe --uninstall [--dir <目录>] [--keep-data|--purge-data] [--silent]
          MossStudio-Setup.exe --version

        选项：
          --dir <目录>          安装目录（默认 %LOCALAPPDATA%\Programs\MossStudio）
          --silent             不显示任何对话框
          --launch             安装成功后启动 MossStudio
          --relaunch=false     更新成功后不启动 MossStudio
          --keep-data          卸载时保留 data 目录（默认）
          --purge-data         卸载时删除 data 目录
          --allow-system-dir   允许安装到 Windows / Program Files 等系统目录
          --skip-shortcuts     不创建或删除桌面/开始菜单快捷方式（测试用）
          --skip-registry      不写入或删除卸载注册表项（测试用）
          --help               显示此帮助
        """;

    public static CliOptions Parse(string[] args)
    {
        var options = new CliOptions();
        var modeSet = false;

        for (var i = 0; i < args.Length; i++)
        {
            var raw = args[i];
            if (string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }

            var argument = raw.Trim();
            if (argument.Length >= 2 && argument[0] == '"' && argument[^1] == '"')
            {
                argument = argument[1..^1];
            }

            var (name, inlineValue) = SplitOption(argument);
            switch (name.ToLowerInvariant())
            {
                case "--install":
                    SetMode(options, SetupMode.Install, ref modeSet);
                    break;
                case "--update":
                    SetMode(options, SetupMode.Update, ref modeSet);
                    break;
                case "--uninstall":
                    SetMode(options, SetupMode.Uninstall, ref modeSet);
                    break;
                case "--version":
                    SetMode(options, SetupMode.Version, ref modeSet);
                    break;
                case "--gui":
                    SetMode(options, SetupMode.Gui, ref modeSet);
                    break;
                case "--dir":
                    options.Directory = NormalizeValue(inlineValue ?? NextValue(args, ref i, "--dir"));
                    break;
                case "--pid":
                    options.Pid = ParsePositiveInt(inlineValue ?? NextValue(args, ref i, "--pid"), "--pid");
                    break;
                case "--wait-for":
                    options.WaitForPid = ParsePositiveInt(inlineValue ?? NextValue(args, ref i, "--wait-for"), "--wait-for");
                    break;
                case "--silent":
                    options.Silent = true;
                    break;
                case "--launch":
                    options.Launch = true;
                    break;
                case "--relaunch":
                    options.Relaunch = inlineValue is null || ParseBool(inlineValue, "--relaunch");
                    break;
                case "--no-relaunch":
                    options.Relaunch = false;
                    break;
                case "--keep-data":
                    options.KeepData = true;
                    break;
                case "--purge-data":
                    options.PurgeData = true;
                    break;
                case "--allow-system-dir":
                    options.AllowSystemDirectory = true;
                    break;
                case "--skip-shortcuts":
                    options.SkipShortcuts = true;
                    break;
                case "--skip-registry":
                    options.SkipRegistry = true;
                    break;
                case "--relocated":
                    options.Relocated = true;
                    break;
                case "--help":
                case "-h":
                case "/?":
                case "/help":
                    options.ShowHelp = true;
                    break;
                default:
                    throw new UsageException($"未知参数：{raw}");
            }
        }

        if (options.KeepData && options.PurgeData)
        {
            throw new UsageException("--keep-data 与 --purge-data 不能同时使用。");
        }

        if (options.Mode == SetupMode.Update && string.IsNullOrWhiteSpace(options.Directory))
        {
            throw new UsageException("--update 需要 --dir <目录>。");
        }

        return options;
    }

    private static void SetMode(CliOptions options, SetupMode mode, ref bool modeSet)
    {
        if (modeSet && options.Mode != mode)
        {
            throw new UsageException($"模式参数冲突：{options.Mode} 与 {mode}。");
        }

        options.Mode = mode;
        modeSet = true;
    }

    private static (string Name, string? Value) SplitOption(string argument)
    {
        var equals = argument.IndexOf('=');
        if (equals < 0)
        {
            return (argument, null);
        }

        var name = argument[..equals];
        var value = argument[(equals + 1)..];
        if (value.Length == 0)
        {
            throw new UsageException($"参数 {name} 缺少值。");
        }

        return (name, value);
    }

    private static string NextValue(string[] args, ref int index, string name)
    {
        if (index + 1 >= args.Length)
        {
            throw new UsageException($"参数 {name} 缺少值。");
        }

        var value = args[++index];
        if (string.IsNullOrWhiteSpace(value) || value.StartsWith("--", StringComparison.Ordinal))
        {
            throw new UsageException($"参数 {name} 缺少值。");
        }

        return value.Trim();
    }

    private static string NormalizeValue(string value)
    {
        var result = value.Trim();
        if (result.Length >= 2 && result[0] == '"' && result[^1] == '"')
        {
            result = result[1..^1];
        }

        return result;
    }

    private static int ParsePositiveInt(string value, string name)
    {
        if (!int.TryParse(value, out var result) || result <= 0)
        {
            throw new UsageException($"参数 {name} 需要一个正整数，收到：{value}");
        }

        return result;
    }

    private static bool ParseBool(string value, string name)
    {
        if (bool.TryParse(value, out var result))
        {
            return result;
        }

        if (value == "1")
        {
            return true;
        }

        if (value == "0")
        {
            return false;
        }

        throw new UsageException($"参数 {name} 需要 true 或 false，收到：{value}");
    }
}
