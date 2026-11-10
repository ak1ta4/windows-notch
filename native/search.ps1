# Buscador del notch (Windows PowerShell 5.1). Lee comandos JSON por stdin y responde JSON, una linea por mensaje.
#   {"cmd":"apps"}                 -> apps del menu Inicio (escritorio y Store) con su icono
#   {"cmd":"files","q":"...","id":N} -> archivos y carpetas del indice de Windows Search
# Fichero solo ASCII a proposito: PowerShell 5.1 lee los .ps1 sin BOM como ANSI.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class ShellIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, out BITMAP bm);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

  // PNG en base64 del icono de un elemento del shell (p. ej. "shell:AppsFolder\<AppID>"), con transparencia.
  public static string Png(string parsingName, int px) {
    IntPtr hbm = IntPtr.Zero;
    try {
      IShellItemImageFactory f;
      SHCreateItemFromParsingName(parsingName, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
      // SIIGBF_ICONONLY (0x4) | SIIGBF_BIGGERSIZEOK (0x1)
      if (f.GetImage(new SIZE { cx = px, cy = px }, 0x5, out hbm) != 0 || hbm == IntPtr.Zero) return null;
      BITMAP bm; GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), out bm);
      if (bm.bmBits == IntPtr.Zero || bm.bmBitsPixel != 32) return null;
      int w = bm.bmWidth, h = Math.Abs(bm.bmHeight), stride = bm.bmWidthBytes;
      var data = new byte[stride * h];
      Marshal.Copy(bm.bmBits, data, 0, data.Length);
      using (var b = new Bitmap(w, h, PixelFormat.Format32bppPArgb)) {
        var bd = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        // Los DIB vienen de abajo arriba
        for (int y = 0; y < h; y++) Marshal.Copy(data, (bm.bmHeight > 0 ? h - 1 - y : y) * stride, new IntPtr(bd.Scan0.ToInt64() + y * bd.Stride), w * 4);
        b.UnlockBits(bd);
        using (var ms = new MemoryStream()) { b.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
      }
    } catch { return null; }
    finally { if (hbm != IntPtr.Zero) DeleteObject(hbm); }
  }
}
'@

function Out-Json($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

function Get-Apps {
  $seen = @{}
  $list = foreach ($a in Get-StartApps) {
    if (-not $a.AppID -or $seen.ContainsKey($a.AppID)) { continue }
    $seen[$a.AppID] = 1
    $n = $a.Name
    # Desinstaladores, ayudas y webs del menu Inicio: ruido en un buscador
    if ($n -match '(?i)^(uninstall|desinstalar)|uninstall$|desinstalar$|readme|l.?ame|website|help$|ayuda$|^Documentation') { continue }
    $png = [ShellIcon]::Png("shell:AppsFolder\" + $a.AppID, 32)
    [pscustomobject]@{ name = $n; id = $a.AppID; icon = $(if ($png) { 'data:image/png;base64,' + $png } else { $null }) }
  }
  Out-Json @{ type = 'apps'; list = @($list) }
}

$conn = $null
function Find-Files($q, $id) {
  $rows = New-Object System.Collections.ArrayList
  try {
    if (-not $conn -or $conn.State -ne 'Open') {
      $script:conn = New-Object System.Data.OleDb.OleDbConnection "Provider=Search.CollatorDSO;Extended Properties='Application=Windows';"
      $script:conn.Open()
    }
    # Cada palabra debe aparecer en el nombre (en cualquier orden)
    $words = @($q -split '\s+' | Where-Object { $_ } | ForEach-Object { $_.Replace("'", "''").Replace('%', '[%]').Replace('_', '[_]') })
    if ($words.Count -eq 0) { Out-Json @{ type = 'files'; id = $id; list = @() }; return }
    $where = ($words | ForEach-Object { "System.FileName LIKE '%$_%'" }) -join ' AND '
    $sql = "SELECT TOP 60 System.ItemUrl, System.FileName, System.ItemType, System.DateModified FROM SYSTEMINDEX WHERE $where AND System.ItemUrl LIKE 'file:%' ORDER BY System.DateModified DESC"
    $cmd = $script:conn.CreateCommand(); $cmd.CommandText = $sql
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
      $p = ([string]$r[0]) -replace '^file:', '' -replace '/', '\'
      if ($p -match '(?i)\\(node_modules|\.git|AppData\\Local\\Temp|\$Recycle\.Bin)\\') { continue }
      [void]$rows.Add([pscustomobject]@{ path = $p; name = [string]$r[1]; kind = [string]$r[2]; dir = ([string]$r[2] -eq 'Directory') })
    }
    $r.Close()
  } catch { $script:conn = $null }
  Out-Json @{ type = 'files'; id = $id; list = @($rows) }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $c = $line | ConvertFrom-Json } catch { continue }
  switch ($c.cmd) {
    'apps'  { Get-Apps }
    'files' { Find-Files ([string]$c.q) $c.id }
  }
}
