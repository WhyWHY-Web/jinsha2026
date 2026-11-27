using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class WindowsLauncher
{
    private const string Title = "金沙江生态评估工作台";
    private const int DefaultPort = 8732;

    [STAThread]
    private static int Main(string[] args)
    {
        bool selfTest = args.Length == 1 && args[0] == "--self-test";
        string package = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        string state = selfTest ? Environment.GetEnvironmentVariable("JINSHA_LAUNCHER_TEST_STATE") : null;
        if (String.IsNullOrWhiteSpace(state))
            state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JinshaWorkbench");

        try
        {
            Directory.CreateDirectory(state);
            string packageKey = PackageKey(package);
            string marker = Path.Combine(state, "launcher-" + packageKey + ".port");
            string log = Path.Combine(state, "launcher-" + packageKey + ".log");
            using (var mutex = new Mutex(false, @"Local\JinshaWorkbench-" + packageKey))
            {
                bool primary;
                try { primary = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { primary = true; }
                if (!primary)
                {
                    int existing = WaitForExisting(marker);
                    if (!selfTest) OpenBrowser(existing);
                    return 0;
                }

                try
                {
                    File.Delete(marker);
                    using (var service = StartService(package, state, log))
                    {
                        string address = Address(service.Port);
                        if (selfTest)
                        {
                            Verify(address, "/", "<!doctype html>");
                            Verify(address, "/api/dashboard", "\"stations\"");
                            Verify(address, "/api/ecology/options", "\"metricDefinitions\"");
                            Verify(address, "/api/ecology/amendments", "\"revision\"");
                            File.WriteAllText(Path.Combine(state, "self-test-result.txt"), address, Encoding.UTF8);
                            return 0;
                        }

                        File.WriteAllText(marker, service.Port.ToString(CultureInfo.InvariantCulture), Encoding.ASCII);
                        Application.EnableVisualStyles();
                        using (var tray = new WorkbenchTray(service, address))
                        {
                            OpenBrowser(service.Port);
                            Application.Run(tray);
                        }
                    }
                }
                finally
                {
                    File.Delete(marker);
                    mutex.ReleaseMutex();
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            if (selfTest)
            {
                try { File.WriteAllText(Path.Combine(state, "self-test-error.txt"), error.ToString(), Encoding.UTF8); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            else
            {
                MessageBox.Show(error.Message + "\r\n\r\n启动日志位于\r\n" + state,
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return 1;
        }
    }

    private static string PackageKey(string path)
    {
        using (var hash = SHA256.Create())
        {
            byte[] bytes = hash.ComputeHash(Encoding.UTF8.GetBytes(path.ToUpperInvariant()));
            return BitConverter.ToString(bytes, 0, 12).Replace("-", "");
        }
    }

    private static string Address(int port)
    {
        return "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture);
    }

    private static void Verify(string address, string route, string expected)
    {
        if (Get(address + route, 10000).IndexOf(expected, StringComparison.OrdinalIgnoreCase) < 0)
            throw new InvalidOperationException("应用自检失败 " + route);
    }

    private static string Get(string url, int timeout)
    {
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Proxy = null;
        request.AllowAutoRedirect = false;
        request.Timeout = timeout;
        request.ReadWriteTimeout = timeout;
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            return reader.ReadToEnd();
    }

    private static bool IsReady(int port)
    {
        try
        {
            string response = Get(Address(port) + "/api/health", 1300);
            return response.Contains("\"ok\":true") && response.Contains("\"service\":\"jinsha-workbench\"");
        }
        catch (WebException) { return false; }
        catch (IOException) { return false; }
    }

    private static void OpenBrowser(int port)
    {
        string address = Address(port) + "/";
        try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); }
        catch (System.ComponentModel.Win32Exception)
        {
            MessageBox.Show("请在浏览器中打开此地址\r\n" + address, Title,
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private static int WaitForExisting(string marker)
    {
        var timer = Stopwatch.StartNew();
        while (timer.Elapsed.TotalSeconds < 18)
        {
            int port;
            try
            {
                if (File.Exists(marker) && Int32.TryParse(File.ReadAllText(marker), out port)
                    && port >= DefaultPort && port < DefaultPort + 30 && IsReady(port))
                    return port;
            }
            catch (IOException) { }
            Thread.Sleep(120);
        }
        throw new InvalidOperationException("工作台正在启动。请稍后再打开，或在任务栏通知区域退出后重试。");
    }

    private static bool CanBind(int port)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        try
        {
            listener.Server.ExclusiveAddressUse = true;
            listener.Start();
            return true;
        }
        catch (SocketException) { return false; }
        finally { listener.Stop(); }
    }

    private static LocalService StartService(string package, string state, string log)
    {
        string application = Path.Combine(package, "app");
        string runtime = Path.Combine(package, "runtime", "node.exe");
        string source = Path.Combine(package, "sources");
        if (!File.Exists(runtime) || !File.Exists(Path.Combine(application, "server", "index.ts"))
            || !File.Exists(Path.Combine(application, "dist", "index.html"))
            || !File.Exists(Path.Combine(source, "data", "stations.json")))
            throw new InvalidOperationException("请完整解压便携包，再打开与 app、runtime 和 sources 同级的启动程序。");

        for (int port = DefaultPort; port < DefaultPort + 30; port++)
        {
            if (!CanBind(port)) continue;
            var setup = new ProcessStartInfo(runtime, "--disable-warning=ExperimentalWarning server/index.ts");
            setup.WorkingDirectory = application;
            setup.CreateNoWindow = true;
            setup.UseShellExecute = false;
            setup.RedirectStandardError = true;
            setup.RedirectStandardOutput = true;
            setup.StandardErrorEncoding = Encoding.UTF8;
            setup.StandardOutputEncoding = Encoding.UTF8;
            setup.EnvironmentVariables.Remove("NODE_OPTIONS");
            setup.EnvironmentVariables.Remove("NODE_PATH");
            setup.EnvironmentVariables.Remove("JINSHA_WORKBENCH_ORIGIN");
            setup.EnvironmentVariables["JINSHA_WORKBENCH_SOURCE"] = source;
            setup.EnvironmentVariables["JINSHA_WORKBENCH_PORT"] = port.ToString(CultureInfo.InvariantCulture);
            setup.EnvironmentVariables["JINSHA_WORKBENCH_STATE"] = Path.Combine(state, "ecology-workflow.sqlite");

            var service = new LocalService(setup, port, log);
            var timer = Stopwatch.StartNew();
            while (!service.Exited && timer.Elapsed.TotalSeconds < 16)
            {
                if (IsReady(port) && !service.Exited) return service;
                Thread.Sleep(130);
            }
            bool conflict = service.PortConflict;
            service.Dispose();
            if (!conflict)
                throw new InvalidOperationException("本地数据服务启动失败。可查看启动日志定位原因。");
        }
        throw new InvalidOperationException("本机端口 8732 至 8761 已被占用。");
    }

    private sealed class LocalService : IDisposable
    {
        private readonly Process process;
        private readonly string log;
        private readonly StringBuilder output = new StringBuilder();
        internal int Port { get; private set; }
        internal bool Exited { get { return process.HasExited; } }
        internal bool PortConflict { get { lock (output) return output.ToString().Contains("EADDRINUSE"); } }

        internal LocalService(ProcessStartInfo setup, int port, string logPath)
        {
            Port = port;
            log = logPath;
            process = new Process { StartInfo = setup };
            process.OutputDataReceived += Save;
            process.ErrorDataReceived += Save;
            try
            {
                if (!process.Start()) throw new InvalidOperationException("无法启动已附带的 Node.js 运行库。");
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
            }
            catch
            {
                process.Dispose();
                throw;
            }
        }

        private void Save(object sender, DataReceivedEventArgs args)
        {
            if (args.Data == null) return;
            lock (output)
                if (output.Length < 32768) output.AppendLine(args.Data);
        }

        public void Dispose()
        {
            try
            {
                if (!process.HasExited) process.Kill();
                if (process.WaitForExit(2500)) process.WaitForExit();
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            finally
            {
                process.Dispose();
                try { lock (output) File.WriteAllText(log, output.ToString(), Encoding.UTF8); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    private sealed class WorkbenchTray : ApplicationContext
    {
        private readonly NotifyIcon icon;
        private readonly System.Windows.Forms.Timer timer;

        internal WorkbenchTray(LocalService service, string address)
        {
            var menu = new ContextMenu(new[]{
                new MenuItem("在浏览器打开", delegate { OpenBrowser(service.Port); }),
                new MenuItem("退出工作台", delegate { ExitThread(); })
            });
            icon = new NotifyIcon { Icon = SystemIcons.Application, Text = Title, Visible = true, ContextMenu = menu };
            icon.DoubleClick += delegate { OpenBrowser(service.Port); };
            timer = new System.Windows.Forms.Timer { Interval = 1600, Enabled = true };
            timer.Tick += delegate
            {
                if (!service.Exited) return;
                timer.Stop();
                MessageBox.Show("本地服务已停止。可以重新打开启动程序。\r\n" + address, Title,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                ExitThread();
            };
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                timer.Dispose();
                icon.Visible = false;
                icon.ContextMenu.Dispose();
                icon.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
