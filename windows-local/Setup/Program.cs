using System.Diagnostics;
using System.Reflection;

namespace OpenBotFree.Setup;

internal static class Program
{
    internal const string AppName = "OpenBot-free";
    internal const string AppExe = "OpenBotFree.exe";
    internal const string SetupExe = "OpenBotFreeSetup.exe";
    private const string WorkerPrefix = "OpenBotFree-Uninstall-";
    internal static readonly string AppVersion = typeof(Program).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion;
    internal static readonly string DefaultLocation = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);

    [STAThread]
    private static int Main(string[] args)
    {
        bool isolated = args is ["--install" or "--uninstall", "--location", _];
        bool worker = args is ["--uninstall-worker", _];
        try
        {
            if (isolated)
            {
                var installation = new Installation(args[2], isolated: true);
                if (args[0] == "--install")
                    installation.Install();
                else
                    installation.Uninstall();
                return 0;
            }

            ApplicationConfiguration.Initialize();
            var production = new Installation(DefaultLocation, isolated: false);
            if (worker && int.TryParse(args[1], out int parentId) && parentId > 0)
            {
                ScheduleWorkerCleanup();
                WaitForParent(parentId);
                production.Uninstall();
                MessageBox.Show("OpenBot-free foi removido. Os dados do perfil foram preservados.",
                    AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }

            if (args is ["--uninstall"])
            {
                if (MessageBox.Show("Remover o OpenBot-free deste computador? Os dados do perfil serão preservados.",
                    AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
                {
                    StartUninstaller();
                }
                return 0;
            }

            if (args.Length != 0)
                throw new ArgumentException("Comando de instalação desconhecido.");

            Application.Run(new SetupForm(production));
            return 0;
        }
        catch (Exception ex)
        {
            if (isolated)
                Console.Error.WriteLine(ex.Message);
            else
                ShowError(ex);
            return 1;
        }
    }

    private static void StartUninstaller()
    {
        string source = Environment.ProcessPath ?? throw new InvalidOperationException("Não foi possível localizar o instalador.");
        string worker = Path.Combine(Path.GetTempPath(), $"{WorkerPrefix}{Guid.NewGuid():N}.exe");
        File.Copy(source, worker);
        try
        {
            var start = new ProcessStartInfo(worker) { UseShellExecute = false };
            start.ArgumentList.Add("--uninstall-worker");
            start.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            using Process? process = Process.Start(start);
            if (process is null)
                throw new InvalidOperationException("Não foi possível abrir o desinstalador.");
        }
        catch
        {
            File.Delete(worker);
            throw;
        }
    }

    private static void ScheduleWorkerCleanup()
    {
        string? worker = Environment.ProcessPath;
        string temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        if (worker is null || !string.Equals(Path.GetDirectoryName(worker), temp, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(worker).StartsWith(WorkerPrefix, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Abra o desinstalador pelo menu Aplicativos do Windows.");
        }

        const string cleanup = """
            $workerPid = [int]$env:OPENBOT_SETUP_CLEANUP_PID
            $workerPath = $env:OPENBOT_SETUP_CLEANUP_PATH
            if ((Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) {
                Wait-Process -Id $workerPid -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $workerPath -ErrorAction SilentlyContinue
            """;
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,
            "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (string argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
            Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(cleanup)) })
        {
            start.ArgumentList.Add(argument);
        }

        start.Environment["OPENBOT_SETUP_CLEANUP_PID"] =
            Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["OPENBOT_SETUP_CLEANUP_PATH"] = worker;
        try { using Process? _ = Process.Start(start); }
        catch (System.ComponentModel.Win32Exception)
        {
            // Cleanup is optional on systems that disable Windows PowerShell.
        }
    }

    private static void WaitForParent(int parentId)
    {
        try
        {
            using var parent = Process.GetProcessById(parentId);
            if (!parent.WaitForExit(15000))
                throw new IOException("Feche o instalador do OpenBot-free e tente novamente.");
        }
        catch (ArgumentException)
        {
            // The initiating process has already exited.
        }
    }

    internal static void ShowError(Exception error) =>
        MessageBox.Show(error.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
}

internal sealed class SetupForm : Form
{
    internal SetupForm(Installation installation)
    {
        Text = $"{Program.AppName} — Instalação";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        ShowIcon = false;

        var layout = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Padding = new Padding(22),
            Dock = DockStyle.Fill
        };
        var heading = new Label
        {
            Text = $"Instalar {Program.AppName} {Program.AppVersion}",
            Font = new Font(Font, FontStyle.Bold),
            AutoSize = true
        };
        var location = new Label
        {
            Text = $"Pasta do aplicativo\n{Program.DefaultLocation}",
            AutoSize = true,
            MaximumSize = new Size(480, 0),
            Margin = new Padding(3, 12, 3, 12)
        };
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
        var install = new Button { Text = "Instalar", AutoSize = true };
        var cancel = new Button { Text = "Fechar", AutoSize = true };
        buttons.Controls.AddRange([install, cancel]);
        layout.Controls.AddRange([heading, location, buttons]);
        Controls.Add(layout);
        AcceptButton = install;
        CancelButton = cancel;

        cancel.Click += (_, _) => Close();
        install.Click += (_, _) =>
        {
            if (!WindowsIntegration.HasWebView2())
            {
                const string message = "O OpenBot-free precisa do Microsoft Edge WebView2 Runtime. Deseja abrir a página da Microsoft para instalá-lo?";
                if (MessageBox.Show(this, message, Program.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                    Process.Start(new ProcessStartInfo(WindowsIntegration.WebView2Download) { UseShellExecute = true });
                return;
            }

            install.Enabled = false;
            cancel.Enabled = false;
            UseWaitCursor = true;
            try
            {
                installation.Install();
                if (MessageBox.Show(this, "Instalação concluída. Abrir o OpenBot-free agora?",
                    Program.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                {
                    Process.Start(new ProcessStartInfo(Path.Combine(Program.DefaultLocation, Program.AppExe))
                    {
                        WorkingDirectory = Program.DefaultLocation,
                        UseShellExecute = true
                    });
                }
                Close();
            }
            catch (Exception ex)
            {
                Program.ShowError(ex);
            }
            finally
            {
                UseWaitCursor = false;
                install.Enabled = true;
                cancel.Enabled = true;
            }
        };
    }
}
