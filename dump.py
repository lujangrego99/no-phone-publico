import sys, xml.etree.ElementTree as ET
import uiautomator2 as u2
d = u2.connect("192.168.1.50:5555")
d.screenshot(sys.argv[1] if len(sys.argv) > 1 else "shots/cur.png")
print(d.app_current()["activity"])
for n in ET.fromstring(d.dump_hierarchy()).iter("node"):
    t, ds, r = n.get("text"), n.get("content-desc"), n.get("resource-id") or ""
    if n.get("password") == "true" or n.get("class") == "android.widget.EditText" and (t or "").isdigit():
        t = "***"  # nunca mostrar claves/PIN
    if (t or ds or r) and "systemui" not in r and "inputmethod" not in r and "Notificación" not in (ds or ""):
        print(n.get("clickable")[0], repr(t), repr(ds), r, n.get("bounds"))
