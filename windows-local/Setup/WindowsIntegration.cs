using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace OpenBotFree.Setup;

internal sealed class WindowsIntegration
{
    internal const string WebView2Download = "https://developer.microsoft.com/microsoft-edge/webview2/#download";
    private const string WebView2Key = @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenBotFree";
    private readonly string location;
    private readonly string shortcut;
    private readonly byte[]? previousShortcut;
    private readonly Dictionary<string, (object Value, RegistryValueKind Kind)>? previousRegistration;

    private WindowsIntegration(string location)
    {
        this.location = location;
        shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), $"{Program.AppName}.lnk");
        previousShortcut = File.Exists(shortcut) ? File.ReadAllBytes(shortcut) : null;
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey(UninstallKey);
        if (key is null)
        {
            if (previousShortcut is not null)
                throw new IOException("Já existe um atalho com o nome OpenBot-free no Menu Iniciar.");
            return;
        }

        if (!string.Equals(key.GetValue("InstallLocation") as string, location, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Já existe um registro do OpenBot-free para outra pasta.");

        previousRegistration = new(StringComparer.OrdinalIgnoreCase);
        foreach (string name in key.GetValueNames())
        {
            object? value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            if (value is not null)
                previousRegistration.Add(name, (value, key.GetValueKind(name)));
        }
    }

    internal static WindowsIntegration Capture(string location) => new(location);

    internal static bool HasWebView2()
    {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                using RegistryKey root = RegistryKey.OpenBaseKey(hive, view);
                using RegistryKey? key = root.OpenSubKey(WebView2Key);
                if (Version.TryParse(key?.GetValue("pv") as string, out Version? version) && version.Major > 0)
                    return true;
            }
        }
        return false;
    }

    internal void Register(string version)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(shortcut)!);
        string temporaryShortcut = Path.Combine(Path.GetDirectoryName(shortcut)!, $".OpenBot-free-{Guid.NewGuid():N}.lnk");
        string executable = Path.Combine(location, Program.AppExe);
        try
        {
            CreateShortcut(temporaryShortcut, executable, location);
            using RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey);
            key.SetValue("DisplayName", Program.AppName);
            key.SetValue("DisplayVersion", version);
            key.SetValue("Publisher", "KayzenRoot");
            key.SetValue("InstallLocation", location);
            key.SetValue("DisplayIcon", executable);
            key.SetValue("UninstallString", $"\"{Path.Combine(location, Program.SetupExe)}\" --uninstall");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            File.Move(temporaryShortcut, shortcut, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryShortcut);
        }
    }

    internal void Remove()
    {
        File.Delete(shortcut);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false);
    }

    internal void Restore()
    {
        if (previousRegistration is null)
        {
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false);
        }
        else
        {
            using RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey);
            foreach (string name in key.GetValueNames())
                key.DeleteValue(name);
            foreach (var (name, (value, kind)) in previousRegistration)
                key.SetValue(name, value, kind);
        }

        if (previousShortcut is null)
            File.Delete(shortcut);
        else
            File.WriteAllBytes(shortcut, previousShortcut);
    }

    private static void CreateShortcut(string path, string target, string workingDirectory)
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("Os atalhos do Windows estão indisponíveis.");
        object shell = Activator.CreateInstance(shellType)
            ?? throw new InvalidOperationException("Não foi possível criar o atalho.");
        object? link = null;
        try
        {
            link = ((dynamic)shell).CreateShortcut(path);
            dynamic shortcut = link!;
            shortcut.TargetPath = target;
            shortcut.WorkingDirectory = workingDirectory;
            shortcut.IconLocation = $"{target},0";
            shortcut.Description = Program.AppName;
            shortcut.Save();
        }
        finally
        {
            if (link is not null)
                Marshal.FinalReleaseComObject(link);
            Marshal.FinalReleaseComObject(shell);
        }
    }
}
