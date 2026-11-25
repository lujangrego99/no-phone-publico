import { useEffect, useRef } from "react";

/**
 * Tres campos de polvo gris detrás del trabajo. Solo las capas de atrás se mueven:
 * la más lejana a la velocidad base, cada paso hacia adelante a la mitad.
 * `still` congela todo (un plano jalado adelante se lee quieto).
 */
const FIELDS = [
  { count: 620, size: 1, alpha: 0.55, rate: 6, band: 0.8 }, // lejos · fino
  { count: 300, size: 1, alpha: 0.62, rate: 3, band: 0.7 }, // medio
  { count: 90, size: 2, alpha: 0.5, rate: 1.5, band: 0.45 }, // cerca · grueso
];

interface Mote {
  x: number;
  y: number;
}

function seed(w: number, h: number) {
  // Polvo reunido en dos ondas largas (como un scroller), más algo suelto.
  let s = 1337;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return FIELDS.map((f, i) =>
    Array.from({ length: f.count }, (): Mote => {
      const x = rnd() * w;
      const wave = i % 2 === 0 ? 0.32 : 0.7;
      const onBand = rnd() < f.band;
      const base = h * wave + Math.sin((x / w) * Math.PI * 2 + i) * h * 0.12;
      const spread = onBand ? (rnd() - 0.5) * h * 0.04 * (1 + rnd() * rnd() * 3) : (rnd() - 0.5) * h * 1.2;
      return { x, y: base + spread };
    }),
  );
}

export function Dust({ still = false }: { still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stillRef = useRef(still);
  stillRef.current = still;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let w = 0;
    let h = 0;
    let dpr = 1;
    let motes: Mote[][] = [];
    let raf = 0;
    let last = performance.now();
    let speed = 1; // se acerca a 0 cuando hay que quedarse quieto

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // En pantallas angostas se pierde un paso de profundidad, no de brillo.
      const fields = w < 720 ? FIELDS.slice(0, 2) : FIELDS;
      motes = seed(w, h).slice(0, fields.length);
      draw();
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      motes.forEach((field, i) => {
        const f = FIELDS[i];
        ctx.fillStyle = `rgba(123,123,123,${f.alpha})`;
        for (const m of field) ctx.fillRect(Math.round(m.x), Math.round(m.y), f.size, f.size);
      });
    };

    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const target = stillRef.current || document.hidden ? 0 : 1;
      speed += (target - speed) * Math.min(1, dt * 4);
      if (speed > 0.001) {
        motes.forEach((field, i) => {
          const v = FIELDS[i].rate * speed * dt;
          for (const m of field) {
            m.x -= v;
            if (m.x < -2) m.x += w + 4;
          }
        });
        draw();
      }
      raf = requestAnimationFrame(tick);
    };

    resize();
    window.addEventListener("resize", resize);
    if (!reduce.matches) raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className="dust" aria-hidden="true" />;
}
