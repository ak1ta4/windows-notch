# Helper nativo del notch. Corre en Windows PowerShell 5.1 (necesario para WinRT).
# Escribe estado en JSON (una línea por mensaje) y lee comandos JSON por stdin.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Windows.Forms

Add-Type -AssemblyName System.Drawing
Add-Type -ErrorAction Stop -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
using System.Globalization;
using System.Diagnostics;
using System.Windows.Forms;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice ppDevice);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  [PreserveSig] int GetCount(out int n);
  [PreserveSig] int Item(int i, out IMMDevice d);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}
[StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit, Size = 24)] struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  [PreserveSig] int GetCount(out int n);
  [PreserveSig] int GetAt(int i, out PROPERTYKEY k);
  [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
}
// Interfaz no documentada que usan SoundSwitch, EarTrumpet, etc. para cambiar la salida predeterminada.
[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
  int GetMixFormat(IntPtr a, IntPtr b); int GetDeviceFormat(IntPtr a, int b, IntPtr c); int ResetDeviceFormat(IntPtr a);
  int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c); int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
  int SetProcessingPeriod(IntPtr a, IntPtr b); int GetShareMode(IntPtr a, IntPtr b); int SetShareMode(IntPtr a, IntPtr b);
  int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c); int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class CPolicyConfigClient {}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
  int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int n);
  [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s);
}
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int s);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string n);
  int SetDisplayName(IntPtr a, IntPtr b);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string p);
  int SetIconPath(IntPtr a, IntPtr b);
  int GetGroupingParam(out Guid g);
  int SetGroupingParam(IntPtr a, IntPtr b);
  int RegisterAudioSessionNotification(IntPtr a);
  int UnregisterAudioSessionNotification(IntPtr a);
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string s);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string s);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float v, ref Guid ctx);
  [PreserveSig] int GetMasterVolume(out float v);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}

// ---------- Salidas de audio y mezclador por aplicación ----------
public static class AudioX {
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);
  static string J(string v) { return (v ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " "); }
  static IMMDeviceEnumerator En() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom()); }
  static string Name(IMMDevice d) {
    IPropertyStore ps; if (d.OpenPropertyStore(0, out ps) != 0 || ps == null) return "";
    var k = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 }; // PKEY_Device_FriendlyName
    PROPVARIANT v; if (ps.GetValue(ref k, out v) != 0) return "";
    string s = v.vt == 31 && v.p != IntPtr.Zero ? Marshal.PtrToStringUni(v.p) : "";
    PropVariantClear(ref v);
    return s;
  }
  // Salidas activas (altavoces, auriculares…) con la predeterminada marcada.
  public static string Devices() {
    var en = En();
    string def = ""; IMMDevice dd;
    if (en.GetDefaultAudioEndpoint(0, 1, out dd) == 0 && dd != null) dd.GetId(out def);
    IMMDeviceCollection col; var sb = new StringBuilder("[");
    if (en.EnumAudioEndpoints(0, 1 /*ACTIVE*/, out col) == 0) {
      int n; col.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IMMDevice d; if (col.Item(i, out d) != 0) continue;
        string id; d.GetId(out id);
        if (i > 0) sb.Append(",");
        sb.AppendFormat("{{\"id\":\"{0}\",\"name\":\"{1}\",\"def\":{2}}}", J(id), J(Name(d)), id == def ? "true" : "false");
      }
    }
    return sb.Append("]").ToString();
  }
  public static void SetDefault(string id) {
    var pc = (IPolicyConfig)(new CPolicyConfigClient());
    for (int role = 0; role < 3; role++) pc.SetDefaultEndpoint(id, role); // consola, multimedia y comunicaciones
  }

  // Sesiones de audio de la salida predeterminada, agrupadas por proceso.
  class Sess { public uint pid; public string key, name, exe; public List<ISimpleAudioVolume> vols = new List<ISimpleAudioVolume>(); public bool system; }
  static List<Sess> Collect() {
    var list = new List<Sess>();
    IMMDevice d; if (En().GetDefaultAudioEndpoint(0, 1, out d) != 0 || d == null) return list;
    var iid = typeof(IAudioSessionManager2).GUID; object o;
    if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return list;
    var mgr = (IAudioSessionManager2)o; IAudioSessionEnumerator e;
    if (mgr.GetSessionEnumerator(out e) != 0) return list;
    int n; e.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IAudioSessionControl2 c; if (e.GetSession(i, out c) != 0 || c == null) continue;
      int st; c.GetState(out st); if (st == 2) continue; // caducada
      uint pid; c.GetProcessId(out pid);
      bool sys = c.IsSystemSoundsSession() == 0;
      string exe = "", name = "";
      if (sys) name = "Sonidos del sistema";
      else {
        try {
          var p = Process.GetProcessById((int)pid);
          try { exe = p.MainModule.FileName; var fd = p.MainModule.FileVersionInfo.FileDescription; name = string.IsNullOrWhiteSpace(fd) ? p.ProcessName : fd; }
          catch { name = p.ProcessName; }
        } catch { name = "Proceso " + pid; }
        string dn; if (c.GetDisplayName(out dn) == 0 && !string.IsNullOrWhiteSpace(dn) && !dn.StartsWith("@")) name = dn;
      }
      // Agrupar por programa (Discord, Chrome… abren varios procesos con sonido).
      string key = sys ? "sys" : (exe != "" ? exe.ToLowerInvariant() : "pid:" + pid);
      var s = list.Find(x => x.key == key);
      if (s == null) { s = new Sess { pid = pid, key = key, system = sys, name = name, exe = exe }; list.Add(s); }
      var v = c as ISimpleAudioVolume; if (v != null) s.vols.Add(v);
    }
    return list;
  }
  public static string Sessions() {
    var sb = new StringBuilder("["); bool first = true;
    foreach (var s in Collect()) {
      if (s.vols.Count == 0) continue;
      float v; bool m; s.vols[0].GetMasterVolume(out v); s.vols[0].GetMute(out m);
      if (!first) sb.Append(","); first = false;
      sb.AppendFormat(CultureInfo.InvariantCulture, "{{\"key\":\"{0}\",\"sys\":{1},\"name\":\"{2}\",\"exe\":\"{3}\",\"vol\":{4:0.###},\"mute\":{5}}}",
        J(s.key), s.system ? "true" : "false", J(s.name), J(s.exe), v, m ? "true" : "false");
    }
    return sb.Append("]").ToString();
  }
  public static void SetSession(string key, float vol, int mute) {
    var g = Guid.Empty;
    foreach (var s in Collect()) {
      if (s.key != key) continue;
      foreach (var v in s.vols) {
        if (vol >= 0) v.SetMasterVolume(Math.Max(0f, Math.Min(1f, vol)), ref g);
        if (mute >= 0) v.SetMute(mute == 1, ref g);
      }
    }
  }
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p);
  int UnregisterControlChangeNotify(IntPtr p);
  int GetChannelCount(out int c);
  int SetMasterVolumeLevel(float l, ref Guid ctx);
  int SetMasterVolumeLevelScalar(float l, ref Guid ctx);
  int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint ch, float l, ref Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float l);
  int GetChannelVolumeLevelScalar(uint ch, out float l);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}

[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

// Reserva una franja arriba del monitor principal (como YASB con windows_app_bar),
// para que GlazeWM y las ventanas maximizadas no queden debajo del notch.
public class AppBar : NativeWindow {
  [StructLayout(LayoutKind.Sequential)]
  struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string s);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);

  static AppBar inst;
  static readonly object gate = new object();
  uint cbMsg; int height; RECT mon; bool registered;

  public static void Start(int l, int t, int r, int b, int heightPx) {
    lock (gate) {
      if (inst != null) { inst.mon = new RECT { L = l, T = t, R = r, B = b }; inst.height = heightPx; PostMessage(inst.Handle, 0x8001, IntPtr.Zero, IntPtr.Zero); return; }
      var th = new Thread(() => {
        var a = new AppBar();
        a.mon = new RECT { L = l, T = t, R = r, B = b }; a.height = heightPx;
        var cp = new CreateParams { Caption = "NotchAppBar", Style = unchecked((int)0x80000000), ExStyle = 0x00000080 | 0x08000000 }; // WS_POPUP, TOOLWINDOW|NOACTIVATE
        a.CreateHandle(cp);
        a.cbMsg = RegisterWindowMessage("NotchAppBarMessage");
        var d = a.Data(); d.uCallbackMessage = a.cbMsg;
        var okNew = SHAppBarMessage(0 /*ABM_NEW*/, ref d);
        Diag("appbar new=" + okNew);
        a.registered = true;
        a.SetPos();
        lock (gate) inst = a;
        Application.Run();
      });
      th.IsBackground = true; th.SetApartmentState(ApartmentState.STA); th.Start();
    }
  }
  public static void Stop() {
    lock (gate) {
      if (inst == null || !inst.registered) return;
      var d = inst.Data(); SHAppBarMessage(1 /*ABM_REMOVE*/, ref d); inst.registered = false;
      PostMessage(inst.Handle, 0x8002, IntPtr.Zero, IntPtr.Zero);
      inst = null;
    }
  }
  APPBARDATA Data() { var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(typeof(APPBARDATA)); d.hWnd = Handle; d.uEdge = 1; /*ABE_TOP*/ return d; }
  void SetPos() {
    if (!registered) return;
    var d = Data();
    d.rc = new RECT { L = mon.L, T = mon.T, R = mon.R, B = mon.T + height };
    SHAppBarMessage(2 /*ABM_QUERYPOS*/, ref d);
    int qT = d.rc.T, qB = d.rc.B;
    d.rc.B = d.rc.T + height;
    SHAppBarMessage(3 /*ABM_SETPOS*/, ref d);
    Diag("appbar setpos pedido=" + mon.T + ".." + (mon.T + height) + " query=" + qT + ".." + qB + " final=" + d.rc.T + ".." + d.rc.B);
  }
  static void Diag(string s) { try { Console.Out.WriteLine("{\"type\":\"diag\",\"msg\":\"" + s + "\"}"); Console.Out.Flush(); } catch { } }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x8001) { SetPos(); return; }
    if (m.Msg == 0x8002) { DestroyHandle(); Application.ExitThread(); return; }
    if (cbMsg != 0 && m.Msg == (int)cbMsg && (int)m.WParam == 1 /*ABN_POSCHANGED*/) { SetPos(); return; }
    base.WndProc(ref m);
  }
}

// ---------- Bandeja del sistema ----------
// Misma técnica que YASB / Zebar (systray-util): una ventana "Shell_TrayWnd" propia, siempre por
// delante de la real, recibe los Shell_NotifyIcon de las apps, guarda una copia de cada icono y
// reenvía TODO a la bandeja de Windows, que sigue funcionando igual. Si el notch se cierra, la
// ventana desaparece y las apps siguen hablando solo con la bandeja real.
public static class Tray {
  [StructLayout(LayoutKind.Sequential)] struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct NID {
    public uint cbSize; public uint hWnd; public uint uID; public uint uFlags; public uint uCallbackMessage; public uint hIcon;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
    public uint dwState; public uint dwStateMask;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
    public uint uVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
    public uint dwInfoFlags; public Guid guidItem; public uint hBalloonIcon;
  }
  [StructLayout(LayoutKind.Sequential)] struct TRAYDATA { public int magic; public uint msg; public NID nid; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WNDCLASSEX {
    public int cbSize; public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
    public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
    public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassEx(ref WNDCLASSEX c);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string n);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr m, string n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string s);
  [DllImport("user32.dll")] static extern bool SendNotifyMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

  class Icon { public uint hwnd, uid, cb, version, hicon; public string tip = "", png, exe = "", pin = ""; public bool hidden; public Guid guid; }
  static readonly object gate = new object();
  static Dictionary<string, Icon> icons = new Dictionary<string, Icon>();
  static Dictionary<uint, string> pngCache = new Dictionary<uint, string>();
  public static volatile bool Dirty;
  public static volatile string Status = "";
  public static int Msgs;
  static IntPtr hwnd = IntPtr.Zero, realTray = IntPtr.Zero;
  delegate IntPtr WndProcD(IntPtr h, uint m, IntPtr w, IntPtr l);
  static WndProcD procKeep; // evita que el GC libere el delegado
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public POINT p; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowEx(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  static IntPtr H(uint v) { return new IntPtr(unchecked((int)v)); } // los handles llegan truncados a 32 bits

  public static void Start() {
    if (hwnd != IntPtr.Zero) return;
    var th = new Thread(() => {
      procKeep = WndProc;
      var wc = new WNDCLASSEX();
      wc.cbSize = Marshal.SizeOf(typeof(WNDCLASSEX));
      wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(procKeep);
      wc.hInstance = GetModuleHandle(null);
      wc.lpszClassName = "Shell_TrayWnd";
      RegisterClassEx(ref wc);
      // POPUP|CLIPSIBLINGS|CLIPCHILDREN, TOOLWINDOW|TOPMOST, sin tamaño y nunca visible.
      hwnd = CreateWindowEx(0x00000080 | 0x00000008, "Shell_TrayWnd", null, 0x80000000 | 0x04000000 | 0x02000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
      if (hwnd == IntPtr.Zero) { Status = "create-fail " + Marshal.GetLastWin32Error(); return; }
      FindReal();
      KeepOnTop();
      SetTimer(hwnd, new IntPtr(1), 100, IntPtr.Zero);
      Rescan();
      MSG msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
    });
    th.IsBackground = true; th.SetApartmentState(ApartmentState.STA); th.Start();
  }

  public static string Debug() {
    var sb = new StringBuilder(Status + " mine=" + hwnd + " real=" + realTray + " first=" + FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Shell_TrayWnd", null) + " order:");
    var h = GetTopWindow(IntPtr.Zero); int i = 0;
    while (h != IntPtr.Zero && i < 3000) {
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "Shell_TrayWnd") sb.Append(" [" + i + ":" + (h == hwnd ? "MINE" : "REAL") + "]");
      h = GetWindow(h, 2); i++;
    }
    return sb.ToString();
  }

  static void FindReal() {
    IntPtr h = IntPtr.Zero;
    while ((h = FindWindowEx(IntPtr.Zero, h, "Shell_TrayWnd", null)) != IntPtr.Zero) {
      if (h != hwnd) { realTray = h; return; }
    }
    realTray = IntPtr.Zero;
  }
  static void KeepOnTop() { SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); }

  // Pide a todas las apps que vuelvan a registrar sus iconos (lo mismo que hace Windows al reiniciar el explorador).
  public static void Rescan() {
    if (hwnd == IntPtr.Zero) return;
    KeepOnTop();
    SendNotifyMessage(new IntPtr(0xFFFF), RegisterWindowMessage("TaskbarCreated"), IntPtr.Zero, IntPtr.Zero);
  }
  // Al arrancar con Windows, muchas apps ya registraron su icono en la barra real o no atienden el primer
  // aviso: se repite a los 10 s y al minuto, y cada vez que la barra de tareas real se recrea.
  static int ticks; static IntPtr lastReal = IntPtr.Zero; static int rescanAt = -1;
  static void Tick() {
    ticks++;
    if (ticks == 100 || ticks == 600) Rescan();
    if (ticks % 10 == 0) {
      IntPtr cur = IntPtr.Zero, h = IntPtr.Zero;
      while ((h = FindWindowEx(IntPtr.Zero, h, "Shell_TrayWnd", null)) != IntPtr.Zero) { if (h != hwnd) { cur = h; break; } }
      if (cur != IntPtr.Zero && cur != lastReal) {
        if (lastReal != IntPtr.Zero) rescanAt = ticks + 30; // explorador reiniciado: avisar cuando esté listo
        lastReal = cur; realTray = cur;
      }
    }
    if (ticks == rescanAt) Rescan();
  }

  static IntPtr Forward(uint m, IntPtr w, IntPtr l) {
    if (realTray == IntPtr.Zero || !IsWindow(realTray)) FindReal();
    if (realTray == IntPtr.Zero) return IntPtr.Zero;
    IntPtr r;
    SendMessageTimeout(realTray, m, w, l, 0x0002 /*ABORTIFHUNG*/, 3000, out r);
    return r;
  }

  static IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l) {
    try {
      if (m == 0x0113 /*WM_TIMER*/) { KeepOnTop(); Tick(); return IntPtr.Zero; }
      if (m == 0x004A /*WM_COPYDATA*/) {
        Msgs++;
        try {
          var cds = (COPYDATASTRUCT)Marshal.PtrToStructure(l, typeof(COPYDATASTRUCT));
          if (cds.dwData == new IntPtr(1) && cds.cbData >= 24) OnNotify(cds);
        } catch {}
        return Forward(m, w, l);
      }
      if (m >= 0x0400 && m < 0xC000) return Forward(m, w, l);
    } catch {}
    return DefWindowProc(h, m, w, l);
  }

  static void OnNotify(COPYDATASTRUCT cds) {
    int size = Marshal.SizeOf(typeof(TRAYDATA));
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      var zero = new byte[size]; Marshal.Copy(zero, 0, buf, size);
      var bytes = new byte[Math.Min(size, cds.cbData)];
      Marshal.Copy(cds.lpData, bytes, 0, bytes.Length);
      Marshal.Copy(bytes, 0, buf, bytes.Length);
      var d = (TRAYDATA)Marshal.PtrToStructure(buf, typeof(TRAYDATA));
      var n = d.nid;
      bool byGuid = (n.uFlags & 0x20) != 0 && n.guidItem != Guid.Empty;
      string key = byGuid ? n.guidItem.ToString() : n.hWnd.ToString("X") + ":" + n.uID;
      lock (gate) {
        Icon ic;
        icons.TryGetValue(key, out ic);
        switch (d.msg) {
          case 0: case 1: // NIM_ADD / NIM_MODIFY
            if (ic == null) {
              if (d.msg == 1 && !byGuid) { /* modificar uno que no conocemos: lo añadimos igual */ }
              ic = new Icon { hwnd = n.hWnd, uid = n.uID, guid = n.guidItem };
              uint pid; GetWindowThreadProcessId(H(n.hWnd), out pid);
              try { ic.exe = Process.GetProcessById((int)pid).ProcessName; } catch {}
              // Identificador estable entre reinicios de la app (para recordar los iconos fijados en la barra).
              ic.pin = byGuid ? n.guidItem.ToString() : ic.exe.ToLowerInvariant() + ":" + n.uID;
              icons[key] = ic;
            }
            if (n.hWnd != 0) ic.hwnd = n.hWnd;
            if ((n.uFlags & 0x01) != 0) ic.cb = n.uCallbackMessage;
            if ((n.uFlags & 0x04) != 0) ic.tip = n.szTip ?? "";
            if ((n.uFlags & 0x08) != 0) ic.hidden = (n.dwState & n.dwStateMask & 0x1) != 0;
            if ((n.uFlags & 0x02) != 0 && n.hIcon != 0) { ic.hicon = n.hIcon; ic.png = ToPng(n.hIcon); }
            break;
          case 2: // NIM_DELETE
            icons.Remove(key);
            break;
          case 4: // NIM_SETVERSION
            if (ic != null) ic.version = n.uVersion;
            break;
        }
      }
      Dirty = true;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static string ToPng(uint hicon) {
    string s;
    if (pngCache.TryGetValue(hicon, out s)) return s;
    try {
      using (var ico = System.Drawing.Icon.FromHandle(H(hicon)))
      using (var bmp = ico.ToBitmap())
      using (var ms = new System.IO.MemoryStream()) {
        bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
        s = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
      }
    } catch { s = null; }
    if (pngCache.Count > 300) pngCache.Clear();
    pngCache[hicon] = s;
    return s;
  }

  static string J(string v) { return (v ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " "); }
  public static string Snapshot() {
    Dirty = false;
    var sb = new StringBuilder("[");
    lock (gate) {
      bool first = true;
      foreach (var kv in icons) {
        var ic = kv.Value;
        if (ic.hidden || !IsWindow(H(ic.hwnd))) continue;
        if (!first) sb.Append(","); first = false;
        sb.AppendFormat("{{\"key\":\"{0}\",\"pin\":\"{4}\",\"tip\":\"{1}\",\"exe\":\"{2}\",\"icon\":\"{3}\"}}", J(kv.Key), J(ic.tip), J(ic.exe), ic.png ?? "", J(ic.pin));
      }
    }
    return sb.Append("]").ToString();
  }

  // Simula el clic que haría la bandeja de Windows sobre el icono.
  public static void Click(string key, string button) {
    Icon ic;
    lock (gate) { if (!icons.TryGetValue(key, out ic)) return; }
    var h = H(ic.hwnd);
    uint pid; GetWindowThreadProcessId(h, out pid);
    // Permite que la app traiga al frente su ventana o su menú (si no, el menú no aparece o no se cierra bien).
    var fg = GetForegroundWindow(); uint dummy; uint fgTid = GetWindowThreadProcessId(fg, out dummy); uint me = GetCurrentThreadId();
    bool att = fgTid != 0 && fgTid != me && AttachThreadInput(me, fgTid, true);
    // Las apps Electron (Discord) solo abren el menú si consiguen ponerse en primer plano; si no, no sale
    // nada. Se lo damos hecho: la ventana del icono pasa a primer plano antes de mandarle el clic.
    bool ok = SetForegroundWindow(h);
    if (!ok) {
      // Truco estándar: una pulsación de Alt libera el bloqueo de primer plano de Windows.
      keybd_event(0x12, 0, 1, UIntPtr.Zero); keybd_event(0x12, 0, 3, UIntPtr.Zero);
      ok = SetForegroundWindow(h);
    }
    AllowSetForegroundWindow(pid);
    if (att) AttachThreadInput(me, fgTid, false);
    try { Console.Out.WriteLine("{\"type\":\"diag\",\"msg\":\"trayclick " + button + " v" + ic.version + " fg=" + (ok ? "ok" : "FALLO") + (GetForegroundWindow() == h ? " delante" : " detras") + "\"}"); Console.Out.Flush(); } catch { }
    POINT p; GetCursorPos(out p);
    uint cb = ic.cb; if (cb == 0) return;
    Func<uint, IntPtr> L4 = (msg) => new IntPtr(unchecked((int)((ic.uid << 16) | (msg & 0xFFFF))));
    var anchor = new IntPtr(unchecked((int)(((p.Y & 0xFFFF) << 16) | (p.X & 0xFFFF))));
    if (ic.version >= 4) {
      if (button == "right") {
        PostMessage(h, cb, anchor, L4(0x0204)); PostMessage(h, cb, anchor, L4(0x0205)); PostMessage(h, cb, anchor, L4(0x007B));
      } else if (button == "double") {
        PostMessage(h, cb, anchor, L4(0x0203)); PostMessage(h, cb, anchor, L4(0x0202));
      } else {
        PostMessage(h, cb, anchor, L4(0x0201)); PostMessage(h, cb, anchor, L4(0x0202)); PostMessage(h, cb, anchor, L4(0x0400 /*NIN_SELECT*/));
      }
    } else {
      var wp = new IntPtr(unchecked((int)ic.uid));
      if (button == "right") { PostMessage(h, cb, wp, new IntPtr(0x0204)); PostMessage(h, cb, wp, new IntPtr(0x0205)); }
      else if (button == "double") { PostMessage(h, cb, wp, new IntPtr(0x0203)); PostMessage(h, cb, wp, new IntPtr(0x0202)); }
      else { PostMessage(h, cb, wp, new IntPtr(0x0201)); PostMessage(h, cb, wp, new IntPtr(0x0202)); }
    }
  }
}

// ---------- Clics fuera del notch ----------
// Hook de ratón de bajo nivel SOLO de lectura: no bloquea ni modifica nada, solo avisa de que
// hubo un clic (y solo mientras el panel está abierto) para poder cerrarlo al pulsar fuera.
public static class ClickWatch {
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  static HookProc procKeep;
  static IntPtr hook = IntPtr.Zero;
  public static volatile bool Enabled;
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public POINT p; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string n);
  public static void Start() {
    if (hook != IntPtr.Zero) return;
    var th = new Thread(() => {
      procKeep = (code, w, l) => {
        int m = (int)w;
        // WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN
        if (code >= 0 && Enabled && (m == 0x0201 || m == 0x0204 || m == 0x0207)) {
          try { Console.Out.WriteLine("{\"type\":\"click\"}"); Console.Out.Flush(); } catch {}
        }
        return CallNextHookEx(hook, code, w, l);
      };
      hook = SetWindowsHookEx(14 /*WH_MOUSE_LL*/, procKeep, GetModuleHandle(null), 0);
      try { Console.Out.WriteLine("{\"type\":\"diag\",\"msg\":\"hook de clics " + (hook != IntPtr.Zero ? "activo" : "FALLÓ " + Marshal.GetLastWin32Error()) + "\"}"); Console.Out.Flush(); } catch {}
      MSG msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
    });
    th.IsBackground = true; th.Start();
  }
}

public static class Notch {
  static ConcurrentQueue<string> cmds = new ConcurrentQueue<string>();
  public static void StartReader() {
    var t = new Thread(() => {
      string l;
      while ((l = Console.In.ReadLine()) != null) {
        // Los clics de la bandeja se atienden aquí mismo, sin esperar al bucle de sondeo (que puede tardar
        // casi un segundo mientras lee multimedia): si no, el menú tarda y un segundo clic lo cierra.
        if (l.IndexOf("\"trayclick\"") >= 0) {
          var m = System.Text.RegularExpressions.Regex.Match(l, "\"key\":\"((?:[^\"\\\\]|\\\\.)*)\".*?\"button\":\"(\\w+)\"");
          if (m.Success) { try { Tray.Click(System.Text.RegularExpressions.Regex.Unescape(m.Groups[1].Value), m.Groups[2].Value); } catch { } continue; }
        }
        // Igual con el cambio de idioma: sin esperar al bucle se nota al instante.
        if (l.IndexOf("\"layout\"") >= 0) {
          var m = System.Text.RegularExpressions.Regex.Match(l, "\"hkl\":\"([0-9A-Fa-f]+)\"");
          if (m.Success) { try { SetLayout(m.Groups[1].Value); } catch { } continue; }
        }
        cmds.Enqueue(l);
      }
      AppBar.Stop();            // libera la franja reservada
      Environment.Exit(0);      // Electron se cerró
    });
    t.IsBackground = true; t.Start();
  }
  public static string Next() { string s; return cmds.TryDequeue(out s) ? s : null; }

  // ---------- Audio ----------
  static IAudioEndpointVolume Endpoint(int flow) {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice dev;
    if (en.GetDefaultAudioEndpoint(flow, 0, out dev) != 0 || dev == null) return null;
    var iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null;
    return o as IAudioEndpointVolume;
  }
  public static float GetVol(int flow) { var e = Endpoint(flow); if (e == null) return -1; float v; e.GetMasterVolumeLevelScalar(out v); return v; }
  public static bool GetMute(int flow) { var e = Endpoint(flow); if (e == null) return false; bool m; e.GetMute(out m); return m; }
  public static void SetVol(int flow, float v) {
    var e = Endpoint(flow); if (e == null) return; var g = Guid.Empty;
    e.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), ref g);
    if (v > 0) e.SetMute(false, ref g);
  }
  public static void SetMute(int flow, bool m) { var e = Endpoint(flow); if (e == null) return; var g = Guid.Empty; e.SetMute(m, ref g); }

  // ---------- Ventanas ----------
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint tid);
  [DllImport("user32.dll")] static extern int GetKeyboardLayoutList(int n, [Out] IntPtr[] list);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint f);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  public static void InitDpi() {
    // Per-monitor v2: coordenadas físicas reales aunque los monitores tengan escalas distintas.
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    SetProcessDPIAware();
  }

  public static uint NotchPid;
  public static string Title = "", Exe = "", Lang = "", LangName = "";
  public static bool Fullscreen;
  static IntPtr lastExt = IntPtr.Zero;   // última ventana en primer plano que no es el notch
  static uint lastPid;
  static int fsCount;

  public static void Poll() {
    var h = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(h, out pid);
    // Solo ventanas visibles de otras apps: al hacer clic en un icono de la bandeja la app pone delante
    // una ventana oculta suya, y las del propio helper (bandeja falsa, AppBar) tampoco cuentan.
    if (h != IntPtr.Zero && pid != NotchPid && pid != SelfPid && IsWindowVisible(h)) lastExt = h;
    if (lastExt != IntPtr.Zero && !IsWindow(lastExt)) lastExt = IntPtr.Zero;

    var w = lastExt;
    var sb = new StringBuilder(512);
    GetWindowText(w, sb, 512); Title = sb.ToString();
    uint wpid; uint tid = GetWindowThreadProcessId(w, out wpid);
    if (wpid != lastPid) {
      lastPid = wpid; Exe = "";
      try { Exe = Process.GetProcessById((int)wpid).MainModule.FileName; } catch {}
    }
    int lid = (int)((long)GetKeyboardLayout(tid) & 0xFFFF);
    if (lid != 0) {
      try { var c = new CultureInfo(lid); Lang = c.TwoLetterISOLanguageName.ToUpper(); LangName = c.DisplayName; } catch {}
    }

    // Pantalla completa, todas a la vez:
    //  1) el shell de Windows dice que hay una app a pantalla completa (criterio de notificaciones),
    //  2) la ventana en primer plano NO está maximizada (Claude, Steam y otras apps sin marco
    //     maximizadas ocupan el monitor entero y Windows las confunde con pantalla completa),
    //  3) cubre por completo el monitor principal,
    //  4) se cumple en 2 lecturas seguidas (Alt+Tab, Inicio, etc. no cuentan).
    // Ya no depende de qué ventana tiene el foco: se mira la ventana que está ENCIMA de todo en el
    // monitor principal (un juego a pantalla completa sigue ahí aunque estés en Discord en el otro monitor).
    var prim = MonitorFromPoint(new POINT { X = 0, Y = 0 }, 1 /*PRIMARY*/);
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(prim, ref mi);
    IntPtr top = TopAppWindow(mi.rcMonitor);
    bool fs = false; bool zoomed = false; RECT fr = new RECT();
    if (top != IntPtr.Zero) {
      zoomed = IsZoomed(top);
      GetWindowRect(top, out fr);
      // Tolerancia de unos píxeles: al tabular fuera de un juego, Windows encoge su ventana 1 px
      // (p. ej. Valorant pasa de 1920x1080 a 1920x1079) para no tratarla como pantalla completa.
      const int tol = 4;
      bool covers = fr.L <= mi.rcMonitor.L + tol && fr.T <= mi.rcMonitor.T + tol && fr.R >= mi.rcMonitor.R - tol && fr.B >= mi.rcMonitor.B - tol;
      fs = covers && !zoomed; // maximizada (Claude, Steam…) no cuenta
    }
    fsCount = fs ? fsCount + 1 : 0;
    bool now = fsCount >= 2;
    if (now != Fullscreen) {
      var cls = new StringBuilder(128); GetClassName(top, cls, 128);
      uint tp; GetWindowThreadProcessId(top, out tp);
      string pn = ""; try { pn = Process.GetProcessById((int)tp).ProcessName; } catch {}
      FsDiag = string.Format("{0} -> {1} | {2} {3} zoomed={4} rect=({5},{6},{7},{8})",
        Fullscreen, now, pn, cls, zoomed, fr.L, fr.T, fr.R, fr.B);
    }
    Fullscreen = now;
  }

  // Primera ventana "de verdad" en el orden de apilado que toque el monitor principal.
  // Se saltan: las del notch, el escritorio/barra de tareas, ventanas de herramienta y las capas
  // transparentes que dejan pasar los clics (superposiciones de NVIDIA, Steam, Discord…).
  static readonly uint SelfPid = (uint)Process.GetCurrentProcess().Id;
  static IntPtr TopAppWindow(RECT mon) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((w, l) => {
      if (!IsWindowVisible(w)) return true;
      int cloaked; DwmGetWindowAttribute(w, 14, out cloaked, 4); if (cloaked != 0) return true;
      uint p; GetWindowThreadProcessId(w, out p); if (p == NotchPid || p == SelfPid) return true;
      int ex = GetWindowLong(w, -20);
      if ((ex & 0x80) != 0 || (ex & 0x20) != 0 || (ex & 0x08000000) != 0) return true; // TOOLWINDOW, TRANSPARENT, NOACTIVATE
      var c = new StringBuilder(64); GetClassName(w, c, 64); var cs = c.ToString();
      if (cs == "Progman" || cs == "WorkerW" || cs == "Shell_TrayWnd" || cs == "Shell_SecondaryTrayWnd") return true;
      RECT r; GetWindowRect(w, out r);
      if (r.R - r.L < 100 || r.B - r.T < 100) return true;
      if (r.R <= mon.L || r.L >= mon.R || r.B <= mon.T || r.T >= mon.B) return true; // no toca el principal
      found = w; return false;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  public static string FsDiag = null;
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);

  public static string Layouts() {
    var arr = new IntPtr[32]; int n = GetKeyboardLayoutList(32, arr);
    var sb = new StringBuilder("[");
    for (int i = 0; i < n; i++) {
      long hkl = (long)arr[i]; int lid = (int)(hkl & 0xFFFF);
      string code = "", name = "";
      try { var c = new CultureInfo(lid); code = c.TwoLetterISOLanguageName.ToUpper(); name = c.DisplayName; } catch { code = lid.ToString("X4"); }
      if (i > 0) sb.Append(",");
      sb.AppendFormat("{{\"hkl\":\"{0:X}\",\"code\":\"{1}\",\"name\":\"{2}\"}}", hkl, code, name.Replace("\"", "'"));
    }
    return sb.Append("]").ToString();
  }
  public static void SetLayout(string hklHex) {
    long hkl; if (!long.TryParse(hklHex, NumberStyles.HexNumber, null, out hkl)) return;
    // Destino: la ventana en primer plano si es de otra app; si no (el notch tiene el foco), la última.
    var fg = GetForegroundWindow(); uint fpid; GetWindowThreadProcessId(fg, out fpid);
    var target = (fg != IntPtr.Zero && fpid != NotchPid && fpid != SelfPid && IsWindowVisible(fg)) ? fg : lastExt;
    if (target != IntPtr.Zero) { var root = GetAncestor(target, 3 /*GA_ROOTOWNER*/); if (root != IntPtr.Zero) target = root; }
    var c = new StringBuilder(64); if (target != IntPtr.Zero) GetClassName(target, c, 64);
    var cs = c.ToString();
    // El escritorio y la barra de tareas ignoran la petición: entonces se manda a todas las ventanas
    // (con la distribución común a todas las apps, que es lo normal en Windows, equivale a cambiarla).
    if (target == IntPtr.Zero || cs == "Progman" || cs == "WorkerW" || cs == "Shell_TrayWnd" || cs == "Shell_SecondaryTrayWnd") {
      target = new IntPtr(0xFFFF); /*HWND_BROADCAST*/ c = new StringBuilder("todas (" + cs + ")");
    }
    bool ok = PostMessage(target, 0x0050 /*WM_INPUTLANGCHANGEREQUEST*/, IntPtr.Zero, new IntPtr(hkl));
    // Ventanas de apps elevadas (p. ej. el Administrador de tareas) rechazan el mensaje: a todas
    if (!ok && target != new IntPtr(0xFFFF)) { ok = PostMessage(new IntPtr(0xFFFF), 0x0050, IntPtr.Zero, new IntPtr(hkl)); c.Append(" -> todas"); }
    try { Console.Out.WriteLine("{\"type\":\"diag\",\"msg\":\"layout " + hklHex + " -> " + c + " ok=" + ok + "\"}"); Console.Out.Flush(); } catch { }
  }
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);

  // ---------- Spotify sin controles multimedia de Windows ----------
  // Igual que el agente del home-dashboard: su ventana se llama "Artista - Canción" mientras suena
  // y "Spotify ..." en pausa. Se controla con las teclas multimedia globales.
  static HashSet<uint> spPids = new HashSet<uint>();
  static DateTime spAt = DateTime.MinValue;
  public static string SpotifyTitle() {
    if ((DateTime.Now - spAt).TotalSeconds > 5) {
      spPids.Clear();
      foreach (var p in Process.GetProcessesByName("Spotify")) spPids.Add((uint)p.Id);
      spAt = DateTime.Now;
    }
    if (spPids.Count == 0) return null;
    string track = null; bool paused = false;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!spPids.Contains(pid)) return true;
      int n = GetWindowTextLength(h); if (n == 0) return true;
      var sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1);
      var t = sb.ToString();
      if (t.Contains(" - ") && track == null) track = t;
      else if (t.StartsWith("Spotify")) paused = true;
      return true;
    }, IntPtr.Zero);
    if (track != null) return "P|" + track;
    if (paused) return "S|";
    return null;
  }
  public static void MediaKey(string action) {
    byte vk = action == "next" ? (byte)0xB0 : action == "prev" ? (byte)0xB1 : (byte)0xB3;
    keybd_event(vk, 0, 1, UIntPtr.Zero);
    keybd_event(vk, 0, 3, UIntPtr.Zero);
  }
}
'@

[Notch]::InitDpi()
[Notch]::NotchPid = [uint32]($env:NOTCH_PID -as [int])
[Notch]::StartReader()

# ---------- WinRT (SMTC) ----------
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  if ($task.Wait(1500)) { return $task.Result } else { return $null }
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$TMgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$TProps = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$TStream = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
$mgr = Await ($TMgr::RequestAsync()) $TMgr

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }

$ignore = @(($env:NOTCH_MEDIA_IGNORE -split '\|') | Where-Object { $_ })
function Is-Ignored($s) {
  $id = [string]$s.SourceAppUserModelId
  foreach ($x in $ignore) { if ($id -like "*$x*") { return $true } }
  return $false
}
# Elige la sesión: primero una que esté sonando, luego la misma de antes, luego la "actual".
function Get-Session {
  if (-not $mgr) { return $null }
  $all = @($mgr.GetSessions() | Where-Object { $_ -and -not (Is-Ignored $_) })
  if ($all.Count -eq 0) { return $null }
  $pick = $all | Where-Object { [int]$_.GetPlaybackInfo().PlaybackStatus -eq 4 } | Select-Object -First 1
  if (-not $pick -and $script:lastId) { $pick = $all | Where-Object { $_.SourceAppUserModelId -eq $script:lastId } | Select-Object -First 1 }
  if (-not $pick) {
    $cur = $mgr.GetCurrentSession()
    if ($cur -and -not (Is-Ignored $cur)) { $pick = $cur } else { $pick = $all[0] }
  }
  $script:lastId = $pick.SourceAppUserModelId
  return $pick
}

$script:thumbKey = ''
$script:spLast = $null
function Send-Thumb($key, $data, $artist, $title) {
  if ($key -eq $script:thumbKey) { return }
  $script:thumbKey = $key
  Emit @{ type = 'thumb'; key = $key; data = $data; artist = $artist; title = $title }
}

function Get-SmtcMedia {
  $s = Get-Session
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) $TProps
  if (-not $p -or (-not $p.Title -and -not $p.Artist)) { return $null }
  $pb = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $key = "$($p.Title)|$($p.Artist)"
  if ($key -ne $script:thumbKey) {
    $data = $null
    if ($p.Thumbnail) {
      $st = Await ($p.Thumbnail.OpenReadAsync()) $TStream
      if ($st) {
        $ns = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($st)
        $ms = New-Object System.IO.MemoryStream
        $ns.CopyTo($ms)
        $mime = if ($st.ContentType) { $st.ContentType } else { 'image/png' }
        if ($ms.Length -gt 0) { $data = "data:$mime;base64," + [Convert]::ToBase64String($ms.ToArray()) }
        $ms.Dispose(); $ns.Dispose()
      }
    }
    Send-Thumb $key $data $p.Artist $p.Title
  }
  return @{
    key = $key; source = 'smtc'
    title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle
    app = $s.SourceAppUserModelId
    playing = ([int]$pb.PlaybackStatus -eq 4)
    canNext = $pb.Controls.IsNextEnabled
    canPrev = $pb.Controls.IsPreviousEnabled
    canSeek = $pb.Controls.IsPlaybackPositionEnabled
    pos = [math]::Round($tl.Position.TotalSeconds, 1)
    dur = [math]::Round(($tl.EndTime - $tl.StartTime).TotalSeconds, 1)
    upd = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
  }
}

function Get-SpotifyMedia {
  $r = [Notch]::SpotifyTitle()
  if (-not $r) { $script:spLast = $null; return $null }
  if ($r.StartsWith('P|')) {
    $parts = $r.Substring(2) -split ' - ', 2
    $script:spLast = @{ artist = $parts[0]; title = $parts[1] }
    $playing = $true
  } elseif ($script:spLast) { $playing = $false } else { return $null }
  $key = "$($script:spLast.title)|$($script:spLast.artist)"
  Send-Thumb $key $null $script:spLast.artist $script:spLast.title
  return @{
    key = $key; source = 'window'
    title = $script:spLast.title; artist = $script:spLast.artist; album = ''
    app = 'Spotify.exe'; playing = $playing
    canNext = $true; canPrev = $true; canSeek = $false
    pos = 0; dur = 0; upd = 0
  }
}

function Get-Media {
  $m = Get-SmtcMedia
  if ($m -and $m.playing) { return $m }
  $sp = Get-SpotifyMedia
  if ($sp -and ($sp.playing -or -not $m)) { return $sp }
  return $m
}

function Handle($line) {
  try { $c = $line | ConvertFrom-Json } catch { return }
  switch ($c.cmd) {
    'vol'     { [Notch]::SetVol(0, [float]$c.v) }
    'mute'    { [Notch]::SetMute(0, -not [Notch]::GetMute(0)) }
    'micvol'  { [Notch]::SetVol(1, [float]$c.v) }
    'micmute' { [Notch]::SetMute(1, -not [Notch]::GetMute(1)) }
    'media' {
      if ($script:media -and $script:media.source -eq 'window') { [Notch]::MediaKey([string]$c.action) }
      else {
        $s = Get-Session
        if ($s) {
          $op = switch ($c.action) {
            'toggle' { $s.TryTogglePlayPauseAsync() }
            'next'   { $s.TrySkipNextAsync() }
            'prev'   { $s.TrySkipPreviousAsync() }
          }
          if ($op) { $null = Await $op ([bool]) }
        } else { [Notch]::MediaKey([string]$c.action) }
      }
      Start-Sleep -Milliseconds 350   # deja que la app actualice su estado
    }
    'seek' {
      $s = Get-Session
      if ($s) { $null = Await ($s.TryChangePlaybackPositionAsync([long]([double]$c.t * 10000000))) ([bool]) }
    }
    'appbar' {
      if ($c.on) { [AppBar]::Start([int]$c.l, [int]$c.t, [int]$c.r, [int]$c.b, [int]$c.h) } else { [AppBar]::Stop() }
    }
    'layout' { [Notch]::SetLayout([string]$c.hkl) }
    'tray' { if ($c.on) { [Tray]::Start() } }
    'trayrescan' { [Tray]::Rescan() }
    'dbg' { Emit @{ type = 'diag'; msg = ('tray msgs=' + [Tray]::Msgs + ' ' + [Tray]::Debug()) } }
    'trayclick' { [Tray]::Click([string]$c.key, [string]$c.button) }
    'devices' { [Console]::Out.WriteLine('{"type":"devices","list":' + [AudioX]::Devices() + '}'); [Console]::Out.Flush() }
    'setdevice' { [AudioX]::SetDefault([string]$c.id); [Console]::Out.WriteLine('{"type":"devices","list":' + [AudioX]::Devices() + '}'); [Console]::Out.Flush() }
    'sessions' { [Console]::Out.WriteLine('{"type":"sessions","list":' + [AudioX]::Sessions() + '}'); [Console]::Out.Flush() }
    'sessset' {
      $vol = if ($null -ne $c.v) { [float]$c.v } else { -1 }
      $mute = if ($null -ne $c.mute) { [int][bool]$c.mute } else { -1 }
      [AudioX]::SetSession([string]$c.key, $vol, $mute)
    }
    'clickwatch' { [ClickWatch]::Start(); [ClickWatch]::Enabled = [bool]$c.on }
  }
  $script:force = $true
}

$last = ''
$lastLayouts = ''
$tick = 0
$script:media = $null
$script:force = $true
while ($true) {
  while ($null -ne ($l = [Notch]::Next())) { Handle $l }
  [Notch]::Poll()
  # Con un juego a pantalla completa el notch está apartado: se sondea mucho menos (ver el Start-Sleep)
  $fs = [Notch]::Fullscreen
  if ($script:force -or ((-not $fs) -and ($tick % 4 -eq 0)) -or ($fs -and ($tick % 5 -eq 0))) { $script:media = Get-Media }
  if ([Tray]::Dirty -and ($tick % 2 -eq 0)) { [Console]::Out.WriteLine('{"type":"tray","list":' + [Tray]::Snapshot() + '}'); [Console]::Out.Flush() }
  if ([Notch]::FsDiag) { Emit @{ type = 'diag'; msg = 'fullscreen ' + [Notch]::FsDiag }; [Notch]::FsDiag = $null }
  if ($tick % 20 -eq 0) {
    $lj = [Notch]::Layouts()
    if ($lj -ne $lastLayouts) { $lastLayouts = $lj; [Console]::Out.WriteLine('{"type":"layouts","list":' + $lj + '}'); [Console]::Out.Flush() }
  }
  $state = @{
    type   = 'state'
    vol    = [math]::Round([Notch]::GetVol(0), 3)
    mute   = [Notch]::GetMute(0)
    mic    = [math]::Round([Notch]::GetVol(1), 3)
    micMute = [Notch]::GetMute(1)
    win    = @{ title = [Notch]::Title; exe = [Notch]::Exe }
    lang   = [Notch]::Lang
    langName = [Notch]::LangName
    fullscreen = [Notch]::Fullscreen
    media  = $script:media
  }
  $json = $state | ConvertTo-Json -Compress -Depth 4
  if ($json -ne $last) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $last = $json }
  $script:force = $false
  $tick++
  if ($fs) { Start-Sleep -Milliseconds 1000 } else { Start-Sleep -Milliseconds 250 }
}
