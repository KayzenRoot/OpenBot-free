using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OpenBotFree;

internal sealed class DesktopWindow : Form
{
    private readonly string? testProfile;
    private readonly BackendProcess backend = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Label status = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        Text = "Iniciando o OpenBot-free…",
        AccessibleName = "Estado do OpenBot-free",
    };
    private readonly ToolStripMenuItem renewSession = new("Renovar sessão") { Enabled = false };
    private Task? startup;
    private bool closing;
    private bool shutdownComplete;
    private bool confirmedWorkspace;
    private bool confirmedDownload;
    private string? failureStage;

    internal DesktopWindow(string? testProfile)
    {
        this.testProfile = testProfile;
        Text = "OpenBot-free";
        Width = 1200;
        Height = 800;
        MinimumSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterScreen;

        var content = new Panel { Dock = DockStyle.Fill };
        content.Controls.Add(browser);
        content.Controls.Add(status);
        var sessionMenu = new ToolStripMenuItem("Sessão");
        sessionMenu.DropDownItems.Add(renewSession);
        var menu = new MenuStrip();
        menu.Items.Add(sessionMenu);
        MainMenuStrip = menu;
        Controls.Add(content);
        Controls.Add(menu);
        renewSession.Click += RenewSession_Click;
    }

    internal int ExitCode { get; private set; }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        startup = StartAsync();
    }

    private async Task StartAsync()
    {
        using var startupBudget = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        startupBudget.CancelAfter(TimeSpan.FromSeconds(40));
        CancellationToken cancellationToken = startupBudget.Token;
        try
        {
            failureStage = "webview-runtime";
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();

            failureStage = "backend-start";
            await backend.StartAsync(testProfile, cancellationToken);

            failureStage = "webview-init";
            string profile = testProfile ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenBotFree");
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: Path.Combine(profile, "WebView2")).WaitAsync(cancellationToken);
            _ = browser.Handle;
            await browser.EnsureCoreWebView2Async(environment).WaitAsync(cancellationToken);
            ConfigureBrowser(browser.CoreWebView2);

            failureStage = "session";
            await AuthenticateAsync(cancellationToken);
            failureStage = "navigation";
            await NavigateToWorkspaceAsync(cancellationToken);

            status.Visible = false;
            browser.Visible = true;
            renewSession.Enabled = true;
            if (testProfile is not null)
            {
                failureStage = "workspace";
                await ConfirmWorkspaceAsync(cancellationToken);
                confirmedWorkspace = true;
                failureStage = "download";
                await ConfirmDownloadAsync(cancellationToken);
                confirmedDownload = true;
            }
            failureStage = null;
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
        {
        }
        catch (WebView2RuntimeNotFoundException)
        {
            status.Text = "Instale o Microsoft Edge WebView2 Runtime e abra o OpenBot-free novamente.";
        }
        catch (Exception)
        {
            status.Text = "O OpenBot-free não conseguiu iniciar. Feche e abra o aplicativo novamente.";
        }
        finally
        {
            if (testProfile is not null && !closing)
                BeginInvoke((Action)Close);
        }
    }

    private async Task NavigateToWorkspaceAsync(CancellationToken cancellationToken)
    {
        CoreWebView2 core = browser.CoreWebView2;
        string destination = backend.Origin!.AbsoluteUri;
        var loaded = new TaskCompletionSource<CoreWebView2NavigationCompletedEventArgs>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        ulong? navigationId = null;
        void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (e.Uri == destination)
                navigationId = e.NavigationId;
        }
        void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.NavigationId == navigationId)
                loaded.TrySetResult(e);
        }

        core.NavigationStarting += OnNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        try
        {
            core.Navigate(destination);
            var navigation = await loaded.Task.WaitAsync(cancellationToken);
            if (!navigation.IsSuccess)
            {
                failureStage = $"navigation-{navigation.WebErrorStatus}";
                throw new InvalidOperationException();
            }
        }
        finally
        {
            core.NavigationStarting -= OnNavigationStarting;
            core.NavigationCompleted -= OnNavigationCompleted;
        }
    }

    private void ConfigureBrowser(CoreWebView2 core)
    {
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.IsStatusBarEnabled = false;

        core.NavigationStarting += (_, e) =>
        {
            if (IsLocal(e.Uri))
                return;
            e.Cancel = true;
            if (e.IsUserInitiated && !e.IsRedirected)
                OpenExternal(e.Uri);
        };
        core.FrameNavigationStarting += (_, e) => e.Cancel = !IsLocal(e.Uri);
        core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (!e.IsUserInitiated)
                return;
            if (IsLocal(e.Uri))
                core.Navigate(e.Uri);
            else
                OpenExternal(e.Uri);
        };
    }

    private bool IsLocal(string destination)
    {
        return backend.Origin is { } origin
            && Uri.TryCreate(destination, UriKind.Absolute, out Uri? uri)
            && uri.Scheme == origin.Scheme
            && uri.Host == origin.Host
            && uri.Port == origin.Port
            && uri.UserInfo.Length == 0;
    }

    private static void OpenExternal(string destination)
    {
        if (!Uri.TryCreate(destination, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || uri.IsLoopback
            || uri.UserInfo.Length != 0)
            return;
        try
        {
            using Process? browserProcess = Process.Start(
                new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Win32Exception) { }
    }

    private async Task AuthenticateAsync(CancellationToken cancellationToken)
    {
        string session = await backend.CreateSessionAsync(cancellationToken);
        var cookies = browser.CoreWebView2.CookieManager;
        var cookie = cookies.CreateCookie(BackendProcess.SessionCookieName, session, backend.Origin!.Host, "/");
        cookie.IsHttpOnly = true;
        cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
        cookies.AddOrUpdateCookie(cookie);
    }

    private async void RenewSession_Click(object? sender, EventArgs e)
    {
        renewSession.Enabled = false;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        budget.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            await AuthenticateAsync(budget.Token);
            browser.CoreWebView2.Reload();
        }
        catch (Exception) when (lifetime.IsCancellationRequested) { }
        catch (Exception)
        {
            MessageBox.Show(this, "Não foi possível renovar a sessão. Feche e abra o aplicativo novamente.",
                Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            renewSession.Enabled = !closing;
        }
    }

    private async Task ConfirmWorkspaceAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            string present = await browser.CoreWebView2.ExecuteScriptAsync(
                """Boolean(document.querySelector('aside[aria-label="Workspace"]'))"""
            ).WaitAsync(cancellationToken);
            if (present == "true")
                return;
            await Task.Delay(TimeSpan.FromMilliseconds(150), cancellationToken);
        }
    }

    private async Task ConfirmDownloadAsync(CancellationToken cancellationToken)
    {
        CoreWebView2 core = browser.CoreWebView2;
        var download = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
        {
            e.Cancel = true;
            download.TrySetResult(e.DownloadOperation.Uri.StartsWith(
                $"blob:{backend.Origin!.AbsoluteUri}", StringComparison.Ordinal));
        }

        core.DownloadStarting += OnDownloadStarting;
        try
        {
            await core.ExecuteScriptAsync(
                """
                (() => {
                    const link = document.createElement("a");
                    link.href = URL.createObjectURL(new Blob(["OpenBot-free"]));
                    link.download = "openbot-smoke.txt";
                    document.body.append(link);
                    link.click();
                    link.remove();
                })()
                """
            ).WaitAsync(cancellationToken);
            if (!await download.Task.WaitAsync(cancellationToken))
                throw new InvalidOperationException();
        }
        finally
        {
            core.DownloadStarting -= OnDownloadStarting;
        }
    }

    protected override async void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (shutdownComplete)
            return;

        e.Cancel = true;
        if (closing)
            return;
        closing = true;
        renewSession.Enabled = false;
        status.Text = "Encerrando o OpenBot-free…";
        status.Visible = true;
        browser.Visible = false;
        lifetime.Cancel();

        bool graceful = false;
        try
        {
            try
            {
                if (startup is not null)
                    await startup;
                browser.Dispose();
            }
            finally
            {
                await backend.DisposeAsync();
            }
            graceful = backend.ExitedGracefully;
        }
        catch (Exception)
        {
            failureStage ??= "shutdown";
        }
        finally
        {
            lifetime.Dispose();
            shutdownComplete = true;
            if (testProfile is not null)
            {
                ExitCode = confirmedWorkspace && confirmedDownload && graceful ? 0 : 1;
                try
                {
                    File.WriteAllText(Path.Combine(testProfile, "smoke-result.json"), JsonSerializer.Serialize(new
                    {
                        workspaceLoaded = confirmedWorkspace,
                        downloadAvailable = confirmedDownload,
                        backendExitedGracefully = graceful,
                        failureStage,
                    }));
                }
                catch (IOException)
                {
                    ExitCode = 1;
                }
                catch (UnauthorizedAccessException)
                {
                    ExitCode = 1;
                }
            }

            BeginInvoke((Action)Close);
        }
    }
}
