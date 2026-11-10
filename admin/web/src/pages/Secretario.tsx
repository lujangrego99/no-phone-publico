// Ajustes › secretario: el modelo que piensa, su personalidad, las reglas que cumple siempre y (avanzado) cómo usa la
// memoria. Uso: de vez en cuando. Cada bloque es un panel con su «guardar» abajo, que se prende solo si cambiaste algo;
// si salís con cambios sin guardar, avisa.
import { useEffect, useState, type FormEvent } from "react";
import { useConsole } from "../App";
import { api, type Rule, type Secretary } from "../api";
import { Icon } from "../components/Icon";
import { Empty, Failure, Field, Loading, Panel, useAction, useLoad } from "../components/kit";
import { toast } from "../components/ui";

const PROVIDERS: { id: string; label: string }[] = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "gemini", label: "Gemini" },
];

const DISPOSITIONS: { key: "disposition_skepticism" | "disposition_literalism" | "disposition_empathy"; label: string; low: string; high: string }[] = [
  { key: "disposition_skepticism", label: "desconfianza", low: "cree lo que le dicen", high: "duda y pide fuente" },
  { key: "disposition_literalism", label: "literalidad", low: "lee entre líneas", high: "toma todo al pie" },
  { key: "disposition_empathy", label: "empatía", low: "solo hechos", high: "registra cómo te sentís" },
];

/** Avisa si cerrás o recargás la pestaña con cambios sin guardar. */
function useAvisarSinGuardar(sucio: boolean) {
  useEffect(() => {
    if (!sucio) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", f);
    return () => window.removeEventListener("beforeunload", f);
  }, [sucio]);
}

function Pie({ sucio, ocupado, label, valido = true, onDeshacer, nota }: { sucio: boolean; ocupado: boolean; label: string; valido?: boolean; onDeshacer?: () => void; nota?: string }) {
  return (
    <>
      {sucio ? <span className="sin-guardar">sin guardar</span> : nota ? <span className="meta">{nota}</span> : null}
      {sucio && onDeshacer && (
        <button className="btn quiet" type="button" onClick={onDeshacer}>
          descartar
        </button>
      )}
      <button className={sucio ? "btn primary" : "btn"} type="submit" disabled={!sucio || !valido || ocupado} aria-busy={ocupado}>
        {label}
      </button>
    </>
  );
}

export function Secretario({ embebido = false }: { embebido?: boolean } = {}) {
  const { tenant } = useConsole();
  const sec = useLoad(() => api.get<Secretary>(`/t/${tenant}/secretary`), [tenant]);

  return (
    <div className="settings">
      {!embebido && (
        <div className="page-head">
          <h1 className="display">secretario.</h1>
          <p className="meta">cómo piensa, qué modelo usa y qué guarda de vos</p>
        </div>
      )}
      {sec.loading && !sec.data ? (
        <Loading lines={8} />
      ) : sec.error && !sec.data ? (
        <Failure error={sec.error} onRetry={sec.reload} />
      ) : sec.data ? (
        <>
          {/* Lo que se toca seguido (reglas, personalidad) arriba; el modelo es de una vez, salvo que falte su key:
              ahí el secretario no contesta y es lo primero que hay que arreglar. */}
          {!sec.data.providerKeys[sec.data.model.provider ?? ""] && <Modelo sec={sec.data} onSaved={sec.reload} />}
          <Reglas />
          <Personalidad soul={sec.data.soul} />
          {!!sec.data.providerKeys[sec.data.model.provider ?? ""] && <Modelo sec={sec.data} onSaved={sec.reload} />}
          {/* Lo fino de la memoria casi nunca se toca: plegado hasta que lo pidas. */}
          <details className="plegado avanzado">
            <summary>avanzado · cómo guarda y usa la memoria</summary>
            <QueRecuerda sec={sec.data} />
            <AlContestar sec={sec.data} />
          </details>
        </>
      ) : null}
    </div>
  );
}

function Modelo({ sec, onSaved }: { sec: Secretary; onSaved: () => void }) {
  const { tenant } = useConsole();
  const ini = { provider: sec.model.provider ?? "", model: sec.model.default ?? "", baseUrl: sec.model.base_url ?? "" };
  const [provider, setProvider] = useState(ini.provider);
  const [model, setModel] = useState(ini.model);
  const [baseUrl, setBaseUrl] = useState(ini.baseUrl);
  const [key, setKey] = useState("");
  const act = useAction();
  const hasKey = !!sec.providerKeys[provider];
  const sucio = provider !== ini.provider || model !== ini.model || baseUrl !== ini.baseUrl || !!key.trim();
  useAvisarSinGuardar(sucio);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await act.run("model", async () => {
      await api.patch(`/t/${tenant}/secretary/model`, { provider, default: model, base_url: baseUrl.trim() || null });
      if (key.trim()) await api.put(`/t/${tenant}/secretary/model-key`, { provider, value: key.trim() });
    });
    if (ok) {
      setKey("");
      toast("Modelo guardado.", { tono: "ok" });
      onSaved();
    }
  };
  const descartar = () => {
    setProvider(ini.provider);
    setModel(ini.model);
    setBaseUrl(ini.baseUrl);
    setKey("");
  };

  return (
    <form onSubmit={save}>
      <Panel
        title="modelo"
        desc="El que piensa y contesta. La memoria usa su propio modelo, aparte."
        aside={
          hasKey ? (
            <span className="chip" data-tono="ok">
              key cargada
            </span>
          ) : (
            <span className="chip" data-tono="bad">
              falta la key
            </span>
          )
        }
        footer={<Pie sucio={sucio} ocupado={act.busy !== null} label="guardar modelo" onDeshacer={descartar} />}
      >
        <div className="form-grid">
          <Field label="proveedor">
            {(id) => (
              <select id={id} className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {!PROVIDERS.some((p) => p.id === provider) && provider && <option value={provider}>{provider}</option>}
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="modelo">
            {(id) => <input id={id} className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-v4-flash" spellCheck={false} />}
          </Field>
        </div>
        <div className="form-grid">
          <Field label="API key" hint={hasKey ? "Hay una cargada: escribí otra solo para reemplazarla." : "Sin key el secretario no contesta."}>
            {(id) => (
              <input
                id={id}
                className="input"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={hasKey ? "•••••••• cargada" : "pegala acá"}
              />
            )}
          </Field>
          <Field label="URL base (opcional)" hint="Vacío = la del proveedor.">
            {(id) => <input id={id} className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" spellCheck={false} />}
          </Field>
        </div>
        {act.error && <Failure error={act.error} />}
      </Panel>
    </form>
  );
}

function Personalidad({ soul }: { soul: string }) {
  const { tenant } = useConsole();
  const [text, setText] = useState(soul);
  const [base, setBase] = useState(soul);
  const act = useAction();
  const sucio = text !== base;
  useAvisarSinGuardar(sucio);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("soul", () => api.put(`/t/${tenant}/secretary/soul`, { soul: text }))) {
      setBase(text);
      toast("Personalidad guardada. La versión anterior quedó de copia.", { tono: "ok" });
    }
  };

  return (
    <form onSubmit={save}>
      <Panel
        title="personalidad"
        desc="Cómo habla y cómo trabaja. Vale para el chat, la llamada y las tareas."
        footer={<Pie sucio={sucio} ocupado={act.busy !== null} label="guardar personalidad" onDeshacer={() => setText(base)} nota="se guarda una copia de la versión anterior" />}
      >
        <label className="sr-only" htmlFor="soul">
          personalidad
        </label>
        <textarea id="soul" className="textarea soul" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <span className="meta soul-cuenta">{text.length.toLocaleString("es-AR")} caracteres</span>
        {act.error && <Failure error={act.error} />}
      </Panel>
    </form>
  );
}

function QueRecuerda({ sec }: { sec: Secretary }) {
  const { tenant } = useConsole();
  const ini = {
    retain: sec.bank.retain_mission ?? "",
    obs: sec.bank.observations_mission ?? "",
    disp: Object.fromEntries(DISPOSITIONS.map((d) => [d.key, sec.bank[d.key] ?? 3])) as Record<string, number>,
  };
  const [retain, setRetain] = useState(ini.retain);
  const [obs, setObs] = useState(ini.obs);
  const [disp, setDisp] = useState(ini.disp);
  const [base, setBase] = useState(JSON.stringify(ini));
  const act = useAction();
  const sucio = JSON.stringify({ retain, obs, disp }) !== base;
  useAvisarSinGuardar(sucio);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("bank", () => api.patch(`/t/${tenant}/secretary/bank`, { retain_mission: retain, observations_mission: obs, ...disp }))) {
      setBase(JSON.stringify({ retain, obs, disp }));
      toast("Guardado: así va a guardar la memoria de acá en adelante.", { tono: "ok" });
    }
  };
  const descartar = () => {
    const b = JSON.parse(base) as typeof ini;
    setRetain(b.retain);
    setObs(b.obs);
    setDisp(b.disp);
  };

  return (
    <form onSubmit={save}>
      <Panel title="qué recuerda" desc={<>Memoria «{sec.bankId}». Cambia lo que guarda de acá en adelante, no lo que ya sabe.</>} footer={<Pie sucio={sucio} ocupado={act.busy !== null} label="guardar" onDeshacer={descartar} />}>
        <Field label="qué guarda de las charlas">{(id) => <textarea id={id} className="textarea" rows={5} value={retain} onChange={(e) => setRetain(e.target.value)} />}</Field>
        <Field label="cómo arma las fichas" hint="Las fichas son lo que sabe consolidado de cada persona, grupo o lugar.">
          {(id) => <textarea id={id} className="textarea" rows={4} value={obs} onChange={(e) => setObs(e.target.value)} />}
        </Field>
        <div className="dispositions">
          {DISPOSITIONS.map((d) => (
            <fieldset key={d.key} className="disposition">
              <legend>{d.label}</legend>
              <div className="scale" role="radiogroup" aria-label={d.label}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <label key={n} className="scale-step" data-on={disp[d.key] === n}>
                    <input type="radio" name={d.key} checked={disp[d.key] === n} onChange={() => setDisp({ ...disp, [d.key]: n })} />
                    <span>{n}</span>
                  </label>
                ))}
              </div>
              <span className="scale-extremos">
                <span>{d.low}</span>
                <span>{d.high}</span>
              </span>
            </fieldset>
          ))}
        </div>
        {act.error && <Failure error={act.error} />}
      </Panel>
    </form>
  );
}

function AlContestar({ sec }: { sec: Secretary }) {
  const { tenant } = useConsole();
  const ini = {
    maxTokens: String(sec.recall.recall_max_tokens ?? 1200),
    types: (sec.recall.recall_types ?? "observation,world")
      .split(",")
      .map((s) => s.trim())
      .sort()
      .join(","),
    autoRecall: sec.recall.auto_recall ?? true,
    autoRetain: sec.recall.auto_retain ?? true,
  };
  const [maxTokens, setMaxTokens] = useState(ini.maxTokens);
  const [types, setTypes] = useState(() => new Set(ini.types.split(",")));
  const [autoRecall, setAutoRecall] = useState(ini.autoRecall);
  const [autoRetain, setAutoRetain] = useState(ini.autoRetain);
  const [base, setBase] = useState(JSON.stringify(ini));
  const act = useAction();
  const tokens = Number.parseInt(maxTokens, 10);
  const valid = Number.isFinite(tokens) && tokens >= 200 && tokens <= 8000 && types.size > 0;
  const actual = { maxTokens, types: [...types].sort().join(","), autoRecall, autoRetain };
  const sucio = JSON.stringify(actual) !== base;

  const toggle = (t: string) => {
    const next = new Set(types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTypes(next);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await act.run("recall", () =>
      api.patch(`/t/${tenant}/secretary/recall`, {
        recall_max_tokens: tokens,
        recall_types: [...types].join(","),
        auto_recall: autoRecall,
        auto_retain: autoRetain,
      }),
    );
    if (ok) {
      setBase(JSON.stringify(actual));
      toast("Guardado.", { tono: "ok" });
    }
  };

  return (
    <form onSubmit={save}>
      <Panel title="al contestar" desc="Cuánta memoria carga antes de cada respuesta: menos es más rápido y más barato." footer={<Pie sucio={sucio} valido={valid} ocupado={act.busy !== null} label="guardar" />}>
        <div className="form-grid">
          <Field label="tope de memoria por pedido" hint="En tokens, entre 200 y 8000." error={valid || !maxTokens ? null : types.size === 0 ? "Elegí al menos una cosa para traer." : "Fuera de rango: entre 200 y 8000."}>
            {(id) => <input id={id} className="input num" inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value.replace(/\D/g, ""))} aria-invalid={!valid} />}
          </Field>
          <fieldset className="checks">
            <legend>qué trae</legend>
            {[
              ["observation", "fichas"],
              ["world", "hechos"],
              ["experience", "vividos"],
            ].map(([v, l]) => (
              <label key={v} className="toggle">
                <input type="checkbox" checked={types.has(v)} onChange={() => toggle(v)} />
                <span>{l}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="checks">
            <legend>automático</legend>
            <label className="toggle">
              <input type="checkbox" checked={autoRecall} onChange={(e) => setAutoRecall(e.target.checked)} />
              <span>recordar antes de contestar</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={autoRetain} onChange={(e) => setAutoRetain(e.target.checked)} />
              <span>guardar lo nuevo de cada charla</span>
            </label>
          </fieldset>
        </div>
        {act.error && <Failure error={act.error} />}
      </Panel>
    </form>
  );
}

function Reglas() {
  const { tenant } = useConsole();
  const rules = useLoad(() => api.get<{ items: Rule[] }>(`/t/${tenant}/rules`), [tenant]);
  const [abierto, setAbierto] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const act = useAction();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("add", () => api.post(`/t/${tenant}/rules`, { name: name.trim(), content: content.trim() }))) {
      toast(`Regla «${name.trim()}» agregada.`, { tono: "ok" });
      setName("");
      setContent("");
      setAbierto(false);
      rules.reload();
    }
  };
  const toggle = async (r: Rule) => {
    if (await act.run(`t-${r.id}`, () => api.patch(`/t/${tenant}/rules/${r.id}`, { isActive: !r.is_active }))) {
      toast(r.is_active ? `«${r.name}» apagada: no la cumple hasta que la prendas.` : `«${r.name}» prendida.`, { tono: "ok" });
    }
    rules.reload();
  };
  // Borrar se deshace volviéndola a crear igual (mismo nombre, texto y estado).
  const remove = async (r: Rule) => {
    if (!(await act.run(`d-${r.id}`, () => api.del(`/t/${tenant}/rules/${r.id}`)))) return;
    rules.reload();
    toast(`Regla «${r.name}» borrada.`, {
      tono: "ok",
      accion: {
        label: "deshacer",
        fn: async () => {
          await api.post(`/t/${tenant}/rules`, { name: r.name, content: r.content }).catch(() => null);
          if (!r.is_active) {
            const d = await api.get<{ items: Rule[] }>(`/t/${tenant}/rules`).catch(() => null);
            const nueva = d?.items.find((x) => x.name === r.name && x.content === r.content);
            if (nueva) await api.patch(`/t/${tenant}/rules/${nueva.id}`, { isActive: false }).catch(() => null);
          }
          rules.reload();
        },
      },
    });
  };

  const items = rules.data?.items ?? [];
  const activas = items.filter((r) => r.is_active).length;

  return (
    <Panel
      title="reglas"
      desc="Lo que cumple siempre, en el chat, la llamada y las tareas. También se las podés pedir hablando: «de ahora en más…»."
      aside={items.length > 0 ? <span className="chip plain">{activas} de {items.length} prendidas</span> : undefined}
    >
      {rules.loading && !rules.data ? (
        <Loading lines={3} />
      ) : rules.error ? (
        <Failure error={rules.error} onRetry={rules.reload} />
      ) : items.length ? (
        <ol className="filas reglas">
          {items.map((r) => (
            <li key={r.id} className="fila regla" data-activa={r.is_active}>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={r.is_active}
                aria-label={`${r.name}: ${r.is_active ? "prendida" : "apagada"}`}
                title={r.is_active ? "apagar" : "prender"}
                onClick={() => toggle(r)}
                disabled={act.busy === `t-${r.id}`}
              />
              <div className="fila-main">
                <span className="fila-titulo">{r.name}</span>
                <p className="regla-texto">{r.content}</p>
              </div>
              <div className="fila-acciones">
                <button className="btn small quiet icon-only" type="button" onClick={() => remove(r)} disabled={act.busy !== null} aria-label={`borrar ${r.name}`} title="borrar">
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="Sin reglas">Por ejemplo: «nunca guardes contraseñas ni PINs», «los números de cuenta solo de lo que yo confirmo».</Empty>
      )}
      {abierto ? (
        <form className="regla-nueva surface surface-pad" onSubmit={add}>
          <Field label="nombre">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="sin secretos" autoFocus />}</Field>
          <Field label="qué tiene que cumplir">
            {(id) => <textarea id={id} className="textarea" rows={3} value={content} onChange={(e) => setContent(e.target.value)} required placeholder="Nunca guardes contraseñas, PINs ni códigos." />}
          </Field>
          {act.error && <Failure error={act.error} />}
          <div className="row regla-nueva-acciones">
            <button className="btn quiet" type="button" onClick={() => setAbierto(false)}>
              cancelar
            </button>
            <button className="btn primary" type="submit" disabled={act.busy !== null || !name.trim() || !content.trim()} aria-busy={act.busy === "add"}>
              agregar regla
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button className="btn" type="button" onClick={() => setAbierto(true)}>
            <Icon name="plus" size={16} />
            nueva regla
          </button>
        </div>
      )}
    </Panel>
  );
}
