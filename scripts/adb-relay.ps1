# Reenvía <ListenIp>:<Port> → 127.0.0.1:<Port> (adb de Windows), escuchando SOLO en esa IP (la de WSL).
# Uso: powershell -ExecutionPolicy Bypass -File adb-relay.ps1 -ListenIp 172.24.240.1 [-Port 5037]
# El copiado va en C# con hilos propios: la versión en PowerShell cerraba conexiones ajenas (los scriptblocks
# leían $client/$server de la vuelta siguiente) y los `adb shell` se colgaban.
param([Parameter(Mandatory = $true)][string]$ListenIp, [int]$Port = 5037)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System; using System.Net; using System.Net.Sockets; using System.Threading;
public static class AdbRelay {
    static void Pipe(NetworkStream a, NetworkStream b, TcpClient x, TcpClient y) {
        var buf = new byte[65536];
        try { int n; while ((n = a.Read(buf, 0, buf.Length)) > 0) { b.Write(buf, 0, n); } }
        catch { }
        finally { try { x.Close(); } catch { } try { y.Close(); } catch { } }
    }
    public static void Run(string ip, int port) {
        var l = new TcpListener(IPAddress.Parse(ip), port);
        l.Start();
        while (true) {
            var c = l.AcceptTcpClient();
            try {
                var s = new TcpClient("127.0.0.1", port);
                c.NoDelay = true; s.NoDelay = true;
                var cs = c.GetStream(); var ss = s.GetStream();
                new Thread(() => Pipe(cs, ss, c, s)) { IsBackground = true }.Start();
                new Thread(() => Pipe(ss, cs, s, c)) { IsBackground = true }.Start();
            } catch { try { c.Close(); } catch { } }
        }
    }
}
"@
Write-Output "adb-relay: $($ListenIp):$Port -> 127.0.0.1:$Port"
[AdbRelay]::Run($ListenIp, $Port)
