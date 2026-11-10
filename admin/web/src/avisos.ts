// Avisos del vigía (vigilancias de WhatsApp y resultados de tareas). Los usan la bandeja del header y el chat
// (fijo en la charla donde se pidió). «Visto» se guarda en la consola, por usuario: vale en todos los dispositivos.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type Aviso = { id: string; at: string; texto: string; origen: string; visto: boolean; charla: string | null };
const EVENTO = "np-avisos";

export function useAvisos(tenant: string | null) {
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const [sinVer, setSinVer] = useState(0);
  const [misionTurnos, setMisionTurnos] = useState<Record<string, number>>({});
  const traer = useCallback(() => {
    if (!tenant) return;
    api
      .get<{ avisos: Aviso[]; sinVer: number; misionTurnos?: Record<string, number> }>(`/t/${tenant}/avisos`)
      .then((d) => {
        setAvisos(d.avisos);
        setSinVer(d.sinVer);
        setMisionTurnos(d.misionTurnos ?? {});
      })
      .catch(() => null);
  }, [tenant]);
  useEffect(() => {
    traer();
    const t = setInterval(traer, 15_000);
    window.addEventListener(EVENTO, traer);
    return () => {
      clearInterval(t);
      window.removeEventListener(EVENTO, traer);
    };
  }, [traer]);
  return { avisos, sinVer, misionTurnos };
}

export async function marcarVistos(tenant: string, ids: string[]) {
  if (!ids.length) return;
  await api.post(`/t/${tenant}/avisos/vistos`, { ids }).catch(() => null);
  window.dispatchEvent(new Event(EVENTO)); // bandeja y chat se ponen al día ya
}
