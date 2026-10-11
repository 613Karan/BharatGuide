// Gov Guide launcher (this PC only).
// Double-click GovGuide.exe in the project root:
//   1. starts the knowledge-base service (python -m rag.service, port 8008) if it is not running,
//   2. opens the Guide app (Electron, shell/), which starts on the START_URL from .env (google.com),
//   3. when the Guide window closes, stops the knowledge base again if this launcher started it.
// Build: powershell -ExecutionPolicy Bypass -File launcher\build-launcher.ps1
// Compiled with the C# 5 compiler that ships with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Windows.Forms;

internal static class GovGuide
{
    private const string Title = "Gov Guide";
    private const string HealthUrl = "http://127.0.0.1:8008/healthz";

    [STAThread]
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string shell = Path.Combine(root, "shell");
        string electron = Path.Combine(shell, @"node_modules\electron\dist\electron.exe");
        string builtMain = Path.Combine(shell, @"out\main\index.js");
        string logs = Path.Combine(root, "logs");

        if (!File.Exists(electron))
        {
            return Fail("Electron was not found:\n" + electron + "\n\nRun 'npm install' in the shell folder first.");
        }
        if (!File.Exists(builtMain))
        {
            return Fail("The app is not built yet:\n" + builtMain + "\n\nRun 'npm run build' in the shell folder (or run-shell.ps1) once.");
        }

        // Electron runs as plain Node (no window) when this is set.
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);

        Process rag = null;
        if (!RagIsUp())
        {
            rag = StartRag(root, logs);
            if (rag == null)
            {
                MessageBox.Show(
                    "Could not start the knowledge-base service (Python).\nThe Guide will open, but cited answers will be unavailable.\n\nDetails: " + Path.Combine(logs, "rag.err"),
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        Process app;
        try
        {
            var psi = new ProcessStartInfo(electron, ".")
            {
                WorkingDirectory = shell,
                UseShellExecute = false,
            };
            psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            app = Process.Start(psi);
        }
        catch (Exception error)
        {
            StopRag(rag);
            return Fail("Could not start the Guide app:\n" + error.Message);
        }

        // Stay in the background until the Guide closes, then clean up what we started.
        app.WaitForExit();
        StopRag(rag);
        return 0;
    }

    private static bool RagIsUp()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Timeout = 2000;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Start "python -m rag.service" with no console window; output goes to logs\rag.out / rag.err.</summary>
    private static Process StartRag(string root, string logs)
    {
        try
        {
            Directory.CreateDirectory(logs);
            string outFile = Path.Combine(logs, "rag.out");
            string errFile = Path.Combine(logs, "rag.err");
            // cmd handles the redirection so the service keeps writing even while we only wait.
            string args = "/c python -m rag.service 1> \"" + outFile + "\" 2> \"" + errFile + "\"";
            var psi = new ProcessStartInfo("cmd.exe", args)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            return Process.Start(psi);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Stop the service only if this launcher started it (kills cmd + python tree).</summary>
    private static void StopRag(Process rag)
    {
        if (rag == null) return;
        try
        {
            if (rag.HasExited) return;
            var kill = new ProcessStartInfo("taskkill", "/PID " + rag.Id + " /T /F")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (var p = Process.Start(kill))
            {
                p.WaitForExit(5000);
            }
        }
        catch
        {
            // Best effort: the service is harmless if left running.
        }
    }

    private static int Fail(string message)
    {
        MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}
