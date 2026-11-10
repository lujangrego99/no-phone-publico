package ar.nophone.agente;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.*;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.zip.GZIPOutputStream;

/**
 * Servicio de accesibilidad: los "ojos y dedos" de no-phone en el celu. Recibe comandos del hub (VPS) por la
 * conexión saliente de {@link Conexion} y los ejecuta. La interfaz imita lo que no-phone usaba de uiautomator2.
 */
public class Agente extends AccessibilityService {
    static final String VERSION = "0.3";
    static volatile Agente yo;
    static volatile String estado = "detenido";

    volatile String pkgActual = "", actActual = "";
    private final Map<String, Boolean> esAct = new HashMap<>();
    Handler main;
    Conexion con;

    @Override protected void onServiceConnected() {
        android.util.Log.i("nophone", "onServiceConnected");
        yo = this;
        main = new Handler(Looper.getMainLooper());
        estado("iniciando");
        if (con != null) con.parar();
        con = Conexion.arrancar(this);
    }

    @Override public void onDestroy() {
        android.util.Log.i("nophone", "onDestroy");
        if (con != null) con.parar();
        yo = null;
        estado = "detenido";
        super.onDestroy();
    }

    @Override public void onInterrupt() {}

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence p = e.getPackageName(), c = e.getClassName();
        if (p == null || c == null) return;
        String ps = p.toString(), cs = c.toString();
        if (!esActividad(ps, cs)) return;
        if (ps.equals(pkgActual) && cs.equals(actActual)) return;
        pkgActual = ps;
        actActual = cs;
        try {
            JSONObject ev = new JSONObject();
            ev.put("ev", "ventana"); ev.put("pkg", ps); ev.put("act", cs);
            ev.put("t", System.currentTimeMillis());
            if (con != null) con.enviar(ev.toString());
        } catch (Exception ignored) {}
    }

    private boolean esActividad(String p, String c) {
        String k = p + "/" + c;
        Boolean b = esAct.get(k);
        if (b == null) {
            try { getPackageManager().getActivityInfo(new ComponentName(p, c), 0); b = true; }
            catch (PackageManager.NameNotFoundException ex) { b = false; }
            esAct.put(k, b);
        }
        return b;
    }

    void estado(String s) {
        estado = s;
        if (main == null) return;
        main.post(() -> {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26)
                nm.createNotificationChannel(new NotificationChannel("agente", "Conexión", NotificationManager.IMPORTANCE_LOW));
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "agente") : new Notification.Builder(this);
            Notification n = b.setContentTitle("no-phone: " + s)
                    .setSmallIcon(android.R.drawable.stat_sys_upload_done).setOngoing(true).build();
            startForeground(1, n);
        });
    }

    // ---------------------------------------------------------------- comandos

    Object ejecutar(JSONObject c) throws Exception {
        String op = c.getString("op");
        JSONObject sel = c.optJSONObject("sel");
        long to = c.optLong("timeout", 0);
        switch (op) {
            case "ping": return "pong";
            case "info": return info();
            case "window_size": { int[] wh = pantalla(); return new JSONArray().put(wh[0]).put(wh[1]); }
            case "dump": {
                String xml = dump();
                if (!c.optBoolean("gz")) return xml;
                ByteArrayOutputStream bo = new ByteArrayOutputStream(Math.max(1024, xml.length() / 6));
                GZIPOutputStream gz = new GZIPOutputStream(bo);
                gz.write(xml.getBytes("UTF-8"));
                gz.close();
                return Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
            }
            case "textos": return textos();
            case "app_current": {
                JSONObject r = new JSONObject();
                AccessibilityNodeInfo root = getRootInActiveWindow();
                String vp = root != null && root.getPackageName() != null ? root.getPackageName().toString() : "";
                r.put("package", pkgActual); r.put("activity", actActual);
                r.put("ventana_pkg", vp);
                return r;
            }
            case "exists": return buscar(sel, to) != null;
            case "wait": return buscar(sel, Math.max(to, 1)) != null;
            case "wait_gone": {
                long fin = System.currentTimeMillis() + to;
                do { if (buscar(sel, 0) == null) return true; Thread.sleep(100); } while (System.currentTimeMillis() < fin);
                return false;
            }
            case "count": {
                int n = 0;
                for (AccessibilityNodeInfo r : raices()) n += contar(r, sel, 0);
                return n;
            }
            case "info_nodo": {
                AccessibilityNodeInfo n = buscar(sel, to);
                return n == null ? JSONObject.NULL : infoNodo(n);
            }
            case "get_text": {
                AccessibilityNodeInfo n = buscar(sel, to);
                return n == null ? JSONObject.NULL : s(n.getText());
            }
            case "click": {
                if (c.has("x")) return tocar(c.getInt("x"), c.getInt("y"), 60);
                AccessibilityNodeInfo n = buscar(sel, to);
                if (n == null) return false;
                if (c.optBoolean("accion")) {
                    AccessibilityNodeInfo a = n;
                    while (a != null && !a.isClickable()) a = a.getParent();
                    return a != null && a.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                }
                Rect r = new Rect(); n.getBoundsInScreen(r);
                return tocar(r.centerX(), r.centerY(), 60);
            }
            case "long_click": {
                int x, y;
                if (c.has("x")) { x = c.getInt("x"); y = c.getInt("y"); }
                else {
                    AccessibilityNodeInfo n = buscar(sel, to);
                    if (n == null) return false;
                    Rect r = new Rect(); n.getBoundsInScreen(r); x = r.centerX(); y = r.centerY();
                }
                return tocar(x, y, c.optInt("ms", 700));
            }
            case "set_text": {
                AccessibilityNodeInfo n = sel != null ? buscar(sel, to) : findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (n == null) return false;
                Bundle a = new Bundle();
                a.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, c.getString("text"));
                return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, a);
            }
            case "press": return presionar(c.getString("key"));
            case "swipe":
                return gesto(c.getInt("x1"), c.getInt("y1"), c.getInt("x2"), c.getInt("y2"), c.optInt("ms", 300));
            case "scroll": {
                AccessibilityNodeInfo cont = contenedor(sel);
                if (cont == null) return false;
                boolean adelante = !"backward".equals(c.optString("dir", "forward"));
                int pasos = c.optInt("pasos", 1);
                boolean ok = false;
                for (int i = 0; i < pasos; i++) {
                    ok = cont.performAction(adelante ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
                    if (!ok) break;
                    Thread.sleep(250);
                }
                return ok;
            }
            case "scroll_to": {
                JSONObject obj = c.getJSONObject("objetivo");
                int max = c.optInt("max", 15);
                boolean adelante = !"backward".equals(c.optString("dir", "forward"));
                for (int i = 0; i <= max; i++) {
                    if (buscar(obj, 0) != null) return true;
                    AccessibilityNodeInfo cont = contenedor(sel);
                    if (cont == null) return false;
                    if (!cont.performAction(adelante ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD))
                        return buscar(obj, 300) != null;  // llegó al final
                    Thread.sleep(300);
                }
                return buscar(obj, 0) != null;
            }
            case "app_start": {
                Intent i = getPackageManager().getLaunchIntentForPackage(c.getString("pkg"));
                if (i == null) return false;
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                startActivity(i);
                return true;
            }
            case "wake": case "screen_on": {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                boolean antes = pm.isInteractive();
                if (!antes) {
                    @SuppressWarnings("deprecation")
                    PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "nophone:wake");
                    wl.acquire(3000);
                    Thread.sleep(400);
                }
                return antes;
            }
            case "screen_off":
                if (Build.VERSION.SDK_INT >= 28) return performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN);
                return false;
            case "pantalla_prendida": return ((PowerManager) getSystemService(POWER_SERVICE)).isInteractive();
            case "meminfo": {
                ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
                ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                JSONObject r = new JSONObject();
                r.put("libre_mb", mi.availMem / (1024 * 1024)); r.put("total_mb", mi.totalMem / (1024 * 1024));
                r.put("baja", mi.lowMemory);
                return r;
            }
            case "liberar": return liberar(c.optJSONArray("no_cerrar"));
            case "screenshot": return captura();
            default: throw new IllegalArgumentException("op desconocida: " + op);
        }
    }

    private int[] pantalla() {
        DisplayMetrics dm = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
        return new int[]{dm.widthPixels, dm.heightPixels};
    }

    private JSONObject info() throws Exception {
        JSONObject r = new JSONObject();
        int[] wh = pantalla();
        r.put("modelo", Build.MANUFACTURER + " " + Build.MODEL);
        r.put("productName", Build.PRODUCT);
        r.put("sdkInt", Build.VERSION.SDK_INT);
        r.put("displayWidth", wh[0]); r.put("displayHeight", wh[1]);
        r.put("screenOn", ((PowerManager) getSystemService(POWER_SERVICE)).isInteractive());
        r.put("currentPackageName", pkgActual);
        r.put("version_agente", VERSION);
        return r;
    }

    private boolean presionar(String k) throws Exception {
        switch (k) {
            case "back": return performGlobalAction(GLOBAL_ACTION_BACK);
            case "home": return performGlobalAction(GLOBAL_ACTION_HOME);
            case "recent": return performGlobalAction(GLOBAL_ACTION_RECENTS);
            case "notification": return performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS);
            case "quick_settings": return performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS);
            case "power": return performGlobalAction(GLOBAL_ACTION_POWER_DIALOG);
            case "enter": return enter();
            default: throw new IllegalArgumentException("tecla no soportada: " + k);
        }
    }

    /** "Enter" sin inyectar teclas: Android 11+ tiene la acción IME; en Android 10 se toca la tecla del teclado. */
    private boolean enter() throws Exception {
        AccessibilityNodeInfo foco = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (Build.VERSION.SDK_INT >= 30 && foco != null) {
            if (foco.performAction(android.R.id.accessibilityActionImeEnter)) return true;
        }
        String[] nombres = {"intro", "enter", "listo", "ir", "siguiente", "buscar", "enviar", "aceptar", "done", "go", "next", "search", "send"};
        try {
            for (AccessibilityWindowInfo w : getWindows()) {
                if (w.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
                AccessibilityNodeInfo n = dfsEnter(w.getRoot(), nombres, 0);
                if (n != null) {
                    Rect r = new Rect(); n.getBoundsInScreen(r);
                    return tocar(r.centerX(), r.centerY(), 60);
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    private AccessibilityNodeInfo dfsEnter(AccessibilityNodeInfo n, String[] nombres, int prof) {
        if (n == null || prof > 40) return null;
        String d = (s(n.getContentDescription()) + " " + s(n.getText())).trim().toLowerCase(Locale.ROOT);
        for (String x : nombres) if (d.equals(x)) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo h = dfsEnter(n.getChild(i), nombres, prof + 1);
            if (h != null) return h;
        }
        return null;
    }

    /** Cierra apps de usuario en segundo plano (las de primer plano no: no hay permisos de shell). */
    private JSONObject liberar(JSONArray noCerrar) throws Exception {
        ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        long antes = mi.availMem / (1024 * 1024);
        List<String> excl = new ArrayList<>();
        if (noCerrar != null) for (int i = 0; i < noCerrar.length(); i++) excl.add(noCerrar.getString(i));
        JSONArray cerradas = new JSONArray();
        for (ApplicationInfo ai : getPackageManager().getInstalledApplications(0)) {
            if ((ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;
            String p = ai.packageName;
            if (p.equals(getPackageName())) continue;
            boolean salta = false;
            for (String e : excl) if (p.startsWith(e)) { salta = true; break; }
            if (salta) continue;
            am.killBackgroundProcesses(p);
            cerradas.put(p);
        }
        Thread.sleep(300);
        am.getMemoryInfo(mi);
        JSONObject r = new JSONObject();
        r.put("intentadas", cerradas);
        r.put("mem_libre_mb_antes", antes);
        r.put("mem_libre_mb_despues", mi.availMem / (1024 * 1024));
        return r;
    }

    /** Captura: solo Android 11+ (API 30). En Android 10 no hay forma sin pedir grabación de pantalla. */
    private Object captura() throws Exception {
        if (Build.VERSION.SDK_INT < 30) throw new UnsupportedOperationException("no_soportado: captura requiere Android 11+");
        final CountDownLatch l = new CountDownLatch(1);
        final Object[] res = {null};
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult sr) {
                try {
                    Bitmap b = Bitmap.wrapHardwareBuffer(sr.getHardwareBuffer(), sr.getColorSpace());
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    b.copy(Bitmap.Config.ARGB_8888, false).compress(Bitmap.CompressFormat.PNG, 100, bo);
                    res[0] = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
                } catch (Exception e) { res[0] = e; }
                l.countDown();
            }
            @Override public void onFailure(int code) { res[0] = new RuntimeException("captura falló: " + code); l.countDown(); }
        });
        l.await(5, TimeUnit.SECONDS);
        if (res[0] instanceof Exception) throw (Exception) res[0];
        if (res[0] == null) throw new RuntimeException("captura: timeout");
        return res[0];
    }

    // ---------------------------------------------------------------- árbol

    private List<AccessibilityNodeInfo> raices() {
        // Orden: ventana activa, otras de apps, teclado y al final las del sistema (barra de estado/navegación),
        // así un selector como description="Inicio" encuentra primero el de la app y no el botón del sistema.
        List<AccessibilityNodeInfo> rs = new ArrayList<>();
        try {
            List<AccessibilityWindowInfo> ws = new ArrayList<>(getWindows());
            Collections.sort(ws, (a, b) -> Integer.compare(rango(a), rango(b)));
            for (AccessibilityWindowInfo w : ws) {
                AccessibilityNodeInfo r = w.getRoot();
                if (r != null) rs.add(r);
            }
        } catch (Exception ignored) {}
        if (rs.isEmpty()) {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r != null) rs.add(r);
        }
        return rs;
    }

    private static int rango(AccessibilityWindowInfo w) {
        if (w.isActive()) return 0;
        switch (w.getType()) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return 1;
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return 2;
            default: return 3;
        }
    }

    AccessibilityNodeInfo buscar(JSONObject sel, long timeoutMs) throws Exception {
        if (sel == null) throw new IllegalArgumentException("falta sel");
        long fin = System.currentTimeMillis() + timeoutMs;
        while (true) {
            for (AccessibilityNodeInfo r : raices()) {
                AccessibilityNodeInfo n = dfs(r, sel, 0);
                if (n != null) return n;
            }
            if (System.currentTimeMillis() >= fin) return null;
            Thread.sleep(100);
        }
    }

    /** Contenedor scrolleable: el del selector, o el scrolleable más grande de la ventana activa. */
    private AccessibilityNodeInfo contenedor(JSONObject sel) throws Exception {
        if (sel != null && sel.length() > 0 && !(sel.length() == 1 && sel.has("scrollable"))) return buscar(sel, 0);
        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo[] mejor = {null};
        int[] area = {0};
        mayorScroll(root, mejor, area, 0);
        return mejor[0];
    }

    private void mayorScroll(AccessibilityNodeInfo n, AccessibilityNodeInfo[] mejor, int[] area, int prof) {
        if (n == null || prof > 80) return;
        if (n.isScrollable() && n.isVisibleToUser()) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            int a = r.width() * r.height();
            if (a > area[0]) { area[0] = a; mejor[0] = n; }
        }
        for (int i = 0; i < n.getChildCount(); i++) mayorScroll(n.getChild(i), mejor, area, prof + 1);
    }

    private AccessibilityNodeInfo dfs(AccessibilityNodeInfo n, JSONObject sel, int prof) {
        if (n == null || prof > 80) return null;
        if (coincide(n, sel)) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo h = dfs(n.getChild(i), sel, prof + 1);
            if (h != null) return h;
        }
        return null;
    }

    private int contar(AccessibilityNodeInfo n, JSONObject sel, int prof) {
        if (n == null || prof > 80) return 0;
        int k = coincide(n, sel) ? 1 : 0;
        for (int i = 0; i < n.getChildCount(); i++) k += contar(n.getChild(i), sel, prof + 1);
        return k;
    }

    private static String s(CharSequence c) { return c == null ? "" : c.toString(); }

    private boolean coincide(AccessibilityNodeInfo n, JSONObject sel) {
        Iterator<String> it = sel.keys();
        String t = s(n.getText()), d = s(n.getContentDescription());
        while (it.hasNext()) {
            String k = it.next();
            Object v = sel.opt(k);
            String vs = String.valueOf(v);
            boolean b = Boolean.TRUE.equals(v);
            boolean ok;
            switch (k) {
                case "text": ok = t.equals(vs); break;
                case "textContains": ok = t.contains(vs); break;
                case "textStartsWith": ok = t.startsWith(vs); break;
                case "textMatches": ok = Pattern.compile(vs, Pattern.DOTALL).matcher(t).matches(); break;
                case "description": ok = d.equals(vs); break;
                case "descriptionContains": ok = d.contains(vs); break;
                case "descriptionStartsWith": ok = d.startsWith(vs); break;
                case "descriptionMatches": ok = Pattern.compile(vs, Pattern.DOTALL).matcher(d).matches(); break;
                case "resourceId": ok = vs.equals(n.getViewIdResourceName()); break;
                case "resourceIdMatches": ok = Pattern.compile(vs).matcher(s(n.getViewIdResourceName())).matches(); break;
                case "className": ok = vs.equals(s(n.getClassName())); break;
                case "packageName": ok = vs.equals(s(n.getPackageName())); break;
                case "clickable": ok = n.isClickable() == b; break;
                case "enabled": ok = n.isEnabled() == b; break;
                case "scrollable": ok = n.isScrollable() == b; break;
                case "focused": ok = n.isFocused() == b; break;
                case "checked": ok = n.isChecked() == b; break;
                case "selected": ok = n.isSelected() == b; break;
                default: ok = false;
            }
            if (!ok) return false;
        }
        return true;
    }

    private JSONObject infoNodo(AccessibilityNodeInfo n) throws Exception {
        Rect r = new Rect(); n.getBoundsInScreen(r);
        JSONObject b = new JSONObject();
        b.put("left", r.left); b.put("top", r.top); b.put("right", r.right); b.put("bottom", r.bottom);
        JSONObject o = new JSONObject();
        o.put("text", s(n.getText()));
        o.put("contentDescription", s(n.getContentDescription()));
        o.put("className", s(n.getClassName()));
        o.put("packageName", s(n.getPackageName()));
        o.put("resourceName", n.getViewIdResourceName() == null ? JSONObject.NULL : n.getViewIdResourceName());
        o.put("bounds", b); o.put("visibleBounds", b);
        o.put("checkable", n.isCheckable()); o.put("checked", n.isChecked());
        o.put("clickable", n.isClickable()); o.put("enabled", n.isEnabled());
        o.put("focusable", n.isFocusable()); o.put("focused", n.isFocused());
        o.put("longClickable", n.isLongClickable()); o.put("scrollable", n.isScrollable());
        o.put("selected", n.isSelected()); o.put("childCount", n.getChildCount());
        return o;
    }

    // dump compatible con el formato de uiautomator2
    private String dump() {
        StringBuilder sb = new StringBuilder(64 * 1024);
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation=\"0\">");
        for (AccessibilityNodeInfo r : raices()) nodo(sb, r, 0, 0);
        sb.append("</hierarchy>");
        return sb.toString();
    }

    private static String esc(CharSequence c) {
        if (c == null) return "";
        StringBuilder o = new StringBuilder(c.length());
        for (int i = 0; i < c.length(); i++) {
            char ch = c.charAt(i);
            switch (ch) {
                case '&': o.append("&amp;"); break;
                case '<': o.append("&lt;"); break;
                case '>': o.append("&gt;"); break;
                case '"': o.append("&quot;"); break;
                case '\n': o.append("&#10;"); break;
                default: if (ch >= 0x20 || ch == '\t') o.append(ch);
            }
        }
        return o.toString();
    }

    private void nodo(StringBuilder sb, AccessibilityNodeInfo n, int idx, int prof) {
        if (n == null || prof > 80) return;
        Rect r = new Rect(); n.getBoundsInScreen(r);
        sb.append("<node index=\"").append(idx)
          .append("\" text=\"").append(esc(n.getText()))
          .append("\" resource-id=\"").append(esc(n.getViewIdResourceName()))
          .append("\" class=\"").append(esc(n.getClassName()))
          .append("\" package=\"").append(esc(n.getPackageName()))
          .append("\" content-desc=\"").append(esc(n.getContentDescription()))
          .append("\" checkable=\"").append(n.isCheckable())
          .append("\" checked=\"").append(n.isChecked())
          .append("\" clickable=\"").append(n.isClickable())
          .append("\" enabled=\"").append(n.isEnabled())
          .append("\" focusable=\"").append(n.isFocusable())
          .append("\" focused=\"").append(n.isFocused())
          .append("\" scrollable=\"").append(n.isScrollable())
          .append("\" long-clickable=\"").append(n.isLongClickable())
          .append("\" password=\"").append(n.isPassword())
          .append("\" selected=\"").append(n.isSelected())
          .append("\" visible-to-user=\"").append(n.isVisibleToUser())
          .append("\" bounds=\"[").append(r.left).append(',').append(r.top).append("][")
          .append(r.right).append(',').append(r.bottom).append("]\"");
        int k = n.getChildCount();
        if (k == 0) { sb.append(" />"); return; }
        sb.append(">");
        for (int i = 0; i < k; i++) nodo(sb, n.getChild(i), i, prof + 1);
        sb.append("</node>");
    }

    private JSONArray textos() {
        JSONArray a = new JSONArray();
        for (AccessibilityNodeInfo r : raices()) juntar(r, a, 0);
        return a;
    }

    private void juntar(AccessibilityNodeInfo n, JSONArray a, int prof) {
        if (n == null || prof > 80) return;
        if (n.isVisibleToUser()) {
            String t = s(n.getText());
            if (t.isEmpty()) t = s(n.getContentDescription());
            if (!t.isEmpty()) a.put(t);
        }
        for (int i = 0; i < n.getChildCount(); i++) juntar(n.getChild(i), a, prof + 1);
    }

    private boolean tocar(int x, int y, int ms) throws InterruptedException {
        return gesto(x, y, x, y, ms);
    }

    private boolean gesto(int x1, int y1, int x2, int y2, int ms) throws InterruptedException {
        Path p = new Path();
        p.moveTo(x1, y1);
        if (x1 != x2 || y1 != y2) p.lineTo(x2, y2);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(1, ms))).build();
        final CountDownLatch l = new CountDownLatch(1);
        final boolean[] ok = {false};
        boolean desp = dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { ok[0] = true; l.countDown(); }
            @Override public void onCancelled(GestureDescription d) { l.countDown(); }
        }, main);
        if (!desp) return false;
        l.await(ms + 3000, TimeUnit.MILLISECONDS);
        return ok[0];
    }
}
