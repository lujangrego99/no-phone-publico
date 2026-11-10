// Llamada en tiempo real con Qwen-Omni Realtime como PUENTE de voz (WebRTC: audio directo con cancelación de eco).
// Qwen escucha (reconocedor + detección de turno) y habla, nada más: la consola toma la transcripción literal, se la
// pasa al secretario de siempre (POST /voz/turno → Hermes) y le pide a Qwen que diga la respuesta textual. La sesión
// va con create_response=false: Qwen nunca contesta por su cuenta.
// El intercambio SDP pasa por la consola, que es la única que tiene la key de Alibaba.
import type { ToolItem } from "../components/ToolCards";

export type EstadoVoz = "conectando" | "escuchando" | "pensando" | "hablando";

export type Callbacks = {
  estado: (e: EstadoVoz) => void;
  parcial: (texto: string) => void; // lo que vas diciendo
  vos: (texto: string) => void; // lo que dijiste (terminado)
  diciendo: (texto: string) => void; // lo que va diciendo la voz
  secretario: (texto: string, tools: ToolItem[]) => void; // la respuesta del secretario
  error: (mensaje: string) => void;
  aviso?: (texto: string) => void; // decirlo en voz alta mientras no hay voz (reintento de conexión)
  cortada: () => void;
};

type Ev = { type?: string; [k: string]: unknown };

/** Si hay una llamada en curso (las tarjetas de grabar no ofrecen su botón: la llamada graba sola). */
export const llamadaEnCurso = { activa: false };

// Nota de voz en la llamada: corta cuando te callás (silencio después de haber hablado), o al tope, o si tocás.
const NOTA_SILENCIO_MS = 2200;
const NOTA_MAX_MS = 120_000;
const NOTA_ESPERA_MS = 8000; // si no empezás a hablar en este rato, no graba nada

// Conexión: intentos y tope por intento hasta que la sesión quede configurada (medido: lo normal es < 3 s).
const INTENTOS = 3;
const TOPE_MS = 8000;
const VIGIA_MS = 12000;
const MAX_RECONEXIONES = 3;
const STATS_MS = 3000;

export class VozRealtime {
  private pc: RTCPeerConnection | null = null;
  private canal: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private emisor: RTCRtpSender | null = null;
  private audio: HTMLAudioElement | null = null;
  private parado = false;
  private configurado = false;
  private sesionCreada = false;
  private reconectando = false;
  private reconexiones = 0;
  private vigiaT: ReturnType<typeof setTimeout> | 0 = 0;
  private lista = false; // la sesión quedó configurada: de acá en más un corte es «se cortó la llamada»
  private alListo: (() => void) | null = null;
  // Medidores para el círculo: tu micrófono y la voz que llega de Qwen.
  private anMic: AnalyserNode | null = null;
  private anVoz: AnalyserNode | null = null;
  private bufNivel = new Float32Array(1024);
  private pendiente: Promise<void> = Promise.resolve(); // un turno del secretario por vez
  private hablando = false;
  private trabajando = 0;
  private dicho = "";
  private oido = "";
  private boca: Promise<void> = Promise.resolve(); // frases que Qwen tiene que decir, en orden
  private finDecir: (() => void) | null = null;
  private vozElegida: string | null = null;
  private usuarioHabla = false;
  private esperaTranscripcion = false; // terminaste de hablar y falta la transcripción (el vigía la espera)
  private hayUsuario = false; // la sesión ya tiene algún mensaje del dueño (Alibaba no responde sin uno)
  private repetirDecir: (() => void) | null = null;
  private respuestaCreada = false;
  // Diagnóstico de audio (voz trabada: ¿red o PC?): muestras de getStats cada STATS_MS, se mandan en tandas.
  private statsT: ReturnType<typeof setInterval> | 0 = 0;
  private lagT: ReturnType<typeof setInterval> | 0 = 0;
  private lagMax = 0;
  private statsPrev: Record<string, number> = {};
  private statsBuf: Record<string, unknown>[] = [];
  private sesionLlamada: () => string;
  private tenant: string;
  private cb: Callbacks;
  private config: Record<string, unknown> | null = null;
  private muteado = false;
  private tapado: ReturnType<typeof setTimeout> | 0 = 0; // la voz quedó muda porque la cortaste (hasta que esa respuesta termine)
  private pulso: ReturnType<typeof setInterval> | 0 = 0;
  private ctx: AudioContext | null = null;
  private sonando: HTMLAudioElement | null = null; // un audio de WhatsApp que se te está pasando
  private terminarNota: (() => void) | null = null; // grabando una nota de voz: tocar la termina

  constructor(tenant: string, sesionLlamada: () => string, cb: Callbacks) {
    this.tenant = tenant;
    this.sesionLlamada = sesionLlamada;
    this.cb = cb;
  }

  async empezar() {
    llamadaEnCurso.activa = true;
    this.cb.estado("conectando");
    try {
      // Micrófono con cancelación de eco y supresión de ruido del navegador.
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.parado) return this.soltarMic();
      this.anMic = this.analizador(this.mic);
      this.audio = document.createElement("audio");
      this.audio.autoplay = true;
      // El audio va directo navegador↔Alibaba. Medido: a veces conecta en 0,2 s y a veces tarda 15 s o no conecta
      // (camino UDP malo). Mejor cortar a los TOPE_MS y reintentar, que dejar a alguien que no ve en silencio.
      await this.conectar();
    } catch (e) {
      if (!this.parado) {
        const m = (e as Error).name === "NotAllowedError" ? "Sin permiso para el micrófono." : (e as Error).message;
        this.cb.error(m);
        this.cortar();
      }
    }
  }

  private async conectar() {
    for (let intento = 1; intento <= INTENTOS; intento++) {
      if (await this.intentar()) return;
      if (this.parado) return;
      this.desarmarPc();
      if (intento < INTENTOS) this.cb.aviso?.("La voz no conecta, pruebo de nuevo.");
    }
    throw new Error("No pude conectar la voz con Alibaba. Probá de nuevo en un rato.");
  }

  /** La sesión se cayó o se colgó a mitad de la llamada: sesión nueva sin cortar (el secretario guarda la charla). */
  private async reconectar(motivo: string) {
    if (this.parado || this.reconectando) return;
    if (++this.reconexiones > MAX_RECONEXIONES) {
      this.cb.error("Se cortó la llamada.");
      return this.cortar();
    }
    this.reconectando = true;
    this.vigia(false);
    this.hablando = false;
    this.finDecir?.(); // lo que estaba diciendo se perdió con la sesión
    // Lo que dijiste justo antes se perdió con la sesión: el aviso pide repetirlo.
    this.esperaTranscripcion = false;
    this.usuarioHabla = false;
    this.cb.estado("conectando");
    this.cb.aviso?.(motivo);
    this.desarmarPc();
    try {
      await this.conectar();
    } catch (e) {
      if (!this.parado) {
        this.cb.error((e as Error).message);
        this.cortar();
      }
    } finally {
      this.reconectando = false;
    }
  }

  // Vigía: terminaste de hablar y no llega la transcripción, o se le pidió decir algo y no arranca → la sesión quedó
  // colgada (medido: deja de transcribir y de detectar voz, sin mandar error). VIGIA_MS sin NINGÚN evento → reconecta.
  private vigia(prender: boolean) {
    if (this.vigiaT) clearTimeout(this.vigiaT);
    this.vigiaT = 0;
    if (prender) this.vigiaT = setTimeout(() => this.reconectar("Se me trabó la voz, reconecto. Después repetime lo último."), VIGIA_MS);
  }

  /** Un intento de conexión: true si la sesión quedó configurada (session.updated) antes del tope. */
  private async intentar(): Promise<boolean> {
    this.configurado = false;
    this.sesionCreada = false;
    this.config = null;
    this.canal = null;
    this.lista = false;
    this.hayUsuario = false;
    const fin = { fallo: () => {} };
    const listo = new Promise<boolean>((resolve) => {
      this.alListo = () => resolve(true);
      fin.fallo = () => resolve(false);
    });

    // Sin STUN a propósito: Alibaba es ICE-lite con IP pública y con STUN fue peor (medido: +4 s juntando candidatos
    // y más intentos que conectaban sin que llegara la sesión).
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.ontrack = ({ track, streams }) => {
      if (this.pc !== pc || track.kind !== "audio" || !this.audio) return;
      const flujo = streams[0] ?? new MediaStream([track]);
      this.audio.srcObject = flujo;
      this.anVoz = this.analizador(flujo);
      this.audio.play().catch(() => this.cb.error("El navegador bloqueó el audio: tocá la pantalla para escucharlo."));
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.parado || !["failed", "disconnected", "closed"].includes(pc.connectionState)) return;
      if (!this.lista) return fin.fallo(); // todavía conectando: que reintente
      void this.reconectar("Se cortó la voz, reconecto.");
    };
    // El micrófono queda reservado pero mudo hasta que la sesión esté configurada (si no, se descarta).
    const tr = pc.addTransceiver("audio", { direction: "sendrecv" });
    this.emisor = tr.sender;
    pc.ondatachannel = ({ channel }) => this.pc === pc && this.atarCanal(channel);
    this.atarCanal(pc.createDataChannel("oai-events"));

    await pc.setLocalDescription(await pc.createOffer());
    await this.esperarIce(pc);
    if (this.parado) return false;
    const r = await fetch(`/api/t/${this.tenant}/voz/sdp`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-np": "1" },
      body: JSON.stringify({ offer: pc.localDescription?.sdp ?? "" }),
    });
    const j = (await r.json().catch(() => ({}))) as { answer?: string; session?: Record<string, unknown>; message?: string };
    // Error de la consola o de Alibaba (key, modelo): reintentar no lo arregla.
    if (!r.ok || !j.answer) throw new Error(j.message ?? `No se pudo conectar la voz (${r.status}).`);
    this.config = j.session ? { ...j.session, ...(this.vozElegida ? { voice: this.vozElegida } : {}) } : null;
    if (this.parado) return false;
    const sdp = String(j.answer).trim().replace(/\r?\n/g, "\r\n") + "\r\n";
    await pc.setRemoteDescription({ type: "answer", sdp });
    const tope = setTimeout(() => fin.fallo(), TOPE_MS);
    const ok = await listo;
    clearTimeout(tope);
    return ok;
  }

  /** Suelta la conexión de un intento fallido (el micrófono queda para el siguiente). */
  private desarmarPc() {
    const pc = this.pc;
    this.pc = null;
    try {
      this.canal?.close();
    } catch {
      /* ya cerrado */
    }
    this.canal = null;
    try {
      pc?.close();
    } catch {
      /* ya cerrado */
    }
  }

  /** Nivel 0..1 para el círculo: la voz de Qwen mientras habla, si no tu micrófono. */
  nivel(): number {
    const an = this.hablando ? this.anVoz : this.muteado ? null : this.anMic;
    if (!an) return 0;
    an.getFloatTimeDomainData(this.bufNivel);
    let s = 0;
    for (const x of this.bufNivel) s += x * x;
    return Math.min(1, Math.sqrt(s / this.bufNivel.length) * (this.hablando ? 6 : 9));
  }

  private analizador(flujo: MediaStream): AnalyserNode | null {
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
      const an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      this.ctx.createMediaStreamSource(flujo).connect(an); // sin salida: solo mide, no suena dos veces
      return an;
    } catch {
      return null;
    }
  }

  /** Mutea el micrófono (no se manda audio). */
  silenciar(m: boolean) {
    this.muteado = m;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !m));
  }

  /** Cambia la voz en medio de la llamada (sin colgar). */
  cambiarVoz(voz: string) {
    this.vozElegida = voz; // que sobreviva a una reconexión
    if (this.config) this.config = { ...this.config, voice: voz };
    this.mandar({ type: "session.update", session: { voice: voz } });
  }

  /** Cortarle mientras habla (o cortar el audio que te está pasando, o terminar la nota de voz que grabás). */
  callarlo() {
    if (this.terminarNota) return this.terminarNota();
    if (this.sonando) {
      this.sonando.pause();
      this.sonando.dispatchEvent(new Event("ended"));
      return;
    }
    const hablaba = this.hablando;
    if (hablaba) this.mandar({ type: "response.cancel" });
    if (this.audio) {
      // Corta el audio que ya estaba en camino y queda muda hasta que esa respuesta termine (response.done destapa).
      // Antes eran 300 ms fijos: si la respuesta cancelada seguía llegando, volvía a sonar el resto (lo contó Goyo:
      // «siguió hablando hasta terminar de decir la misión»). Tope por si response.done no llega nunca.
      this.audio.muted = true;
      if (this.tapado) clearTimeout(this.tapado);
      this.tapado = setTimeout(() => this.destapar(), hablaba ? 30_000 : 300);
    }
  }

  private destapar() {
    if (this.tapado) clearTimeout(this.tapado);
    this.tapado = 0;
    if (this.audio) this.audio.muted = false;
  }

  /** Lo que mandás sin hablar en medio de la llamada (un botón de una tarjeta, la caja de texto): lo corta si está
   *  hablando y va por esta misma voz. Antes iba por el camino de la llamada común: contestaba con Piper mientras
   *  Qwen seguía leyendo, y sonaban dos voces a la vez. */
  escribir(texto: string) {
    if (this.parado || !texto.trim()) return;
    this.callarlo();
    this.cb.vos(texto);
    this.pedir(texto);
  }

  cortar() {
    if (this.parado) return;
    this.parado = true;
    llamadaEnCurso.activa = false;
    this.sonando?.pause();
    this.terminarNota?.();
    this.vigia(false);
    void this.muestraAudio().finally(() => this.mandarStats());
    if (this.statsT) clearInterval(this.statsT);
    if (this.lagT) clearInterval(this.lagT);
    this.esperando(false);
    try {
      this.canal?.close();
    } catch {
      /* ya cerrado */
    }
    try {
      this.pc?.close();
    } catch {
      /* ya cerrado */
    }
    this.soltarMic();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    this.pc = null;
    this.canal = null;
    this.cb.cortada();
  }

  // Mientras el secretario trabaja (saldo, WhatsApp, transferir) suena un pulso suave cada 1,8 s: no queda silencio muerto.
  private esperando(si: boolean) {
    if (!si) {
      if (this.pulso) clearInterval(this.pulso);
      this.pulso = 0;
      return;
    }
    if (this.pulso) return;
    this.pulso = setInterval(() => this.tono(392, 0.035, 0.35), 1800);
  }

  private tono(frecuencia: number, volumen: number, dura: number) {
    try {
      this.ctx ??= new AudioContext();
      const c = this.ctx, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(frecuencia, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(volumen, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dura);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + dura + 0.01);
    } catch {
      /* sin audio */
    }
  }

  private soltarMic() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }

  private esperarIce(pc: RTCPeerConnection) {
    return new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const tope = setTimeout(resolve, 4000); // con lo que haya
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(tope);
          resolve();
        }
      });
    });
  }

  private atarCanal(ch: RTCDataChannel) {
    ch.onmessage = ({ data }) => {
      let ev: Ev;
      try {
        ev = JSON.parse(String(data));
      } catch {
        return;
      }
      // Rastro de eventos (sin contenido) para diagnosticar cuelgues: va con las estadísticas a voz-stats.jsonl.
      if (ev.type && !/delta$/.test(ev.type) && this.statsBuf.length < 400) this.statsBuf.push({ t: Math.round(performance.now()), ev: ev.type.slice(0, 38) });
      // La sesión colgada no manda NADA; mientras lleguen eventos está viva (la transcripción con varias voces tarda).
      if (this.vigiaT && ch === this.canal) this.vigia(true);
      if (ev.type === "session.created") {
        this.sesionCreada = true;
        this.canal = ch; // la configuración va por el canal que trajo la sesión
        this.configurar();
      }
      this.alEvento(ev);
    };
    ch.onopen = () => this.configurar();
  }

  private configurar() {
    if (this.configurado || !this.sesionCreada || !this.config || this.canal?.readyState !== "open") return;
    this.configurado = true;
    this.mandar({ type: "session.update", session: this.config });
    // Medido: a veces Alibaba ignora el primer session.update (no contesta session.updated). Se reenvía.
    const pc = this.pc;
    setTimeout(() => {
      if (this.lista || this.parado || this.pc !== pc) return;
      this.configurado = false;
      this.configurar();
    }, 2500);
  }

  private mandar(ev: Record<string, unknown>) {
    if (this.canal?.readyState === "open") {
      const id =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.canal.send(JSON.stringify({ event_id: `ev_${id}`, ...ev }));
    }
  }

  private async alEvento(ev: Ev) {
    switch (ev.type) {
      case "session.updated": {
        // Recién ahora se manda el micrófono.
        const pista = this.mic?.getAudioTracks()[0] ?? null;
        if (pista && this.emisor) await this.emisor.replaceTrack(pista);
        this.silenciar(this.muteado);
        this.lista = true;
        this.alListo?.();
        this.medirAudio();
        if (this.trabajando === 0 && !this.hablando) this.cb.estado("escuchando");
        else this.cb.estado("pensando");
        break;
      }
      case "input_audio_buffer.speech_started":
        this.usuarioHabla = true;
        this.oido = "";
        if (this.hablando) this.callarlo(); // le hablaste encima: se calla
        break;
      case "input_audio_buffer.speech_stopped":
        this.usuarioHabla = false;
        this.esperaTranscripcion = true;
        // Terminaste de hablar: tiene que llegar la transcripción; si no llega, la sesión se colgó (vigía).
        // Medido en una prueba real con varias voces: la transcripción tardó ~7 s → el vigía de 7 s reconectaba de más.
        this.vigia(true);
        if (!this.hablando && this.trabajando === 0) this.cb.estado("pensando");
        break;
      case "conversation.item.created":
        if ((ev.item as { role?: string } | undefined)?.role === "user") this.hayUsuario = true;
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const t = String(ev.delta ?? ev.text ?? ev.stash ?? "");
        this.oido = ev.delta !== undefined ? this.oido + t : t;
        this.cb.parcial(this.oido);
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        // El reconocedor no pudo: que lo diga en vez de quedarse «pensando».
        this.esperaTranscripcion = false;
        this.vigia(false);
        if (this.trabajando === 0) void this.decirTextual("No te escuché bien, ¿me lo repetís?");
        break;
      case "conversation.item.input_audio_transcription.completed": {
        this.esperaTranscripcion = false;
        this.vigia(false); // la sesión anda
        const t = String(ev.transcript ?? "").trim();
        this.cb.parcial("");
        if (t) {
          this.cb.vos(t);
          if (this.trabajando > 0) this.tono(660, 0.05, 0.18); // «te escuché, lo anoto» mientras sigue con lo anterior
          this.pedir(t);
        } else if (!this.hablando && this.trabajando === 0) this.cb.estado("escuchando"); // ruido sin palabras
        break;
      }
      case "response.created":
        if (this.tapado) this.destapar(); // una respuesta nueva: la cortada ya terminó
        this.respuestaCreada = true; // el vigía sigue: medido, a veces arranca y nunca manda audio
        // Solo hay respuestas pedidas por la consola: desde acá está hablando (medido: a veces no llegan los
        // audio_transcript.delta y no se enteraba → no se callaba si le hablabas encima).
        this.hablando = true;
        this.cb.estado("hablando");
        this.dicho = "";
        break;
      case "response.audio_transcript.delta":
        this.esperando(false);
        this.hablando = true;
        this.dicho += String(ev.delta ?? "");
        this.cb.diciendo(this.dicho);
        this.cb.estado("hablando");
        break;
      case "response.done":
        // Si le hablaste encima, la respuesta termina (cancelada) pero tu transcripción sigue pendiente: el vigía queda.
        // Medido: se apagaba acá, la transcripción no llegó y quedó «pensando» para siempre.
        if (!this.esperaTranscripcion) this.vigia(false);
        if (this.tapado) {
          // la que cortaste terminó: lo que quedaba en camino (~150 ms de buffer) se tira antes de destapar
          clearTimeout(this.tapado);
          this.tapado = setTimeout(() => this.destapar(), 400);
        }
        this.hablando = false;
        this.cb.diciendo("");
        this.finDecir?.();
        this.cb.estado(this.trabajando > 0 || this.esperaTranscripcion ? "pensando" : "escuchando");
        break;
      case "error": {
        const e = ev.error as { message?: string; code?: string } | undefined;
        const msg = e?.message ?? "";
        // Cancelar cuando ya no hablaba no es un error de verdad.
        if (e?.code === "response_cancel_not_active" || /no active response|cancel/i.test(msg)) break;
        this.statsBuf.push({ t: Math.round(performance.now()), error: msg.slice(0, 38) }); // queda en voz-stats.jsonl
        if (/role of user/i.test(msg) && this.repetirDecir) {
          const otraVez = this.repetirDecir;
          this.repetirDecir = null; // una sola vez por frase
          this.hayUsuario = false;
          otraVez(); // pone el mensaje de usuario y lo vuelve a pedir
          break;
        }
        // Lo técnico de Alibaba no se lee en voz alta (sale por cb.error, que también lo dice).
        this.cb.error("La voz tuvo un problema; si no te respondo, repetímelo.");
        break;
      }
    }
  }

  // Qwen es SOLO la boca: lo dice textual. No decide nada (medido: si se le deja la herramienta, la llama sin
  // argumentos o contesta por su cuenta). De a una frase por vez; termina con response.done (o si lo interrumpen).
  // Un aviso que llega en medio de la llamada (una misión te necesita o terminó): se dice en la cola, sin cortar nada.
  anunciar(texto: string): Promise<void> {
    return this.decirTextual(texto);
  }

  private decirTextual(texto: string): Promise<void> {
    this.boca = this.boca.then(
      () =>
        new Promise<void>(async (resolve) => {
          // Recién con la sesión configurada: si no, sale con la voz y las instrucciones por defecto de Alibaba
          // (pasó al reconectar en medio de una respuesta: «cambió hasta de voz»).
          await this.cuandoLista();
          // Medido: un response.create mandado mientras el dueño habla se perdió y trabó la cola 54 s (el pedido que
          // dijo en el medio nunca llegó al secretario). Se espera a que termine de hablar (hasta 6 s).
          for (let i = 0; i < 40 && this.usuarioHabla && !this.parado; i++) await new Promise((r) => setTimeout(r, 150));
          if (this.parado || !texto.trim()) return resolve();
          let reintento: ReturnType<typeof setTimeout> | 0 = 0;
          const tope = setTimeout(() => fin(), 60_000);
          const fin = () => {
            clearTimeout(tope);
            if (reintento) clearTimeout(reintento);
            this.finDecir = null;
            this.repetirDecir = null;
            resolve();
          };
          this.finDecir = fin;
          const pedirRespuesta = () => {
            // Alibaba rechaza responder si en la sesión no hay ningún mensaje con rol user («The input messages do not
            // contain elements with the role of user»): pasó después de una reconexión. Se pone uno corto.
            if (!this.hayUsuario) {
              this.mandar({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Leé en voz alta el texto que te indiquen." }] } });
              this.hayUsuario = true;
            }
            this.mandar({
              type: "response.create",
              response: {
                tool_choice: "none",
                instructions:
                  "Decí exactamente este texto, palabra por palabra, en castellano rioplatense y con voz natural, " +
                  `sin agregar, quitar ni cambiar nada: «${texto.trim()}»`,
              },
            });
          };
          this.repetirDecir = pedirRespuesta;
          this.respuestaCreada = false;
          pedirRespuesta();
          // Si Alibaba no la arranca: se pide una vez más; si tampoco, se sigue de largo (no se traba la cola).
          reintento = setTimeout(() => {
            if (this.respuestaCreada || this.parado) return;
            pedirRespuesta();
            reintento = setTimeout(() => {
              if (!this.respuestaCreada) fin();
            }, 4000);
          }, 4000);
        }),
    );
    return this.boca;
  }

  private medirAudio() {
    if (this.statsT) return;
    // Reloj de la página: si un tic de 100 ms llega mucho tarde, la PC/navegador estuvo trabado (no la red).
    let ultimo = performance.now();
    this.lagT = setInterval(() => {
      const ahora = performance.now();
      this.lagMax = Math.max(this.lagMax, ahora - ultimo - 100);
      ultimo = ahora;
    }, 100);
    let n = 0;
    this.statsT = setInterval(() => {
      void this.muestraAudio();
      if (++n % 5 === 0) this.mandarStats();
    }, STATS_MS);
  }

  private async muestraAudio() {
    const pc = this.pc;
    if (!pc) return;
    try {
      const rep = await pc.getStats();
      // oculta = pestaña en segundo plano: el navegador frena los timers y lagMaxMs no dice nada de la PC.
      const m: Record<string, unknown> = { t: Math.round(performance.now()), hablando: this.hablando, oculta: document.hidden, lagMaxMs: Math.round(this.lagMax) };
      this.lagMax = 0;
      const prev = this.statsPrev;
      const sig: Record<string, number> = {};
      const delta = (k: string, v: unknown) => {
        if (typeof v !== "number") return 0;
        sig[k] = v;
        return prev[k] !== undefined && v >= prev[k] ? v - prev[k] : 0;
      };
      rep.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "audio") {
          m.recibidos = delta("rx", r.packetsReceived);
          m.perdidos = delta("lost", r.packetsLost);
          m.jitterMs = Math.round((r.jitter ?? 0) * 1000);
          const tot = delta("tot", r.totalSamplesReceived);
          const conc = delta("conc", r.concealedSamples) - delta("sil", r.silentConcealedSamples);
          m.rellenoPct = tot ? Math.round((1000 * Math.max(0, conc)) / tot) / 10 : 0; // audio inventado por pérdida
          m.cortes = delta("cev", r.concealmentEvents);
          m.acelerado = delta("acc", r.removedSamplesForAcceleration);
          m.frenado = delta("dec", r.insertedSamplesForDeceleration);
          const jbd = delta("jbd", r.jitterBufferDelay), jbe = delta("jbe", r.jitterBufferEmittedCount);
          m.bufferMs = jbe ? Math.round((1000 * jbd) / jbe) : 0;
        } else if (r.type === "remote-inbound-rtp" && r.kind === "audio") {
          m.perdidosSubida = typeof r.fractionLost === "number" ? Math.round(r.fractionLost * 1000) / 10 : 0;
        } else if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
          m.rttMs = Math.round((r.currentRoundTripTime ?? 0) * 1000);
        }
      });
      this.statsPrev = sig;
      this.statsBuf.push(m);
    } catch {
      /* sin stats */
    }
  }

  private mandarStats() {
    if (!this.statsBuf.length) return;
    const muestras = this.statsBuf.splice(0);
    void fetch(`/api/t/${this.tenant}/voz/stats`, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json", "x-np": "1" },
      // El id de la charla: así la revisión de la charla ve qué pasó en la voz (frases oídas, reconexiones, fallas).
      body: JSON.stringify({ llamada: this.sesionLlamada(), muestras }),
    }).catch(() => {});
  }

  private cuandoLista(): Promise<void> {
    return new Promise((resolve) => {
      const mirar = () => (this.lista || this.parado ? resolve() : setTimeout(mirar, 150));
      mirar();
    });
  }

  private async post(url: string, body: Record<string, unknown>) {
    const r = await fetch(`/api/t/${this.tenant}/${url}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-np": "1" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { decir?: string; tools?: ToolItem[]; sigue?: boolean; turno?: string; message?: string };
    if (!r.ok) throw new Error(j.message ?? `El secretario respondió ${r.status}.`);
    return j;
  }

  /** Te pasa un audio de WhatsApp en la llamada: con el micrófono en pausa (que el reconocedor no lo tome como algo
   *  que dijiste) y la voz callada. Tocar la pantalla lo corta. */
  private async reproducir(url: string) {
    await this.boca;
    if (this.parado) return;
    const antes = this.muteado;
    this.silenciar(true);
    this.hablando = true;
    this.cb.estado("hablando");
    const a = new Audio(url);
    this.sonando = a;
    await new Promise<void>((resolve) => {
      const fin = () => resolve();
      a.addEventListener("ended", fin, { once: true });
      a.addEventListener("error", fin, { once: true });
      a.play().catch(fin);
    });
    this.sonando = null;
    this.hablando = false;
    this.silenciar(antes);
    if (!this.parado) {
      this.tono(523, 0.04, 0.2); // terminó
      this.cb.estado(this.trabajando > 0 ? "pensando" : "escuchando");
    }
  }

  /** Graba una nota de voz con tu voz: tono → hablás → cuando te callás (o tocás) → tono. A Qwen no le llega nada. */
  private async grabarNota(): Promise<{ blob: Blob; ms: number } | null> {
    await this.boca;
    const pista = this.mic?.getAudioTracks()[0];
    if (this.parado || !pista || typeof MediaRecorder === "undefined") return null;
    const antes = this.muteado;
    this.silenciar(true); // a la sesión de voz no le llega (la copia de la pista sí graba)
    const copia = pista.clone();
    copia.enabled = true;
    const flujo = new MediaStream([copia]);
    const an = this.analizador(flujo);
    const tipo = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t));
    const rec = new MediaRecorder(flujo, tipo ? { mimeType: tipo } : undefined);
    const partes: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && partes.push(e.data);
    this.tono(880, 0.08, 0.25);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    let hablo = false;
    let ultimaVoz = t0;
    this.cb.estado("escuchando");
    rec.start(250);
    await new Promise<void>((resolve) => {
      let listo = false;
      const fin = () => {
        if (listo) return;
        listo = true;
        clearInterval(mira);
        this.terminarNota = null;
        resolve();
      };
      this.terminarNota = fin;
      const buf = new Float32Array(1024);
      const mira = setInterval(() => {
        const ahora = performance.now();
        if (an) {
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (const x of buf) s += x * x;
          if (Math.sqrt(s / buf.length) > 0.02) {
            hablo = true;
            ultimaVoz = ahora;
          }
        }
        if ((hablo && ahora - ultimaVoz > NOTA_SILENCIO_MS) || ahora - t0 > NOTA_MAX_MS || (!hablo && ahora - t0 > NOTA_ESPERA_MS) || this.parado) fin();
      }, 120);
    });
    const ms = performance.now() - t0;
    await new Promise<void>((r) => {
      rec.onstop = () => r();
      rec.stop();
    });
    copia.stop();
    this.tono(660, 0.08, 0.25);
    this.silenciar(antes);
    if (!hablo || this.parado) return null;
    return { blob: new Blob(partes, { type: rec.mimeType || "audio/webm" }), ms };
  }

  /** Lo que piden las herramientas del turno (pasarte un audio, grabar una nota): se hace después de decir la frase. */
  private async accionesDe(tools: ToolItem[]) {
    for (const t of tools) {
      const n = t.name.replace(/^mcp__[a-z0-9_-]+?__/, "");
      const r = (t.result ?? {}) as { estado?: string; chat?: { jid?: string }; mensaje_id?: string; destinatario?: { nombre?: string; jid?: string } };
      if (n === "wa_reproducir" && r.estado === "reproducir" && r.chat?.jid && r.mensaje_id) {
        await this.reproducir(`/api/t/${this.tenant}/wa/audio?chat=${encodeURIComponent(r.chat.jid)}&id=${encodeURIComponent(r.mensaje_id)}`);
      } else if (n === "wa_grabar_nota" && r.estado === "grabar") {
        const nota = await this.grabarNota();
        const para = r.destinatario?.nombre ?? "el contacto";
        if (!nota) {
          if (!this.parado) await this.decirTextual("No te escuché nada, así que no grabé. Si querés, pedímelo de nuevo.");
          continue;
        }
        try {
          const up = await fetch(`/api/t/${this.tenant}/wa/nota`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": (nota.blob.type || "audio/webm").split(";")[0], "x-np": "1" },
            body: nota.blob,
          });
          const j = (await up.json().catch(() => ({}))) as { archivo?: string; duracion_s?: number; message?: string };
          if (!up.ok || !j.archivo) throw new Error(j.message ?? "no se pudo guardar");
          // Va al secretario como un mensaje más: arma el envío y te pregunta (nada sale sin tu sí).
          this.pedir(`⟦nota de voz grabada para ${para} (${j.duracion_s ?? Math.round(nota.ms / 1000)} s) — archivo: ${j.archivo}⟧`, false);
        } catch {
          if (!this.parado) await this.decirTextual("No pude guardar la grabación. Probemos de nuevo en un rato.");
        }
      }
    }
  }

  // Lo que dijo el dueño (transcripción literal del reconocedor: con ESTO la consola revisa el «sí» de plata/WhatsApp)
  // va al secretario. Los avances (`sigue`) se dicen mientras se pide la parte siguiente. De a un turno por vez.
  private pedir(dijo: string, literal = true) {
    this.trabajando++;
    this.cb.estado("pensando");
    this.esperando(true);
    let pendiente = true;
    const terminar = () => {
      if (!pendiente) return;
      pendiente = false;
      this.trabajando--;
      if (this.trabajando === 0) this.esperando(false);
    };
    this.pendiente = this.pendiente.then(async () => {
      try {
        // literal: lo que dijo el dueño tal cual (para la guarda del sí); una nota grabada no es un «sí».
        let j = await this.post("voz/turno", { sessionId: this.sesionLlamada(), dijo, ...(literal ? { literal: dijo } : {}) });
        // Los avances («sigo con eso», «me fijo el saldo…») no se dicen: Goyo prefirió solo el pulso mientras trabaja.
        while (j.sigue && j.turno && !this.parado) j = await this.post("voz/seguir", { turno: j.turno });
        const decir = j.decir ?? "";
        // Solo la respuesta final va al chat (los avances son para la voz).
        this.cb.secretario(decir, (j.tools ?? []).map((t) => ({ ...t, id: String(t.id), done: true })));
        terminar();
        if (!this.parado) await this.decirTextual(decir);
        if (!this.parado) await this.accionesDe((j.tools ?? []) as ToolItem[]);
      } catch (e) {
        terminar();
        this.cb.error((e as Error).message);
        if (!this.parado) await this.decirTextual("No pude con eso, probá de nuevo.");
      } finally {
        terminar();
      }
    });
  }
}

export type VozInfo = { id: string; genero: "f" | "m"; grupo: "castellano" | "neutra" | "acento"; desc: string };

/** Lo que la consola sabe de la voz (sin la key). */
export type VozConfig = {
  configurada: boolean;
  keyFin: string | null;
  workspaceId: string | null;
  region: "intl" | "cn";
  voz: string;
  voces: VozInfo[];
  favoritas: string[];
  modelo: string;
  modelos: { id: string; nombre: string }[];
};
