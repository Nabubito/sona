<#
  Forge by Sona: build an ISO image from a folder.
  Uses IMAPI2, the disc-image API built into Windows. No extra tools, no size cap.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File make-iso.ps1 -Source <folder> -Out <file.iso> [-Label NAME]

  Prints "CREATED <path>" on success.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Source folder not found: $Source" }
$Source = (Resolve-Path -LiteralPath $Source).Path
$vol = if ($Label) { $Label } else { Split-Path $Source -Leaf }
if ($vol.Length -gt 32) { $vol = $vol.Substring(0, 32) }

# PowerShell cannot marshal IStream.Read by itself, so a tiny compiled helper
# copies the IMAPI2 result stream to disk block by block.
$writer = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace SonaForge {
  public static class IsoWriter {
    public static void Save(string path, object comStream, int blockSize, long totalBlocks) {
      IStream stream = comStream as IStream;
      if (stream == null) throw new Exception("Not an IStream.");
      byte[] buf = new byte[blockSize];
      IntPtr read = Marshal.AllocHGlobal(4);
      try {
        using (FileStream fs = File.Open(path, FileMode.Create, FileAccess.Write)) {
          while (totalBlocks-- > 0) {
            stream.Read(buf, blockSize, read);
            int n = Marshal.ReadInt32(read);
            if (n <= 0) break;
            fs.Write(buf, 0, n);
          }
          fs.Flush();
        }
      } finally { Marshal.FreeHGlobal(read); }
    }
  }
}
'@
if (-not ('SonaForge.IsoWriter' -as [type])) { Add-Type -TypeDefinition $writer | Out-Null }

$fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$fsi.FileSystemsToCreate = 7   # ISO9660 + Joliet + UDF, for the widest compatibility
$fsi.VolumeName = $vol
$fsi.Root.AddTree($Source, $false)
$res = $fsi.CreateResultImage()

$Out = [System.IO.Path]::GetFullPath($Out)
$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[SonaForge.IsoWriter]::Save($Out, $res.ImageStream, [int]$res.BlockSize, [long]$res.TotalBlocks)

$sz = (Get-Item -LiteralPath $Out).Length
Write-Output ("CREATED  $Out  ({0:N1} MB)" -f ($sz / 1MB))
