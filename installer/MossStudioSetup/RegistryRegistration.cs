using Microsoft.Win32;

namespace MossStudio.Setup;

internal static class RegistryRegistration
{
    public const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\MossStudio";

    public static bool TryRegister(string installDirectory, string version, bool allowSystemDirectory, out string? error)
    {
        try
        {
            var executable = Path.Combine(installDirectory, "MossStudio.exe");
            var setupCopy = Path.Combine(installDirectory, "MossStudio-Setup.exe");
            var allowFlag = allowSystemDirectory ? " --allow-system-dir" : "";
            var uninstallCommand = $"\"{setupCopy}\" --uninstall --dir \"{installDirectory}\"{allowFlag}";
            var quietUninstallCommand = $"{uninstallCommand} --silent";

            using var key = Registry.CurrentUser.CreateSubKey(UninstallKeyPath, writable: true);
            if (key is null)
            {
                error = "无法创建卸载注册表项。";
                return false;
            }

            key.SetValue("DisplayName", ProgramInfo.DisplayName, RegistryValueKind.String);
            key.SetValue("DisplayVersion", version, RegistryValueKind.String);
            key.SetValue("Publisher", ProgramInfo.Publisher, RegistryValueKind.String);
            key.SetValue("InstallLocation", installDirectory, RegistryValueKind.String);
            key.SetValue("DisplayIcon", executable + ",0", RegistryValueKind.String);
            key.SetValue("UninstallString", uninstallCommand, RegistryValueKind.String);
            key.SetValue("QuietUninstallString", quietUninstallCommand, RegistryValueKind.String);
            key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"), RegistryValueKind.String);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);

            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public static string? TryReadInstallLocation()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(UninstallKeyPath);
            return key?.GetValue("InstallLocation") as string;
        }
        catch
        {
            return null;
        }
    }

    public static bool TryRemove(out string? error)
    {
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKeyPath, throwOnMissingSubKey: false);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }
}
