// Lo que está caído y te impide hacer cosas (las líneas de /pulse con `failed`). Lo usan el chat (una línea fina por
// problema, que se puede descartar) y el header (contador rojo al lado de la campana + «problemas» en la bandeja).
// Descartar solo lo saca del chat, en este navegador: sigue contando en el header hasta que se arregla. Cuando se
// arregla sale de los descartados, así que si vuelve a caerse aparece de nuevo en el chat.
import { useCallback, useEffect, useState } from "react";
import { api, type Pulse, type PulseLine } from "./api";

const EVENTO = "np-caidos";
const CLAVE = "np-caidos-descartados";

function leer(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLAVE) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function guardar(ids: string[]) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(ids));
  } catch {
    /* sin almacenamiento: el descarte dura hasta recargar */
  }
}

export function useCaidos(tenant: string | null) {
  const [caidos, setCaidos] = useState<PulseLine[]>([]);
  const [descartados, setDescartados] = useState<string[]>(leer);
  const clave = useCallback((id: string) => `${tenant}:${id}`, [tenant]);
  const traer = useCallback(() => {
    if (!tenant) return;
    api
      .get<Pulse>(`/t/${tenant}/pulse`)
      .then((p) => {
        const fallan = (p.lines ?? []).filter((l) => l.failed);
        setCaidos(fallan);
        const siguen = new Set(fallan.map((l) => `${tenant}:${l.id}`));
        const d = leer().filter((x) => !x.startsWith(`${tenant}:`) || siguen.has(x));
        guardar(d);
        setDescartados(d);
      })
      .catch(() => null);
  }, [tenant]);
  useEffect(() => {
    traer();
    const t = setInterval(traer, 60_000);
    const otro = () => setDescartados(leer());
    window.addEventListener(EVENTO, otro);
    return () => {
      clearInterval(t);
      window.removeEventListener(EVENTO, otro);
    };
  }, [traer]);
  const descartar = (id: string) => {
    const d = [...new Set([...leer(), clave(id)])];
    guardar(d);
    setDescartados(d);
    window.dispatchEvent(new Event(EVENTO)); // el otro uso (chat ↔ header) se entera ya
  };
  const enChat = caidos.filter((l) => !descartados.includes(clave(l.id)));
  return { caidos, enChat, descartar };
}
