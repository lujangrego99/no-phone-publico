package ar.nophone.agente;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONObject;

/** Avisa al servidor al instante cuando llega una notificación (WhatsApp, ingresos, etc.). Spike. */
public class Notificaciones extends NotificationListenerService {
    @Override public void onNotificationPosted(StatusBarNotification sbn) {
        Agente a = Agente.yo;
        if (a == null || a.con == null) return;
        try {
            Bundle x = sbn.getNotification().extras;
            JSONObject ev = new JSONObject();
            ev.put("ev", "notif");
            ev.put("pkg", sbn.getPackageName());
            ev.put("titulo", String.valueOf(x.getCharSequence(Notification.EXTRA_TITLE)));
            ev.put("texto", String.valueOf(x.getCharSequence(Notification.EXTRA_TEXT)));
            ev.put("t_post", sbn.getPostTime());
            ev.put("t", System.currentTimeMillis());
            a.con.enviar(ev.toString());
        } catch (Exception ignored) {}
    }
}
