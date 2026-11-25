package ar.nophone.agente;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Conexión saliente y persistente al hub de no-phone (VPS). Reconecta sola ante cortes y cambios de red. */
class Conexion implements Runnable {
    private final Agente ag;
    private volatile boolean vivo = true;
    private volatile Ws ws;
    private final Object dormidero = new Object();
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final ExecutorService envio = Executors.newSingleThreadExecutor();
    private ConnectivityManager.NetworkCallback cb;
    private volatile Network redActual;

    private Conexion(Agente a) { ag = a; }

    static Conexion arrancar(Agente a) {
        Conexion c = new Conexion(a);
        new Thread(c, "conexion").start();
        new Thread(c::latir, "latido").start();
        c.vigilarRed();
        return c;
    }

    void parar() {
        vivo = false;
        Ws w = ws; if (w != null) w.cerrar();
        despertar();
        try { ((ConnectivityManager) ag.getSystemService(Context.CONNECTIVITY_SERVICE)).unregisterNetworkCallback(cb); } catch (Exception ignored) {}
        exec.shutdownNow();
        envio.shutdownNow();
    }

    /** Llamado cuando cambia la configuración (servidor/token): corta y reconecta ya. */
    void reconectar() { Ws w = ws; if (w != null) w.cerrar(); despertar(); }

    private void despertar() { synchronized (dormidero) { dormidero.notifyAll(); } }

    private void dormir(long ms) {
        synchronized (dormidero) { try { dormidero.wait(ms); } catch (InterruptedException ignored) {} }
    }

    private void vigilarRed() {
        ConnectivityManager cm = (ConnectivityManager) ag.getSystemService(Context.CONNECTIVITY_SERVICE);
        cb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) {
                Network antes = redActual;
                redActual = n;
                if (antes != null && !antes.equals(n)) { Ws w = ws; if (w != null) w.cerrar(); }
                despertar();
            }
        };
        if (Build.VERSION.SDK_INT >= 24) cm.registerDefaultNetworkCallback(cb);
    }

    private void latir() {
        while (vivo) {
            dormir(15000);
            Ws w = ws;
            if (w != null) try { w.ping(); } catch (Exception e) { w.cerrar(); }
        }
    }

    @Override public void run() {
        long espera = 1000;
        int intentos = 0;
        while (vivo) {
            SharedPreferences p = ag.getSharedPreferences("cfg", 0);
            String url = p.getString("url", ""), celu = p.getString("celu", ""), token = p.getString("token", "");
            if (url.isEmpty() || celu.isEmpty() || token.isEmpty()) { ag.estado("sin configurar"); dormir(5000); continue; }
            try {
                ag.estado("conectando… (" + (++intentos) + ")");
                long t0 = System.currentTimeMillis();
                Ws w = Ws.conectar(url, celu, token);
                ws = w;
                espera = 1000;
                ag.estado("conectado");
                JSONObject hola = new JSONObject();
                hola.put("ev", "hola");
                hola.put("celu", celu);
                hola.put("modelo", Build.MANUFACTURER + " " + Build.MODEL);
                hola.put("sdk", Build.VERSION.SDK_INT);
                hola.put("version", Agente.VERSION);
                hola.put("conectar_ms", System.currentTimeMillis() - t0);
                hola.put("intentos", intentos);
                enviarYa(hola.toString());
                intentos = 0;
                String m;
                while (vivo && (m = w.leer()) != null) {
                    final JSONObject cmd = new JSONObject(m);
                    exec.submit(() -> responder(cmd));
                }
                w.cerrar();
            } catch (Exception e) {
                android.util.Log.w("nophone", "conexión caída: " + e);
                ag.estado("sin conexión: " + e.getClass().getSimpleName());
            }
            ws = null;
            if (!vivo) break;
            dormir(espera);
            espera = Math.min(espera * 2, 30000);
        }
    }

    private void responder(JSONObject cmd) {
        long t0 = System.nanoTime();
        JSONObject r = new JSONObject();
        try {
            r.put("id", cmd.opt("id"));
            try {
                Object v = ag.ejecutar(cmd);
                r.put("ok", true);
                r.put("r", v == null ? JSONObject.NULL : v);
            } catch (Exception e) {
                r.put("ok", false);
                r.put("err", e.toString());
            }
            r.put("t_ms", (System.nanoTime() - t0) / 1e6);
        } catch (Exception ignored) {}
        enviar(r.toString());
    }

    /** Thread-safe y sin red en el hilo que llama (Android prohíbe red en el main thread). */
    void enviar(final String s) {
        if (!vivo) return;
        try { envio.execute(() -> enviarYa(s)); } catch (Exception ignored) {}
    }

    private void enviarYa(String s) {
        Ws w = ws;
        if (w == null) return;
        try { w.enviar(s); } catch (Exception e) { w.cerrar(); }
    }
}
