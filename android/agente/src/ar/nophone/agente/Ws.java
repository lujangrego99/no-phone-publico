package ar.nophone.agente;

import android.util.Base64;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.net.ssl.*;

/** Cliente WebSocket mínimo (RFC 6455), sin dependencias. Spike. */
class Ws {
    private final Socket s;
    private final DataInputStream in;
    private final OutputStream out;
    private final SecureRandom rnd = new SecureRandom();

    private Ws(Socket s) throws IOException {
        this.s = s;
        this.in = new DataInputStream(new BufferedInputStream(s.getInputStream()));
        this.out = new BufferedOutputStream(s.getOutputStream());
    }

    static Ws conectar(String url, String celu, String token) throws Exception {
        URI u = URI.create(url);
        boolean tls = "wss".equals(u.getScheme());
        String host = u.getHost();
        int port = u.getPort() < 0 ? (tls ? 443 : 80) : u.getPort();
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), 10000);
        Socket s = raw;
        if (tls) {
            SSLSocket ss = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault())
                    .createSocket(raw, host, port, true);
            ss.startHandshake();
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ss.getSession()))
                throw new IOException("el certificado no es de " + host);
            s = ss;
        }
        s.setTcpNoDelay(true);
        s.setSoTimeout(45000);
        Ws w = new Ws(s);
        byte[] k = new byte[16];
        w.rnd.nextBytes(k);
        String key = Base64.encodeToString(k, Base64.NO_WRAP);
        String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        if (u.getRawQuery() != null) path += "?" + u.getRawQuery();
        boolean puertoStd = (tls && port == 443) || (!tls && port == 80);
        String req = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + host + (puertoStd ? "" : ":" + port) + "\r\n"
                + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n"
                + "X-Celu: " + celu + "\r\n"
                + "Authorization: Bearer " + token + "\r\n"
                + "User-Agent: nophone-agente/" + Agente.VERSION + "\r\n\r\n";
        w.out.write(req.getBytes("UTF-8"));
        w.out.flush();
        String status = w.linea();
        if (status == null || !status.contains(" 101")) throw new IOException("handshake: " + status);
        String accept = null, l;
        while ((l = w.linea()) != null && !l.isEmpty()) {
            int i = l.indexOf(':');
            if (i > 0 && l.substring(0, i).trim().equalsIgnoreCase("Sec-WebSocket-Accept"))
                accept = l.substring(i + 1).trim();
        }
        MessageDigest sha = MessageDigest.getInstance("SHA-1");
        String esperado = Base64.encodeToString(
                sha.digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes("UTF-8")), Base64.NO_WRAP);
        if (!esperado.equals(accept)) throw new IOException("Sec-WebSocket-Accept inválido");
        return w;
    }

    private String linea() throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
        }
        return c == -1 && sb.length() == 0 ? null : sb.toString();
    }

    /** Devuelve el próximo mensaje de texto, o null si el server cerró. */
    String leer() throws IOException {
        ByteArrayOutputStream acc = new ByteArrayOutputStream();
        while (true) {
            int b0 = in.readUnsignedByte(), b1 = in.readUnsignedByte();
            boolean fin = (b0 & 0x80) != 0;
            int op = b0 & 0x0f;
            long len = b1 & 0x7f;
            if (len == 126) len = in.readUnsignedShort();
            else if (len == 127) len = in.readLong();
            byte[] mask = null;
            if ((b1 & 0x80) != 0) { mask = new byte[4]; in.readFully(mask); }
            if (len > 64L * 1024 * 1024) throw new IOException("frame enorme");
            byte[] p = new byte[(int) len];
            in.readFully(p);
            if (mask != null) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
            if (op == 8) { try { frame(8, new byte[0]); } catch (IOException ignored) {} return null; }
            if (op == 9) { frame(10, p); continue; }
            if (op == 10) continue;
            acc.write(p);
            if (fin) return acc.toString("UTF-8");
        }
    }

    void enviar(String txt) throws IOException { frame(1, txt.getBytes("UTF-8")); }
    void ping() throws IOException { frame(9, new byte[0]); }

    private synchronized void frame(int op, byte[] p) throws IOException {
        ByteArrayOutputStream f = new ByteArrayOutputStream(p.length + 14);
        f.write(0x80 | op);
        if (p.length < 126) f.write(0x80 | p.length);
        else if (p.length < 65536) { f.write(0x80 | 126); f.write(p.length >> 8); f.write(p.length & 0xff); }
        else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write((int) (((long) p.length) >> (8 * i)) & 0xff); }
        byte[] m = new byte[4];
        rnd.nextBytes(m);
        f.write(m);
        for (int i = 0; i < p.length; i++) f.write(p[i] ^ m[i & 3]);
        out.write(f.toByteArray());
        out.flush();
    }

    void cerrar() { try { s.close(); } catch (IOException ignored) {} }
}
