# Servidor local minimo para probar Home Mini Pro en este PC (http://localhost:8080)
# Uso:  powershell -ExecutionPolicy Bypass -File .\servidor.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8080
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.svg'='image/svg+xml'; '.webmanifest'='application/manifest+json'; '.css'='text/css' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Home Mini Pro listo en http://localhost:$port  (Ctrl+C para detener)"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
      if ([string]::IsNullOrEmpty($path)) { $path = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))
      if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file)
        $ctx.Response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
        $ctx.Response.ContentLength64 = $bytes.Length
        if ($ctx.Request.HttpMethod -ne 'HEAD') { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else { $ctx.Response.StatusCode = 404 }
    } catch { Write-Host "Error: $_" }
    finally { try { $ctx.Response.Close() } catch {} }
  }
} finally { $listener.Stop() }
