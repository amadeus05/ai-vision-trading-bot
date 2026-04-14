# Export all text files under .\src into one txt with path headers and separators.
# Run: powershell -ExecutionPolicy Bypass -File .\export-src.ps1
# Or double-click export-src.bat

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcRoot = Join-Path $projectRoot 'src'
$outFile = Join-Path $projectRoot 'src-export.txt'

if (-not (Test-Path -LiteralPath $srcRoot -PathType Container)) {
    Write-Error "Folder not found: $srcRoot"
    exit 1
}

# Skip common binary extensions; everything else is treated as text
$skipExt = @(
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
    '.pdf', '.zip', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp4', '.webm', '.mp3', '.wav', '.ogg',
    '.bin', '.dat', '.sqlite', '.db'
)

$files = Get-ChildItem -LiteralPath $srcRoot -Recurse -File -ErrorAction Stop |
    Where-Object { $skipExt -notcontains $_.Extension.ToLowerInvariant() } |
    Sort-Object { $_.FullName }

$sep = ('=' * 80)
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$sb = New-Object System.Text.StringBuilder

[void]$sb.AppendLine('# Export of src/')
[void]$sb.AppendLine("# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
[void]$sb.AppendLine('')

foreach ($f in $files) {
    # Relative path from project root (PS 5.1 compatible)
    $rel = $f.FullName.Substring($projectRoot.Length).TrimStart([char[]]@('\', '/'))
    [void]$sb.AppendLine($sep)
    [void]$sb.AppendLine("FILE: $rel")
    [void]$sb.AppendLine($sep)
    try {
        $text = [System.IO.File]::ReadAllText($f.FullName)
        [void]$sb.AppendLine($text)
    } catch {
        [void]$sb.AppendLine("[read error: $($_.Exception.Message)]")
    }
    [void]$sb.AppendLine('')
}

[System.IO.File]::WriteAllText($outFile, $sb.ToString(), $utf8NoBom)
Write-Host "Done: $outFile ($($files.Count) file(s))"
