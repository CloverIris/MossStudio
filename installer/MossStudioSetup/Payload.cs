using System.Buffers;
using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace MossStudio.Setup;

internal sealed record PayloadInfo(string ExePath, long Offset, long Size, string Sha256);

internal sealed record PayloadExtraction(string Sha256, int FileCount, long ByteCount, int SkippedDataEntries);

/// <summary>
/// Reads and verifies the payload appended to the installer executable.
///
/// Layout (96-byte trailer at the very end of the exe):
///   magic   8 bytes  ASCII "MSSTUDIO"
///   offset  8 bytes  Int64 little-endian, absolute offset of the ZIP in the exe
///   size    8 bytes  Int64 little-endian, ZIP byte length
///   sha256 64 bytes  ASCII lowercase hex of the ZIP bytes
///   reserved 8 bytes zero
/// </summary>
internal sealed class PayloadArchive : IDisposable
{
    public const int TrailerSize = 96;
    public const string Magic = "MSSTUDIO";
    public const int Sha256HexLength = 64;
    private const int HashBufferSize = 1024 * 1024;

    private readonly ZipArchive _archive;

    private PayloadArchive(PayloadInfo info, ZipArchive archive)
    {
        Info = info;
        _archive = archive;
    }

    public PayloadInfo Info { get; }

    public static PayloadArchive Open(string exePath)
    {
        var info = ReadAndVerify(exePath);
        FileStream file;
        try
        {
            file = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        }
        catch (Exception ex)
        {
            throw new InstallerException($"无法打开安装器文件：{exePath}（{ex.Message}）", ex);
        }

        var subStream = new SubStream(file, info.Offset, info.Size);
        try
        {
            var archive = new ZipArchive(subStream, ZipArchiveMode.Read, leaveOpen: false);
            return new PayloadArchive(info, archive);
        }
        catch (Exception ex)
        {
            subStream.Dispose();
            throw new InstallerException($"安装包 ZIP 无法读取，文件可能已损坏：{ex.Message}", ex);
        }
    }

    public static PayloadInfo ReadAndVerify(string exePath)
    {
        var fullPath = Path.GetFullPath(exePath);
        using var file = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        var fileLength = file.Length;
        if (fileLength < TrailerSize)
        {
            throw new InstallerException("安装器文件过短，缺少 payload trailer。");
        }

        var trailer = new byte[TrailerSize];
        file.Seek(-TrailerSize, SeekOrigin.End);
        ReadExactly(file, trailer, TrailerSize);

        var magic = Encoding.ASCII.GetString(trailer, 0, 8);
        if (!string.Equals(magic, Magic, StringComparison.Ordinal))
        {
            throw new InstallerException("安装器 trailer 无效：magic 不匹配。");
        }

        var offset = BinaryPrimitives.ReadInt64LittleEndian(trailer.AsSpan(8, 8));
        var size = BinaryPrimitives.ReadInt64LittleEndian(trailer.AsSpan(16, 8));
        var sha256 = Encoding.ASCII.GetString(trailer, 24, Sha256HexLength).ToLowerInvariant();

        for (var i = 88; i < TrailerSize; i++)
        {
            if (trailer[i] != 0)
            {
                throw new InstallerException("安装器 trailer 无效：保留字段必须为零。");
            }
        }

        if (offset < 0 || size <= 0)
        {
            throw new InstallerException("安装器 trailer 无效：payload 偏移或长度非法。");
        }

        var remaining = fileLength - TrailerSize - offset;
        if (offset > fileLength - TrailerSize || size > remaining || size != remaining)
        {
            throw new InstallerException("安装器 trailer 无效：payload 偏移/长度与文件大小不一致。");
        }

        if (sha256.Length != Sha256HexLength || !sha256.All(Uri.IsHexDigit))
        {
            throw new InstallerException("安装器 trailer 无效：SHA-256 不是 64 位十六进制字符串。");
        }

        var actual = ComputeSha256(file, offset, size);
        if (!string.Equals(actual, sha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InstallerException(
                $"安装包校验失败：期望 {sha256}，实际 {actual}。文件可能已损坏或被篡改。");
        }

        return new PayloadInfo(fullPath, offset, size, sha256);
    }

    public PayloadExtraction ExtractTo(string installDirectory, Action<int>? progress = null)
    {
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(installDirectory));
        Directory.CreateDirectory(root);

        var plans = new List<EntryPlan>();
        var checkedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hasExecutable = false;
        var hasAsar = false;
        var skippedDataEntries = 0;
        long totalBytes = 0;

        foreach (var entry in _archive.Entries)
        {
            var normalized = entry.FullName
                .Replace('/', Path.DirectorySeparatorChar)
                .Replace('\\', Path.DirectorySeparatorChar);

            if (normalized.Length == 0)
            {
                continue;
            }

            if (normalized.Contains('\0') || normalized.Contains(':'))
            {
                throw new InstallerException($"安装包包含非法路径：{entry.FullName}");
            }

            if (Path.IsPathRooted(normalized))
            {
                throw new InstallerException($"安装包包含绝对路径：{entry.FullName}");
            }

            var parts = normalized.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                continue;
            }

            if (parts.Any(part => part == ".." || part == "."))
            {
                throw new InstallerException($"安装包包含越界路径：{entry.FullName}");
            }

            if (parts[0].Equals("data", StringComparison.OrdinalIgnoreCase))
            {
                // data/ belongs to the user and is never overwritten by an installer.
                skippedDataEntries++;
                continue;
            }

            var relativePath = string.Join(Path.DirectorySeparatorChar, parts);
            var target = Path.GetFullPath(Path.Combine(root, relativePath));
            PathSafety.EnsureInside(root, target);
            EnsureNoReparsePointAncestor(root, target, checkedDirectories);

            var relativeKey = relativePath.ToLowerInvariant();
            if (relativeKey == "mossstudio.exe")
            {
                hasExecutable = true;
            }
            else if (relativeKey == Path.Combine("resources", "app.asar").ToLowerInvariant())
            {
                hasAsar = true;
            }

            var isDirectory = string.IsNullOrEmpty(entry.Name);
            if (!isDirectory)
            {
                totalBytes += entry.Length;
            }

            plans.Add(new EntryPlan(entry, target, isDirectory));
        }

        if (!hasExecutable || !hasAsar)
        {
            throw new InstallerException("安装包不是有效的 MossStudio 程序包：缺少 MossStudio.exe 或 resources\\app.asar。");
        }

        var fileCount = 0;
        long processedBytes = 0;
        var lastPercent = -1;

        foreach (var plan in plans)
        {
            if (plan.IsDirectory)
            {
                Directory.CreateDirectory(plan.TargetPath);
                continue;
            }

            var parent = Path.GetDirectoryName(plan.TargetPath);
            if (parent is not null)
            {
                Directory.CreateDirectory(parent);
            }

            if (File.Exists(plan.TargetPath))
            {
                var attributes = File.GetAttributes(plan.TargetPath);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    // Replace a file symlink instead of writing through it.
                    File.Delete(plan.TargetPath);
                }
                else if ((attributes & FileAttributes.ReadOnly) != 0)
                {
                    File.SetAttributes(plan.TargetPath, attributes & ~FileAttributes.ReadOnly);
                }
            }

            try
            {
                plan.Entry.ExtractToFile(plan.TargetPath, overwrite: true);
            }
            catch (Exception ex)
            {
                throw new InstallerException($"解压文件失败：{plan.Entry.FullName}（{ex.Message}）", ex);
            }

            try
            {
                File.SetLastWriteTimeUtc(plan.TargetPath, plan.Entry.LastWriteTime.UtcDateTime);
            }
            catch
            {
                // Timestamps are cosmetic.
            }

            fileCount++;
            processedBytes += plan.Entry.Length;
            var percent = totalBytes <= 0
                ? 100
                : (int)Math.Min(100, processedBytes * 100 / totalBytes);
            if (percent != lastPercent)
            {
                lastPercent = percent;
                progress?.Invoke(percent);
            }
        }

        var executable = Path.Combine(root, "MossStudio.exe");
        if (!File.Exists(executable))
        {
            throw new InstallerException("解压完成后缺少 MossStudio.exe。");
        }

        progress?.Invoke(100);
        return new PayloadExtraction(Info.Sha256, fileCount, processedBytes, skippedDataEntries);
    }

    public void Dispose()
    {
        _archive.Dispose();
    }

    private static void EnsureNoReparsePointAncestor(string root, string target, HashSet<string> checkedDirectories)
    {
        var parent = Path.GetDirectoryName(target);
        while (!string.IsNullOrEmpty(parent) &&
               PathSafety.IsSameOrInside(root, parent) &&
               !PathSafety.SamePath(root, parent))
        {
            if (checkedDirectories.Add(parent) &&
                Directory.Exists(parent) &&
                (File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InstallerException($"安装目标包含链接目录，拒绝写入：{parent}");
            }

            parent = Path.GetDirectoryName(parent);
        }
    }

    private static string ComputeSha256(FileStream file, long offset, long size)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(HashBufferSize);
        try
        {
            file.Position = offset;
            var remaining = size;
            while (remaining > 0)
            {
                var toRead = (int)Math.Min(buffer.Length, remaining);
                var read = file.Read(buffer, 0, toRead);
                if (read <= 0)
                {
                    throw new InstallerException("计算 payload 哈希时文件意外结束。");
                }

                hash.AppendData(buffer, 0, read);
                remaining -= read;
            }

            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int count)
    {
        var offset = 0;
        while (offset < count)
        {
            var read = stream.Read(buffer, offset, count - offset);
            if (read <= 0)
            {
                throw new InstallerException("安装器文件被截断。");
            }

            offset += read;
        }
    }

    private sealed record EntryPlan(ZipArchiveEntry Entry, string TargetPath, bool IsDirectory);

    /// <summary>A seekable window over the exe so ZipArchive can read the appended ZIP in place.</summary>
    private sealed class SubStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _start;
        private readonly long _length;
        private long _position;

        public SubStream(Stream inner, long start, long length)
        {
            _inner = inner;
            _start = start;
            _length = length;
        }

        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => _length;

        public override long Position
        {
            get => _position;
            set => _position = value;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_position >= _length)
            {
                return 0;
            }

            var toRead = (int)Math.Min(count, _length - _position);
            _inner.Position = _start + _position;
            var read = _inner.Read(buffer, offset, toRead);
            _position += read;
            return read;
        }

        public override int Read(Span<byte> buffer)
        {
            if (_position >= _length)
            {
                return 0;
            }

            var toRead = (int)Math.Min(buffer.Length, _length - _position);
            _inner.Position = _start + _position;
            var read = _inner.Read(buffer[..toRead]);
            _position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            var next = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => _position + offset,
                SeekOrigin.End => _length + offset,
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };

            if (next < 0)
            {
                throw new IOException("尝试在 payload 起始位置之前定位。");
            }

            _position = next;
            return _position;
        }

        public override void Flush()
        {
        }

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _inner.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
