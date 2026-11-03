using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MossStudio.Setup;

internal sealed class InstallRecord
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("installed_at")]
    public string InstalledAt { get; set; } = "";

    [JsonPropertyName("payload_sha256")]
    public string PayloadSha256 { get; set; } = "";

    public static string PathFor(string installDirectory) =>
        Path.Combine(installDirectory, "data", "install.json");

    public static InstallRecord? TryRead(string installDirectory)
    {
        try
        {
            var path = PathFor(installDirectory);
            if (!File.Exists(path))
            {
                return null;
            }

            var json = File.ReadAllText(path, Encoding.UTF8);
            var record = JsonSerializer.Deserialize<InstallRecord>(json, SerializerOptions);
            if (record is null || string.IsNullOrWhiteSpace(record.Version))
            {
                return null;
            }

            return record;
        }
        catch
        {
            return null;
        }
    }

    public void Write(string installDirectory)
    {
        var path = PathFor(installDirectory);
        var directory = Path.GetDirectoryName(path) ?? throw new InstallerException("安装记录路径无效。");
        Directory.CreateDirectory(directory);

        var json = JsonSerializer.Serialize(this, SerializerOptions) + Environment.NewLine;
        var temporary = Path.Combine(directory, $"install.json.{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(temporary, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception ex)
        {
            try { File.Delete(temporary); } catch { }
            throw new InstallerException($"写入安装记录失败：{path}（{ex.Message}）", ex);
        }
    }
}
