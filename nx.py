"""CLI de exploración: python nx.py <cmd> [args]
cmds: d (dump) | t <text> | ds <desc> | id <rid> | xy x y | back | up | down | home"""
import sys, time, xml.etree.ElementTree as ET
import uiautomator2 as u2
import server  # carga .env

d = u2.connect("192.168.1.50:5555")
SKIP = ("systemui", "inputmethod")


def dump():
    print("##", d.app_current().get("activity"))
    for n in ET.fromstring(d.dump_hierarchy()).iter("node"):
        t, ds, r = n.get("text") or "", n.get("content-desc") or "", n.get("resource-id") or ""
        if any(s in r for s in SKIP) or ds.startswith("Notificación") or r.startswith("android:"):
            continue
        if n.get("password") == "true" or (n.get("class") == "android.widget.EditText" and t.isdigit()) \
                or (t.isdigit() and len(t) == 6):
            t = "***"
        if t or ds or (r and n.get("clickable") == "true"):
            print(("T " if n.get("clickable") == "true" else "  ") + f"{t!r} {ds!r} {r} {n.get('bounds')}")


cmd, args = sys.argv[1], sys.argv[2:]
if cmd == "t": d(textContains=" ".join(args)).click(timeout=8)
elif cmd == "ds": d(descriptionContains=" ".join(args)).click(timeout=8)
elif cmd == "id": d(resourceId=args[0]).click(timeout=8)
elif cmd == "xy": d.click(int(args[0]), int(args[1]))
elif cmd == "back": d.press("back")
elif cmd == "up": d.swipe_ext("up", 0.7)     # scrollea hacia abajo
elif cmd == "down": d.swipe_ext("down", 0.7)  # scrollea hacia arriba
elif cmd == "home": d(resourceId="home").click(timeout=5)
elif cmd == "i":
    import naranjax; naranjax.ir_al_inicio(d)
if cmd != "d": time.sleep(float(__import__("os").environ.get("W", "2.5")))
dump()
