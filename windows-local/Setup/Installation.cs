using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OpenBotFree.Setup;

internal sealed class Installation
{
    private const string MarkerFile = ".openbot-free-installation.json";
    private const string Product = "OpenBot-free/Windows";
    private static readonly StringComparer Paths = StringComparer.OrdinalIgnoreCase;
    private readonly string target;
    private readonly string parent;
    private readonly string installationId;
    private readonly string backup;
    private readonly bool isolated;

    internal Installation(string location, bool isolated)
    {
        this.isolated = isolated;
        if (!Path.IsPathFullyQualified(location) || location.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Informe uma pasta local com caminho absoluto.");

        target = Path.TrimEndingDirectorySeparator(Path.GetFullPath(location));
        parent = Path.GetDirectoryName(target) ?? throw new ArgumentException("Informe uma pasta de instalação.");
        installationId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(target.ToUpperInvariant())));
        backup = Path.Combine(parent, $".OpenBot-free-previous-{installationId}");
        if (isolated && !IsBelow(target, Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()))))
            throw new ArgumentException("A instalação isolada deve ficar em uma subpasta da pasta temporária do usuário.");
    }

    internal void Install()
    {
        using var mutex = AcquireLock();
        CheckAncestors();
        Directory.CreateDirectory(parent);
        RecoverUpgrade();
        Manifest? previous = ReadInstallation(target);
        EnsureAppClosed();
        var windows = isolated ? null : WindowsIntegration.Capture(target);
        string stage = NewSibling("staging");
        bool hadPrevious = false;
        bool installed = false;
        bool registering = false;

        try
        {
            Directory.CreateDirectory(stage);
            ExtractPayload(stage);
            if (previous is not null)
            {
                Directory.Move(target, backup);
                hadPrevious = true;
            }

            Directory.Move(stage, target);
            installed = true;
            registering = windows is not null;
            windows?.Register(Program.AppVersion);
        }
        catch (Exception error)
        {
            RollBack(error, () =>
            {
                if (installed)
                    Directory.Move(target, stage);
                if (hadPrevious)
                    Directory.Move(backup, target);
            }, () => { if (registering) windows?.Restore(); });
            throw;
        }
        finally
        {
            TryRemoveScratch(stage);
        }

        TryRemoveScratch(backup);
    }

    internal void Uninstall()
    {
        using var mutex = AcquireLock();
        CheckAncestors();
        RecoverUpgrade();
        if (ReadInstallation(target) is null)
            return;

        var windows = isolated ? null : WindowsIntegration.Capture(target);
        EnsureAppClosed();
        string trash = NewSibling("removed");
        Directory.Move(target, trash);
        try
        {
            windows?.Remove();
        }
        catch (Exception error)
        {
            RollBack(error, () => Directory.Move(trash, target), () => windows?.Restore());
            throw;
        }

        TryRemoveScratch(trash);
    }

    private void EnsureAppClosed()
    {
        foreach (string name in new[] { "OpenBotFree", "OpenBotLocal" })
        {
            foreach (Process process in Process.GetProcessesByName(name))
            {
                using (process)
                {
                    string? executable;
                    try { executable = process.MainModule?.FileName; }
                    catch (InvalidOperationException) { continue; }
                    catch (System.ComponentModel.Win32Exception) { continue; }
                    if (executable is not null && IsBelow(executable, target))
                        throw new IOException("Feche o OpenBot-free antes de continuar.");
                }
            }
        }
    }

    private static void RollBack(Exception original, Action restoreFiles, Action restoreRegistration)
    {
        var failures = new List<Exception> { original };
        foreach (var repair in new[] { restoreFiles, restoreRegistration })
        {
            try { repair(); }
            catch (Exception failure) { failures.Add(failure); }
        }
        if (failures.Count > 1)
            throw new AggregateException("A operação falhou e a reversão ficou incompleta.", failures);
    }

    private void RecoverUpgrade()
    {
        try { CheckReparsePoint(backup); }
        catch (FileNotFoundException) { return; }
        catch (DirectoryNotFoundException) { return; }

        // The previous version is moved to this exact path before promoting staging.
        // Check both directories before moving a recovery copy or deleting an older one.
        if (ReadInstallation(backup) is null)
            return;

        if (ReadInstallation(target) is null)
        {
            Directory.Move(backup, target);
            return;
        }

        string retired = NewSibling("retired");
        Directory.Move(backup, retired);
        TryRemoveScratch(retired);
    }

    private static Manifest? ReadInstallation(string location)
    {
        if (!Directory.Exists(location))
        {
            if (File.Exists(location))
                throw new IOException("O caminho de instalação está ocupado por um arquivo.");
            return null;
        }

        var files = EnumerateFiles(location);
        if (!files.Contains(MarkerFile))
            throw new IOException("A pasta escolhida não contém uma instalação do OpenBot-free.");

        var manifest = JsonSerializer.Deserialize<Manifest>(File.ReadAllText(Path.Combine(location, MarkerFile)));
        if (manifest is null || manifest.Product != Product || manifest.Files is null)
            throw new IOException("O registro local da instalação está inválido.");

        var owned = new HashSet<string>(manifest.Files, Paths) { MarkerFile };
        if (!files.IsSubsetOf(owned))
            throw new IOException("A pasta do aplicativo contém arquivos que o instalador não pode remover.");

        return manifest;
    }

    private static void ExtractPayload(string stage)
    {
        using Stream payload = typeof(Installation).Assembly.GetManifestResourceStream("OpenBotFree.Payload.zip")
            ?? throw new IOException("O instalador está sem o pacote do aplicativo.");
        using var archive = new ZipArchive(payload, ZipArchiveMode.Read);
        var files = new HashSet<string>(Paths);

        long totalBytes = 0;
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string name = entry.FullName.Replace('\\', '/');
            if (name.StartsWith("./", StringComparison.Ordinal))
                name = name[2..];
            if (name.Length == 0)
                continue;

            bool directory = name.EndsWith('/');
            string relative = NormalizeEntry(directory ? name[..^1] : name);
            if ((Paths.Equals(relative, Program.SetupExe) || Paths.Equals(relative, MarkerFile)))
                throw new InvalidDataException($"O pacote contém um caminho reservado: {relative}");

            string destination = Path.GetFullPath(Path.Combine(stage, relative));
            if (!IsBelow(destination, stage))
                throw new InvalidDataException($"Caminho inválido no pacote: {relative}");
            if (directory)
            {
                Directory.CreateDirectory(destination);
                continue;
            }
            totalBytes = checked(totalBytes + entry.Length);
            if (totalBytes > 2L * 1024 * 1024 * 1024 || !files.Add(relative))
                throw new InvalidDataException("O pacote contém arquivos duplicados ou excede o tamanho permitido.");

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination);
        }

        if (!files.Contains(Program.AppExe) || !files.Contains(Path.Combine("runtime", "OpenBotLocal.exe")))
            throw new InvalidDataException("O pacote está incompleto.");

        string setupPath = Environment.ProcessPath
            ?? throw new InvalidOperationException("Não foi possível localizar o instalador.");
        File.Copy(setupPath, Path.Combine(stage, Program.SetupExe));
        files.Add(Program.SetupExe);
        var marker = new Manifest(Product, Program.AppVersion, files.Order(Paths).ToArray());
        File.WriteAllText(Path.Combine(stage, MarkerFile), JsonSerializer.Serialize(marker));
    }

    private static string NormalizeEntry(string name)
    {
        string[] segments = name.Split('/');
        foreach (string segment in segments)
        {
            string baseName = segment.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
            if (segment.Length == 0 || segment.EndsWith('.') || segment.EndsWith(' ') ||
                segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                baseName is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$" ||
                (baseName.Length == 4 && (baseName.StartsWith("COM", StringComparison.Ordinal) ||
                    baseName.StartsWith("LPT", StringComparison.Ordinal)) && "0123456789¹²³".Contains(baseName[3])))
            {
                throw new InvalidDataException($"Caminho inválido no pacote: {name}");
            }
        }
        return Path.Combine(segments);
    }

    private void CheckAncestors()
    {
        for (string? location = target; location is not null; location = Path.GetDirectoryName(location))
        {
            try { CheckReparsePoint(location); }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    private static void CheckReparsePoint(string path)
    {
        if (File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint))
            throw new IOException($"O caminho da instalação contém um link ou ponto de montagem: {path}");
    }

    private static HashSet<string> EnumerateFiles(string path)
    {
        var files = new HashSet<string>(Paths);
        var remaining = new Stack<string>();
        remaining.Push(path);

        while (remaining.TryPop(out string? directory))
        {
            CheckReparsePoint(directory);
            foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
            {
                CheckReparsePoint(entry);
                if (Directory.Exists(entry))
                    remaining.Push(entry);
                else
                    files.Add(Path.GetRelativePath(path, entry));
            }
        }
        return files;
    }

    private string NewSibling(string purpose) => Path.Combine(parent, $".OpenBot-free-{purpose}-{Guid.NewGuid():N}");

    private void TryRemoveScratch(string path)
    {
        if (!Paths.Equals(Path.GetDirectoryName(path), parent) ||
            !Path.GetFileName(path).StartsWith(".OpenBot-free-", StringComparison.Ordinal) ||
            !Directory.Exists(path))
        {
            return;
        }

        try
        {
            EnumerateFiles(path);
            Directory.Delete(path, recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private IDisposable AcquireLock()
    {
        var mutex = new Mutex(false, $@"Local\OpenBotFreeSetup-{installationId}");
        try
        {
            if (!mutex.WaitOne(TimeSpan.FromSeconds(15)))
                throw new IOException("Aguarde a outra instalação do OpenBot-free terminar.");
        }
        catch (AbandonedMutexException)
        {
            // The previous installer exited without releasing the mutex.
        }
        catch
        {
            mutex.Dispose();
            throw;
        }
        return new InstallationLock(mutex);
    }

    private static bool IsBelow(string path, string directory) =>
        path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private sealed record Manifest(string Product, string Version, string[] Files);

    private sealed class InstallationLock(Mutex mutex) : IDisposable
    {
        public void Dispose()
        {
            mutex.ReleaseMutex();
            mutex.Dispose();
        }
    }
}
