param([Parameter(Mandatory)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
$resolvedOutput = [IO.Path]::GetFullPath($OutputFile)
$expectedDirectory = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path '.local/package'))
if ([IO.Path]::GetDirectoryName($resolvedOutput) -ne $expectedDirectory) { throw 'ICON_PATH_REFUSED' }
Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$shape = [Drawing.Drawing2D.GraphicsPath]::new()
$background = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#27272a'))
$pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#fafafa'), 16)
$memory = [IO.MemoryStream]::new()
try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.Color]::Transparent)
    $shape.AddArc(12, 12, 64, 64, 180, 90)
    $shape.AddArc(180, 12, 64, 64, 270, 90)
    $shape.AddArc(180, 180, 64, 64, 0, 90)
    $shape.AddArc(12, 180, 64, 64, 90, 90)
    $shape.CloseFigure()
    $graphics.FillPath($background, $shape)
    $pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawLines($pen, [Drawing.Point[]]@([Drawing.Point]::new(70, 82), [Drawing.Point]::new(116, 128), [Drawing.Point]::new(70, 174)))
    $graphics.DrawLine($pen, 146, 174, 192, 174)
    $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
    $png = $memory.ToArray()
    $stream = [IO.File]::Create($resolvedOutput)
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
        $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
    } finally { $writer.Dispose(); $stream.Dispose() }
} finally { $memory.Dispose(); $pen.Dispose(); $background.Dispose(); $shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
