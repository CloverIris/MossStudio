using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace MossStudio.Setup;

internal sealed class MainForm : Form
{
    private readonly string _version;
    private readonly TextBox _directoryBox;
    private readonly Button _browseButton;
    private readonly Button _installButton;
    private readonly Button _updateButton;
    private readonly Button _uninstallButton;
    private readonly ProgressBar _progressBar;
    private readonly Label _statusLabel;
    private readonly Label _detectedLabel;
    private bool _busy;

    public MainForm(string version, string? initialDirectory)
    {
        _version = version;

        Text = "MossStudio 安装程序";
        ClientSize = new Size(680, 410);
        MinimumSize = new Size(680, 410);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        Font = SystemFonts.MessageBoxFont;
        AutoScaleMode = AutoScaleMode.Dpi;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24, 20, 24, 20),
            ColumnCount = 1,
            RowCount = 4,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 1,
            RowCount = 2,
            Margin = new Padding(0, 0, 0, 18),
        };
        var title = new Label
        {
            Text = "MossStudio",
            Font = new Font(Font.FontFamily, 20F, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 2),
        };
        var subtitle = new Label
        {
            Text = $"安装程序 · 版本 {_version}",
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
            Margin = new Padding(0),
        };
        header.Controls.Add(title, 0, 0);
        header.Controls.Add(subtitle, 0, 1);

        var directoryRow = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 3,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 14),
        };
        directoryRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        directoryRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        directoryRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var directoryLabel = new Label
        {
            Text = "安装位置",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 0, 12, 0),
        };
        _directoryBox = new TextBox
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 8, 0),
        };
        _browseButton = new Button
        {
            Text = "浏览…",
            AutoSize = true,
            MinimumSize = new Size(88, 28),
            Margin = new Padding(0),
        };
        directoryRow.Controls.Add(directoryLabel, 0, 0);
        directoryRow.Controls.Add(_directoryBox, 1, 0);
        directoryRow.Controls.Add(_browseButton, 2, 0);

        var statusPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Margin = new Padding(0),
        };
        statusPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        _detectedLabel = new Label
        {
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 10),
        };
        _progressBar = new ProgressBar
        {
            Dock = DockStyle.Top,
            Height = 18,
            Minimum = 0,
            Maximum = 100,
            Style = ProgressBarStyle.Continuous,
            Margin = new Padding(0, 0, 0, 10),
        };
        _statusLabel = new Label
        {
            Dock = DockStyle.Fill,
            Text = "准备就绪。",
            ForeColor = SystemColors.ControlText,
            Margin = new Padding(0),
        };
        statusPanel.Controls.Add(_detectedLabel, 0, 0);
        statusPanel.Controls.Add(_progressBar, 0, 1);
        statusPanel.Controls.Add(_statusLabel, 0, 2);

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Margin = new Padding(0, 12, 0, 0),
        };
        _installButton = new Button
        {
            Text = "安装",
            AutoSize = true,
            MinimumSize = new Size(96, 34),
            Margin = new Padding(8, 0, 0, 0),
        };
        _updateButton = new Button
        {
            Text = "更新",
            AutoSize = true,
            MinimumSize = new Size(96, 34),
            Margin = new Padding(8, 0, 0, 0),
        };
        _uninstallButton = new Button
        {
            Text = "卸载",
            AutoSize = true,
            MinimumSize = new Size(96, 34),
            Margin = new Padding(8, 0, 0, 0),
        };
        buttons.Controls.Add(_installButton);
        buttons.Controls.Add(_updateButton);
        buttons.Controls.Add(_uninstallButton);

        layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(directoryRow, 0, 1);
        layout.Controls.Add(statusPanel, 0, 2);
        layout.Controls.Add(buttons, 0, 3);
        Controls.Add(layout);
        AcceptButton = _installButton;

        var setupDirectory = InstallLocator.SafeDirectoryName(Environment.ProcessPath);
        _directoryBox.Text = InstallLocator.FindInitialDirectory(initialDirectory, setupDirectory);

        _browseButton.Click += (_, _) => BrowseForDirectory();
        _directoryBox.TextChanged += (_, _) => DetectExistingInstall();
        _installButton.Click += async (_, _) => await InstallAsync();
        _updateButton.Click += async (_, _) => await UpdateAsync();
        _uninstallButton.Click += async (_, _) => await UninstallAsync();
        FormClosing += OnFormClosing;

        DetectExistingInstall();
    }

    private void BrowseForDirectory()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择 MossStudio 安装目录",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
        };

        var current = _directoryBox.Text.Trim();
        if (Directory.Exists(current))
        {
            dialog.SelectedPath = current;
        }

        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _directoryBox.Text = dialog.SelectedPath;
        }
    }

    private void DetectExistingInstall()
    {
        if (_busy)
        {
            return;
        }

        string directory;
        try
        {
            var value = _directoryBox.Text.Trim();
            if (value.Length == 0)
            {
                _detectedLabel.Text = "请选择安装目录。";
                _detectedLabel.ForeColor = SystemColors.GrayText;
                _updateButton.Enabled = false;
                _uninstallButton.Enabled = false;
                return;
            }

            directory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        }
        catch
        {
            _detectedLabel.Text = "安装目录无效。";
            _detectedLabel.ForeColor = Color.Firebrick;
            _updateButton.Enabled = false;
            _uninstallButton.Enabled = false;
            return;
        }

        var installed = InstallLocator.IsInstallDirectory(directory);
        var installedVersion = installed ? InstallLocator.ReadInstalledVersion(directory) : null;

        if (installed)
        {
            _detectedLabel.Text = installedVersion is null
                ? "检测到已有安装。"
                : $"检测到已安装版本 {installedVersion}。";
            if (string.Equals(installedVersion, _version, StringComparison.OrdinalIgnoreCase))
            {
                _detectedLabel.Text += "（已是此版本）";
            }

            _detectedLabel.ForeColor = Color.ForestGreen;
        }
        else
        {
            _detectedLabel.Text = "未检测到安装，将进行全新安装。";
            _detectedLabel.ForeColor = SystemColors.GrayText;
        }

        _updateButton.Enabled = installed;
        _uninstallButton.Enabled = installed;
        _installButton.Enabled = true;
    }

    private async Task InstallAsync()
    {
        if (_busy)
        {
            return;
        }

        var directory = ValidateDirectory();
        if (directory is null)
        {
            return;
        }

        var options = new CliOptions
        {
            Mode = SetupMode.Install,
            Directory = directory,
            Silent = true,
            Launch = true,
        };
        await ExecuteAsync(options, "安装");
    }

    private async Task UpdateAsync()
    {
        if (_busy)
        {
            return;
        }

        var directory = ValidateDirectory();
        if (directory is null)
        {
            return;
        }

        if (!InstallLocator.IsInstallDirectory(directory))
        {
            MessageBox.Show(
                this,
                "目标目录中没有检测到 MossStudio 安装。\n请使用“安装”进行全新安装。",
                "MossStudio",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        var installedVersion = InstallLocator.ReadInstalledVersion(directory);
        if (string.Equals(installedVersion, _version, StringComparison.OrdinalIgnoreCase))
        {
            var answer = MessageBox.Show(
                this,
                $"当前已是 {_version}。是否重新安装当前版本？",
                "MossStudio",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (answer != DialogResult.Yes)
            {
                return;
            }
        }

        var running = FindRunningApplication(directory);
        if (running is not null)
        {
            using (running)
            {
                var answer = MessageBox.Show(
                    this,
                    "MossStudio 正在运行，是否关闭并更新？",
                    "MossStudio",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (answer != DialogResult.Yes)
                {
                    return;
                }

                try
                {
                    if (!running.HasExited)
                    {
                        running.Kill();
                        running.WaitForExit(TimeSpan.FromSeconds(10));
                    }
                }
                catch
                {
                    // The update engine will fail and roll back if files stay locked.
                }
            }
        }

        var options = new CliOptions
        {
            Mode = SetupMode.Update,
            Directory = directory,
            Silent = true,
            Relaunch = true,
        };
        await ExecuteAsync(options, "更新");
    }

    private async Task UninstallAsync()
    {
        if (_busy)
        {
            return;
        }

        var directory = ValidateDirectory();
        if (directory is null)
        {
            return;
        }

        if (MessageBox.Show(
                this,
                "确定要卸载 MossStudio 吗？",
                "MossStudio",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning) != DialogResult.Yes)
        {
            return;
        }

        var dataChoice = MessageBox.Show(
            this,
            "是否同时删除用户数据（data 目录，包含模型与作品）？\n\n" +
            "是：删除数据\n否：保留数据\n取消：放弃卸载",
            "MossStudio",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Question);
        if (dataChoice == DialogResult.Cancel)
        {
            return;
        }

        var purgeData = dataChoice == DialogResult.Yes;

        if (SelfRelocation.IsRunningFromInstallDirectory(directory))
        {
            // This process is the installed uninstaller copy; a temp copy waits for us
            // to exit and then removes the program files, including this exe.
            var childArguments = new List<string> { "--uninstall", "--dir", directory };
            childArguments.Add(purgeData ? "--purge-data" : "--keep-data");
            childArguments.Add("--wait-for");
            childArguments.Add(Environment.ProcessId.ToString());
            if (SelfRelocation.TryStartTempCopy(childArguments))
            {
                Close();
                return;
            }
        }

        var options = new CliOptions
        {
            Mode = SetupMode.Uninstall,
            Directory = directory,
            Silent = true,
            PurgeData = purgeData,
            KeepData = !purgeData,
        };
        await ExecuteAsync(options, "卸载");
    }

    private async Task ExecuteAsync(CliOptions options, string action)
    {
        SetBusy(true);
        _progressBar.Style = ProgressBarStyle.Marquee;
        _progressBar.Value = 0;
        _statusLabel.Text = $"{action}…";

        var progress = new Progress<InstallProgress>(update =>
        {
            if (string.Equals(update.Phase, "extract", StringComparison.Ordinal))
            {
                _progressBar.Style = ProgressBarStyle.Continuous;
                _progressBar.Value = Math.Clamp(update.Percent, 0, 100);
            }
            else if (string.Equals(update.Phase, "done", StringComparison.Ordinal) ||
                     string.Equals(update.Phase, "launch", StringComparison.Ordinal))
            {
                _progressBar.Style = ProgressBarStyle.Continuous;
                _progressBar.Value = Math.Clamp(update.Percent, 0, 100);
            }

            _statusLabel.Text = update.Message;
        });

        try
        {
            var engine = new InstallerEngine(options, progress);
            // Shortcut creation uses WScript.Shell COM, which expects an STA thread.
            var exitCode = await Task.Run(() => RunEngineOnStaThread(engine));
            if (exitCode == 0)
            {
                _progressBar.Style = ProgressBarStyle.Continuous;
                _progressBar.Value = 100;
                _statusLabel.Text = $"{action}完成。";
            }
            else
            {
                _statusLabel.Text = $"{action}失败。";
                var detail = engine.LastError ?? "请检查安装目录权限后重试。";
                var logSuffix = string.IsNullOrWhiteSpace(engine.LastLogPath)
                    ? ""
                    : $"\n\n日志：{engine.LastLogPath}";
                MessageBox.Show(
                    this,
                    $"{action}失败：\n{detail}{logSuffix}",
                    "MossStudio",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }
        catch (Exception ex)
        {
            _statusLabel.Text = $"{action}失败。";
            MessageBox.Show(
                this,
                $"{action}失败：\n{ex.Message}",
                "MossStudio",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private static int RunEngineOnStaThread(InstallerEngine engine)
    {
        var exitCode = 1;
        Exception? failure = null;
        var thread = new System.Threading.Thread(() =>
        {
            try
            {
                exitCode = engine.Run();
            }
            catch (Exception ex)
            {
                failure = ex;
            }
        })
        {
            IsBackground = true,
            Name = "MossStudio installer engine",
        };
        thread.SetApartmentState(System.Threading.ApartmentState.STA);
        thread.Start();
        thread.Join();

        if (failure is not null)
        {
            throw failure;
        }

        return exitCode;
    }

    private string? ValidateDirectory()
    {
        try
        {
            return PathSafety.ResolveInstallDirectory(_directoryBox.Text.Trim(), allowSystemDirectory: false);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                ex.Message,
                "MossStudio",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return null;
        }
    }

    private static Process? FindRunningApplication(string directory)
    {
        try
        {
            foreach (var process in Process.GetProcessesByName("MossStudio"))
            {
                try
                {
                    if (process.HasExited)
                    {
                        process.Dispose();
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

                    if (executablePath is null || PathSafety.IsSameOrInside(directory, executablePath))
                    {
                        return process;
                    }
                }
                catch
                {
                }

                process.Dispose();
            }
        }
        catch
        {
        }

        return null;
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        _directoryBox.Enabled = !busy;
        _browseButton.Enabled = !busy;
        _installButton.Enabled = !busy;
        _updateButton.Enabled = !busy;
        _uninstallButton.Enabled = !busy;
        UseWaitCursor = busy;
        if (!busy)
        {
            _progressBar.Style = ProgressBarStyle.Continuous;
            DetectExistingInstall();
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_busy)
        {
            return;
        }

        e.Cancel = true;
        MessageBox.Show(
            this,
            "请等待当前操作完成。",
            "MossStudio",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }
}
