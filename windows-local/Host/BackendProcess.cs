using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace OpenBotFree;

internal sealed partial class BackendProcess : IAsyncDisposable
{
    internal const string SessionCookieName = "openbot_local_session";
    private const string ListeningPrefix = "OpenBot local API listening on ";
    private readonly string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly HttpClient client = new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        UseProxy = false,
    });
    private BackendJob? job;
    private Process? process;
    private Task? stdoutDrain;
    private Task? stderrDrain;
    internal Uri? Origin { get; private set; }

    internal async Task StartAsync(string? testProfile, CancellationToken cancellationToken)
    {
        string runtime = Path.Combine(AppContext.BaseDirectory, "runtime");
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(runtime, "OpenBotLocal.exe"),
            WorkingDirectory = runtime,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.Environment["OPENBOT_LOCAL_PORT"] = "0";
        start.Environment["OPENBOT_LOCAL_TOKEN"] = token;
        start.Environment.Remove("BUN_BE_BUN");
        if (testProfile is not null)
        {
            start.Environment["OPENBOT_LOCAL_DATA_DIR"] = Path.Combine(testProfile, "Backend");
            start.Environment.Remove("OPENCODE_API_KEY");
            start.Environment.Remove("OPENCODE_CONSOLE_API_KEY");
        }

        cancellationToken.ThrowIfCancellationRequested();
        job = new BackendJob();
        process = Process.Start(start) ?? throw new InvalidOperationException();
        try
        {
            job.Attach(process);
        }
        catch
        {
            if (!process.HasExited)
                process.Kill();
            throw;
        }

        stderrDrain = process.StandardError.BaseStream.CopyToAsync(Stream.Null);

        try
        {
            while (await process.StandardOutput.ReadLineAsync(cancellationToken) is { } line)
            {
                if (!line.StartsWith(ListeningPrefix, StringComparison.Ordinal))
                    continue;
                if (!Uri.TryCreate(line[ListeningPrefix.Length..], UriKind.Absolute, out Uri? uri)
                    || uri.Scheme != Uri.UriSchemeHttp
                    || uri.Host != "127.0.0.1"
                    || uri.IsDefaultPort
                    || uri.Port <= 0
                    || uri.AbsolutePath != "/"
                    || uri.UserInfo.Length != 0
                    || uri.Query.Length != 0
                    || uri.Fragment.Length != 0)
                    throw new InvalidDataException();

                Origin = uri;
                return;
            }

            throw new EndOfStreamException();
        }
        finally
        {
            stdoutDrain = process.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
        }
    }

    internal async Task<string> CreateSessionAsync(CancellationToken cancellationToken)
    {
        using HttpResponseMessage response = await client.PostAsJsonAsync(
            new Uri(Origin!, "/api/local/session"), new { token }, cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Headers.TryGetValues("Set-Cookie", out IEnumerable<string>? cookies))
        {
            foreach (string cookie in cookies)
            {
                Match match = SessionCookie().Match(cookie);
                if (match.Success)
                    return match.Groups[1].Value;
            }
        }
        throw new InvalidDataException();
    }

    internal bool ExitedGracefully { get; private set; }

    public async ValueTask DisposeAsync()
    {
        using HttpClient shutdownClient = client;
        using BackendJob? ownedJob = job;
        job = null;
        if (process is not { } ownedProcess)
            return;

        process = null;
        using (ownedProcess)
        {
            if (Origin is not null && !ownedProcess.HasExited)
            {
                try
                {
                    using var requestBudget = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    using var request = new HttpRequestMessage(HttpMethod.Post,
                        new Uri(Origin, "/api/local/operations/shutdown"));
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                    request.Content = JsonContent.Create(new { confirmed = true });
                    using HttpResponseMessage response = await shutdownClient.SendAsync(request, requestBudget.Token);
                    if (response.StatusCode == HttpStatusCode.Accepted)
                    {
                        using var exitBudget = new CancellationTokenSource(TimeSpan.FromSeconds(12));
                        await ownedProcess.WaitForExitAsync(exitBudget.Token);
                        ExitedGracefully = ownedProcess.ExitCode == 0;
                    }
                }
                catch (HttpRequestException) { }
                catch (OperationCanceledException) { }
            }

            if (!ownedProcess.HasExited)
            {
                try
                {
                    ownedProcess.Kill();
                    using var killBudget = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    await ownedProcess.WaitForExitAsync(killBudget.Token);
                }
                catch (InvalidOperationException) when (ownedProcess.HasExited) { }
                catch (OperationCanceledException) { }
            }

            var drains = Task.WhenAll(stdoutDrain ?? Task.CompletedTask, stderrDrain ?? Task.CompletedTask);
            try
            {
                await drains.WaitAsync(TimeSpan.FromSeconds(1));
            }
            catch (IOException) { }
            catch (TimeoutException) { }
        }
    }

    [GeneratedRegex("^openbot_local_session=([a-zA-Z0-9_-]{43})(?:;|$)", RegexOptions.CultureInvariant)]
    private static partial Regex SessionCookie();
}
