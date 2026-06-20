Add-Type -AssemblyName System.Drawing

function Make-TransparentLogo {
    param(
        [string]$InputPath,
        [string]$OutputPath,
        [int]$Threshold = 38
    )

    $src = [System.Drawing.Bitmap]::FromFile($InputPath)
    $dst = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            $p = $src.GetPixel($x, $y)
            $max = [Math]::Max($p.R, [Math]::Max($p.G, $p.B))
            $min = [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
            $sat = $max - $min

            if ($max -le $Threshold) {
                $c = [System.Drawing.Color]::FromArgb(0, $p.R, $p.G, $p.B)
            }
            elseif ($max -le ($Threshold + 28) -and $sat -le 18) {
                $alpha = [int](255 * ($max - $Threshold) / 28)
                $alpha = [Math]::Max(0, [Math]::Min(255, $alpha))
                $c = [System.Drawing.Color]::FromArgb($alpha, $p.R, $p.G, $p.B)
            }
            else {
                $c = [System.Drawing.Color]::FromArgb(255, $p.R, $p.G, $p.B)
            }

            $dst.SetPixel($x, $y, $c)
        }
    }

    $dst.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $src.Dispose()
    $dst.Dispose()
}

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcPath = Join-Path $base "logo-manabi-power-src.png"
if (-not (Test-Path $srcPath)) {
    Copy-Item (Join-Path $env:USERPROFILE "Downloads\Nueva carpeta\logo-manabi-power.png") $srcPath -Force
}

$fullOut = Join-Path $base "logo-manabi-power.png"
$smOut = Join-Path $base "logo-manabi-power-sm.png"

Make-TransparentLogo -InputPath $srcPath -OutputPath $fullOut -Threshold 38

$img = [System.Drawing.Bitmap]::FromFile($fullOut)
$ratio = 400.0 / $img.Width
$nh = [int]($img.Height * $ratio)
$bmp = New-Object System.Drawing.Bitmap(400, $nh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, 400, $nh)
$bmp.Save($smOut, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$img.Dispose()

Write-Output "Transparent logos created:"
Get-Item $fullOut, $smOut | Select-Object Name, Length