namespace OpenBotFree;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        string? testProfile = null;
        if (args is ["--smoke-test", var profile])
        {
            testProfile = Path.GetFullPath(profile);
            if (!Directory.Exists(testProfile) || Directory.EnumerateFileSystemEntries(testProfile).Any())
                return 2;
        }
        else if (args.Length > 0)
        {
            return 2;
        }

        string mutexName = testProfile is null
            ? @"Local\KayzenRoot.OpenBotFree.Desktop"
            : @"Local\KayzenRoot.OpenBotFree.Smoke";
        using var mutex = new Mutex(true, mutexName, out bool ownsMutex);
        if (!ownsMutex)
        {
            if (testProfile is null)
                MessageBox.Show("O OpenBot-free já está aberto.", "OpenBot-free", MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            return 2;
        }

        try
        {
            using var window = new DesktopWindow(testProfile);
            Application.Run(window);
            return window.ExitCode;
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }
}
