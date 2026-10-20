// Hawl tray app for Windows. Shows whether the hawl helper (the daemon) is running and lets
// the user start, stop and update it, and connect a project folder (`hawl join`).
// Built with the csc.exe that ships with .NET Framework 4.x (C# 5, no NuGet), so it runs on
// every Windows 10/11 machine with nothing else installed. See build.ps1.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Hawl")]
[assembly: System.Reflection.AssemblyProduct("Hawl")]

namespace Hawl
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool connect = false;
            string site = "";
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--connect") connect = true;
                else if (args[i] == "--site" && i + 1 < args.Length) site = args[++i];
            }

            if (connect) Tray.Connect(site);

            bool first;
            using (var mutex = new Mutex(true, "Local\\HawlTray", out first))
            {
                // One tray per user. A second launch (e.g. --connect from the installer) just exits.
                if (!first) return 0;
                Application.Run(new Tray());
            }
            return 0;
        }
    }

    sealed class Tray : ApplicationContext
    {
        const string TaskName = "hawl-daemon";
        static readonly Regex SiteRe = new Regex("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$");

        readonly NotifyIcon icon;
        readonly ToolStripMenuItem statusItem, startItem, stopItem, restartItem;
        readonly System.Windows.Forms.Timer timer;
        volatile bool polling;

        public static string HawlExe
        {
            get
            {
                string over = Environment.GetEnvironmentVariable("HAWL_BIN");
                if (!string.IsNullOrEmpty(over)) return over;
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hawl\\bin\\hawl.exe");
            }
        }

        static string StateDir
        {
            get
            {
                string over = Environment.GetEnvironmentVariable("HAWL_HOME");
                if (!string.IsNullOrEmpty(over)) return over;
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hawl");
            }
        }

        public Tray()
        {
            var menu = new ContextMenuStrip();
            statusItem = new ToolStripMenuItem("Checking the hawl helper...") { Enabled = false };
            startItem = new ToolStripMenuItem("Start helper", null, delegate { Start(); });
            stopItem = new ToolStripMenuItem("Stop helper", null, delegate { Stop(); });
            restartItem = new ToolStripMenuItem("Restart helper", null, delegate { Stop(); Start(); });
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(startItem);
            menu.Items.Add(stopItem);
            menu.Items.Add(restartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Connect a project folder...", null, delegate { Connect(""); }));
            menu.Items.Add(new ToolStripMenuItem("Check for updates...", null, delegate { Update(); }));
            menu.Items.Add(new ToolStripMenuItem("Open hawl.ai", null, delegate { Open("https://hawl.ai"); }));
            menu.Items.Add(new ToolStripMenuItem("Open logs folder", null, delegate { OpenLogs(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Quit tray (helper keeps running)", null, delegate { Quit(); }));

            icon = new NotifyIcon();
            try { icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { icon.Icon = SystemIcons.Application; }
            icon.Text = "Hawl";
            icon.ContextMenuStrip = menu;
            icon.Visible = true;
            icon.DoubleClick += delegate { Poll(); icon.ShowBalloonTip(3000, "Hawl", statusItem.Text, ToolTipIcon.Info); };

            timer = new System.Windows.Forms.Timer { Interval = 10000 };
            timer.Tick += delegate { Poll(); };
            timer.Start();
            Poll();
        }

        // `hawl status --json` from the home folder: daemon running, version, workers connected.
        void Poll()
        {
            if (polling) return;
            polling = true;
            ThreadPool.QueueUserWorkItem(delegate
            {
                string text;
                bool running = false;
                try
                {
                    if (!File.Exists(HawlExe)) text = "hawl is not installed. Reinstall Hawl.";
                    else
                    {
                        string json = Run(HawlExe, "status --json", 8000);
                        running = Regex.IsMatch(json, "\"daemon\":\\{\"running\":true");
                        if (!running) text = "Helper stopped";
                        else
                        {
                            string ver = Field(json, "\"version\":\"([^\"]*)\"");
                            string workers = Field(json, "\"workers\":(\\d+)");
                            string conn = Field(json, "\"connected\":(\\d+)");
                            text = "Helper running" + (ver != "" ? " (v" + ver + ")" : "");
                            if (workers == "0" || workers == "") text += ", no folders connected";
                            else text += ", " + conn + " of " + workers + " agents online";
                        }
                    }
                }
                catch (Exception e) { text = "Can't reach the helper: " + e.Message; }
                polling = false;
                Show(text, running);
            });
        }

        void Show(string text, bool running)
        {
            if (icon.ContextMenuStrip.InvokeRequired)
            {
                icon.ContextMenuStrip.BeginInvoke((MethodInvoker)delegate { Show(text, running); });
                return;
            }
            statusItem.Text = text;
            startItem.Enabled = !running;
            stopItem.Enabled = running;
            restartItem.Enabled = running;
            string tip = "Hawl: " + text;
            icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
        }

        static string Field(string json, string pattern)
        {
            var m = Regex.Match(json, pattern);
            return m.Success ? m.Groups[1].Value : "";
        }

        static string Run(string exe, string args, int timeoutMs)
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            };
            using (var p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } }
                return output;
            }
        }

        // The scheduled task keeps restart-on-failure; fall back to a plain background start.
        void Start()
        {
            try
            {
                string r = Run("schtasks.exe", "/Run /TN " + TaskName, 8000);
                if (r.IndexOf("SUCCESS", StringComparison.OrdinalIgnoreCase) < 0)
                    Run(HawlExe, "daemon start", 20000);
            }
            catch (Exception e) { Error("Couldn't start the helper: " + e.Message); }
            Thread.Sleep(1500);
            Poll();
        }

        void Stop()
        {
            try { Run(HawlExe, "daemon stop", 8000); }
            catch (Exception e) { Error("Couldn't stop the helper: " + e.Message); }
            Thread.Sleep(1500);
            Poll();
        }

        // Visible console: the update prints what it downloaded and whether the signature matched.
        void Update()
        {
            string q = "\"" + HawlExe + "\"";
            string cmd = "/k \"" + q + " update && " + q + " update --now && " + q + " daemon stop && timeout /t 2 >nul && schtasks /Run /TN " + TaskName + " >nul && echo. && echo Done. You can close this window.\"";
            try { Process.Start(new ProcessStartInfo("cmd.exe", cmd) { UseShellExecute = true }); }
            catch (Exception e) { Error("Couldn't start the update: " + e.Message); }
        }

        // Pick a folder and a site, then run the interactive `hawl join` in a console there.
        public static void Connect(string site)
        {
            string folder;
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Pick the project folder your agent works in (Claude Code, Codex, Cursor...).";
                dlg.ShowNewFolderButton = false;
                if (dlg.ShowDialog() != DialogResult.OK) return;
                folder = dlg.SelectedPath;
            }
            site = Ask("Connect to Hawl", "Your site's address or name (for example hawl.ai/t/acme or acme):", site);
            if (site == null) return;
            site = site.Trim();
            if (!SiteRe.IsMatch(site))
            {
                Error("That doesn't look like a site address. Copy it from your site's page on hawl.ai.");
                return;
            }
            string cmd = "/k \"\"" + HawlExe + "\" join " + site + "\"";
            try { Process.Start(new ProcessStartInfo("cmd.exe", cmd) { UseShellExecute = true, WorkingDirectory = folder }); }
            catch (Exception e) { Error("Couldn't start hawl join: " + e.Message); }
        }

        static string Ask(string title, string prompt, string value)
        {
            using (var f = new Form())
            {
                f.Text = title;
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.StartPosition = FormStartPosition.CenterScreen;
                f.MinimizeBox = false;
                f.MaximizeBox = false;
                f.ClientSize = new Size(420, 120);
                var label = new Label { Text = prompt, Left = 12, Top = 12, Width = 396, Height = 32 };
                var box = new TextBox { Text = value ?? "", Left = 12, Top = 48, Width = 396 };
                var ok = new Button { Text = "Connect", Left = 236, Top = 82, Width = 84, DialogResult = DialogResult.OK };
                var cancel = new Button { Text = "Cancel", Left = 324, Top = 82, Width = 84, DialogResult = DialogResult.Cancel };
                f.Controls.AddRange(new Control[] { label, box, ok, cancel });
                f.AcceptButton = ok;
                f.CancelButton = cancel;
                return f.ShowDialog() == DialogResult.OK ? box.Text : null;
            }
        }

        static void Open(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception e) { Error(e.Message); }
        }

        static void OpenLogs()
        {
            string dir = Path.Combine(StateDir, "logs");
            if (!Directory.Exists(dir)) dir = StateDir;
            Open(dir);
        }

        static void Error(string msg)
        {
            MessageBox.Show(msg, "Hawl", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        void Quit()
        {
            icon.Visible = false;
            timer.Stop();
            ExitThread();
        }
    }
}
