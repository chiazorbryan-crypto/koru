// Koru's taskbar helper. It works on its own, with or without Koru open.
//
//   koru-taskbar enable <hide 0|1> <alpha 40-255>   turn it on: saves the choice, starts with Windows, starts now
//   koru-taskbar disable                            turn it off: back to how the taskbar was, stops starting with Windows
//   koru-taskbar run                                the small background part (started by enable and at sign-in)
//   koru-taskbar stop                               stops the background part (settings stay)
//   koru-taskbar state                              prints {"autohide":..,"hide":..,"alpha":..,"running":..}
//   koru-taskbar wallpaper <file.png> [fill|fit] [dry]   sets the desktop wallpaper ("dry": only checks the arguments, changes nothing)
//
// Hiding uses Windows' own taskbar auto-hide, so the slide down and back up is Windows' smooth animation:
// nothing here draws or animates. "alpha" makes the taskbar see-through (255 = normal).
// The background part sleeps until Explorer restarts (Windows tells every window "TaskbarCreated"), then
// puts the settings back; a check every 30 seconds covers a new screen being plugged in. No CPU in between.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class KoruTaskbar {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint msg; public uint edge; public RECT rc; public IntPtr lParam; }
  [DllImport("shell32.dll")] static extern IntPtr SHAppBarMessage(uint m, ref APPBARDATA d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint k, byte a, uint f);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint k, out byte a, out uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string s);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SystemParametersInfo(uint a, uint u, string p, uint w);

  const int GWL_EXSTYLE = -20, WS_EX_LAYERED = 0x80000;
  const string KEY = @"Software\Koru\Taskbar", RUN = @"Software\Microsoft\Windows\CurrentVersion\Run", RUN_NAME = "KoruTaskbar";
  const string STOP_EVENT = @"Local\KoruTaskbarStop", RUN_MUTEX = @"Local\KoruTaskbarRunning";

  // ---- the taskbar ----
  static APPBARDATA Bar() { var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d); d.hWnd = FindWindow("Shell_TrayWnd", null); return d; }
  static bool AutoHide() { var d = Bar(); return ((int)SHAppBarMessage(4, ref d) & 1) != 0; }
  static void SetAutoHide(bool on) { if (AutoHide() == on) return; var d = Bar(); d.lParam = (IntPtr)(on ? 1 : 2); SHAppBarMessage(10, ref d); }
  static List<IntPtr> Bars() {
    var l = new List<IntPtr>(); var h = FindWindow("Shell_TrayWnd", null); if (h != IntPtr.Zero) l.Add(h);
    IntPtr s = IntPtr.Zero; while ((s = FindWindowEx(IntPtr.Zero, s, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) l.Add(s);
    return l;
  }
  static void SetAlpha(int v) {
    v = Math.Max(0, Math.Min(255, v));
    foreach (var w in Bars()) {
      int ex = GetWindowLong(w, GWL_EXSTYLE);
      if (v >= 255) { if ((ex & WS_EX_LAYERED) != 0) SetWindowLong(w, GWL_EXSTYLE, ex & ~WS_EX_LAYERED); continue; }
      uint k, f; byte cur;
      if ((ex & WS_EX_LAYERED) != 0 && GetLayeredWindowAttributes(w, out k, out cur, out f) && cur == v) continue;   // already right: touch nothing
      SetWindowLong(w, GWL_EXSTYLE, ex | WS_EX_LAYERED);
      SetLayeredWindowAttributes(w, 0, (byte)v, 2);
    }
  }

  // ---- saved choice (in the registry, so it doesn't need Koru) ----
  static int Get(string name, int def) { using (var k = Registry.CurrentUser.OpenSubKey(KEY)) { var v = k == null ? null : k.GetValue(name); return v is int ? (int)v : def; } }
  static void Put(string name, int v) { using (var k = Registry.CurrentUser.CreateSubKey(KEY)) k.SetValue(name, v, RegistryValueKind.DWord); }
  static string Self() { return Process.GetCurrentProcess().MainModule.FileName; }
  static bool Running() { bool fresh; using (var m = new Mutex(false, RUN_MUTEX, out fresh)) { if (!fresh) return true; } return false; }

  static void Stop() {
    try { using (var e = EventWaitHandle.OpenExisting(STOP_EVENT)) e.Set(); } catch { return; }
    for (int i = 0; i < 40 && Running(); i++) Thread.Sleep(50);
  }

  // start the background part fully on its own: through the shell, so it doesn't hold on to whatever started this
  static void StartRunner() { Process.Start(new ProcessStartInfo(Self(), "run") { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden }); }

  static void Apply(bool startup) {
    bool hide = Get("Hide", 0) == 1; int alpha = Get("Alpha", 255);
    if (hide && (startup || !AutoHide())) SetAutoHide(true);
    SetAlpha(alpha);
  }

  [STAThread]
  static int Main(string[] a) {
    try {
      string cmd = a.Length > 0 ? a[0] : "state";
      if (cmd == "state") {
        Console.WriteLine("{\"autohide\":" + (AutoHide() ? "true" : "false") + ",\"hide\":" + (Get("Hide", 0) == 1 ? "true" : "false") + ",\"alpha\":" + Get("Alpha", 255) + ",\"running\":" + (Running() ? "true" : "false") + "}");
        return 0;
      }
      if (cmd == "enable") {
        bool hide = a.Length > 1 && a[1] == "1"; int alpha = a.Length > 2 ? Math.Max(40, Math.Min(255, int.Parse(a[2]))) : 255;
        Stop();
        // remember how the taskbar was, once, so turning this off puts it back
        if (Get("OrigAutoHide", -1) == -1) Put("OrigAutoHide", AutoHide() ? 1 : 0);
        bool wasHide = Get("Hide", 0) == 1;
        Put("Hide", hide ? 1 : 0); Put("Alpha", alpha);
        if (!hide && wasHide) SetAutoHide(Get("OrigAutoHide", 0) == 1);
        using (var r = Registry.CurrentUser.CreateSubKey(RUN)) r.SetValue(RUN_NAME, "\"" + Self() + "\" run");
        Apply(true);
        StartRunner();
        Console.WriteLine("ok"); return 0;
      }
      if (cmd == "disable") {
        Stop();
        using (var r = Registry.CurrentUser.OpenSubKey(RUN, true)) if (r != null && r.GetValue(RUN_NAME) != null) r.DeleteValue(RUN_NAME);
        int orig = Get("OrigAutoHide", -1);
        if (Get("Hide", 0) == 1 && orig != -1) SetAutoHide(orig == 1);
        SetAlpha(255);
        Registry.CurrentUser.DeleteSubKeyTree(KEY, false);
        Console.WriteLine("ok"); return 0;
      }
      if (cmd == "stop") { Stop(); Console.WriteLine("ok"); return 0; }
      if (cmd == "run") {
        bool fresh;
        using (var m = new Mutex(true, RUN_MUTEX, out fresh)) {
          if (!fresh) return 0;   // already running
          using (var stop = new EventWaitHandle(false, EventResetMode.AutoReset, STOP_EVENT)) {
            Apply(true);
            var win = new Listener();
            var timer = new System.Windows.Forms.Timer { Interval = 30000 };
            timer.Tick += (s, e) => SetAlpha(Get("Alpha", 255));
            timer.Start();
            ThreadPool.RegisterWaitForSingleObject(stop, (s, t) => { try { win.Invoke(new Action(Application.ExitThread)); } catch { } }, null, -1, true);
            Application.Run();
            timer.Stop(); win.DestroyHandle();
          }
          m.ReleaseMutex();
        }
        return 0;
      }
      if (cmd == "wallpaper") {
        // Fill = 10 (covers the screen, cropped), Fit = 6 (whole picture, bars around it). Koru already sizes the picture to the screen.
        string file = a.Length > 1 ? a[1] : "", mode = a.Length > 2 ? a[2] : "fill";
        bool dry = a.Length > 3 && a[3] == "dry";
        if (mode != "fill" && mode != "fit") { Console.Error.WriteLine("mode must be fill or fit"); return 2; }
        if (file == "" || !System.IO.Path.IsPathRooted(file)) { Console.Error.WriteLine("give the full path of the picture"); return 2; }
        if (!System.IO.File.Exists(file)) { Console.Error.WriteLine("picture not found"); return 2; }
        string style = mode == "fill" ? "10" : "6";
        if (!dry) {
          using (var k = Registry.CurrentUser.CreateSubKey(@"Control Panel\Desktop")) { k.SetValue("WallpaperStyle", style); k.SetValue("TileWallpaper", "0"); }
          // SPI_SETDESKWALLPAPER, saved and announced to every app (SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)
          if (!SystemParametersInfo(0x14, 0, file, 0x01 | 0x02)) { Console.Error.WriteLine("Windows didn't take the wallpaper (" + Marshal.GetLastWin32Error() + ")"); return 1; }
        }
        Console.WriteLine("{\"ok\":true,\"style\":" + style + ",\"dry\":" + (dry ? "true" : "false") + "}"); return 0;
      }
      Console.Error.WriteLine("unknown command"); return 2;
    } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
  }

  // a hidden window: Windows tells it when Explorer (the taskbar) restarts, so the settings go back on
  sealed class Listener : NativeWindow {
    readonly uint taskbarCreated = RegisterWindowMessage("TaskbarCreated");
    readonly Control invoker;
    public Listener() { invoker = new Control(); invoker.CreateControl(); CreateHandle(new CreateParams { Caption = "KoruTaskbar", Style = 0 }); }
    public void Invoke(Delegate d) { invoker.BeginInvoke(d); }
    protected override void WndProc(ref Message m) {
      if (m.Msg == (int)taskbarCreated) { var t = new System.Windows.Forms.Timer { Interval = 1500 }; t.Tick += (s, e) => { t.Stop(); t.Dispose(); Apply(true); }; t.Start(); }
      base.WndProc(ref m);
    }
  }
}
