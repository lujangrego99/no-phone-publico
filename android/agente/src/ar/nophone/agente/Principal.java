package ar.nophone.agente;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.PowerManager;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Pantalla de la app: estado y alta. El alta llega por intent (consola/adb):
 *   am start -n ar.nophone.agente/.Principal --es url wss://HUB/celu --es celu ID --es token SECRETO
 * o por link nophone://alta?url=…&celu=…&token=… (QR de la consola).
 */
public class Principal extends Activity {
    private TextView tv;
    private final Handler h = new Handler();

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        guardarAlta(getIntent());
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(48, 96, 48, 48);
        tv = new TextView(this);
        tv.setTextSize(20);
        l.addView(tv);
        l.addView(boton("1. Permiso de accesibilidad", () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));
        l.addView(boton("2. Leer notificaciones", () -> startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))));
        l.addView(boton("3. Sin límite de batería", () -> {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
            startActivity(i);
        }));
        l.addView(boton("4. Permisos MIUI (ventanas en segundo plano, autoinicio)", () -> {
            try {
                Intent i = new Intent("miui.intent.action.APP_PERM_EDITOR");
                i.putExtra("extra_pkgname", getPackageName());
                startActivity(i);
            } catch (Exception e) {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            }
        }));
        setContentView(l);
        refrescar();
    }

    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); guardarAlta(i); }

    private void guardarAlta(Intent i) {
        if (i == null) return;
        String url = i.getStringExtra("url"), celu = i.getStringExtra("celu"), token = i.getStringExtra("token");
        Uri d = i.getData();
        if (d != null && "nophone".equals(d.getScheme())) {
            url = d.getQueryParameter("url"); celu = d.getQueryParameter("celu"); token = d.getQueryParameter("token");
        }
        if (url == null || celu == null || token == null) return;
        getSharedPreferences("cfg", 0).edit().putString("url", url).putString("celu", celu).putString("token", token).apply();
        Agente a = Agente.yo;
        if (a != null && a.con != null) a.con.reconectar();
    }

    private Button boton(String t, Runnable r) {
        Button b = new Button(this);
        b.setText(t);
        b.setOnClickListener(v -> r.run());
        return b;
    }

    private void refrescar() {
        String url = getSharedPreferences("cfg", 0).getString("url", "(sin servidor)");
        String celu = getSharedPreferences("cfg", 0).getString("celu", "?");
        boolean bat = ((PowerManager) getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName());
        tv.setText("no-phone " + Agente.VERSION + "\n\nCelu: " + celu + "\nServidor: " + url
                + "\nEstado: " + Agente.estado
                + "\nAccesibilidad: " + (Agente.yo != null ? "activa" : "APAGADA")
                + "\nBatería sin límite: " + (bat ? "sí" : "NO"));
        h.postDelayed(this::refrescar, 1000);
    }

    @Override protected void onDestroy() { h.removeCallbacksAndMessages(null); super.onDestroy(); }
}
