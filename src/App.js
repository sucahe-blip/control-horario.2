import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";

/* =========================
   HELPERS FECHA / HORA
========================= */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function horaAhora() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toInputDate(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

function fromInputDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

/* 👉 NUEVO: YYYY-MM-DD → DD-MM-YYYY */
function fechaISOaES(fechaISO) {
  if (!fechaISO) return "";
  const [y, m, d] = String(fechaISO).split("-");
  if (!y || !m || !d) return fechaISO;
  return `${d}-${m}-${y}`;
}

/* =========================
   HORAS
========================= */

function timeToSeconds(t) {
  if (!t) return 0;
  const [h, m, s = 0] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function secondsToHHMM(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return `${pad2(hh)}:${pad2(mm)}`;
}

function tramoSegundos(r) {
  if (!r.entrada) return 0;
  const en = timeToSeconds(r.entrada);
  const sa = r.salida ? timeToSeconds(r.salida) : null;
  if (sa == null) return 0;
  return Math.max(0, sa - en);
}

/* =========================
   AGRUPACIONES
========================= */

function agruparPorFecha(registros) {
  const map = new Map();
  registros.forEach((r) => {
    const key = r.fecha;
    const cur = map.get(key) || { fecha: key, totalSeg: 0, items: [] };
    cur.totalSeg += tramoSegundos(r);
    cur.items.push(r);
    map.set(key, cur);
  });
  return Array.from(map.values()).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
}

function agruparPorMes(registros) {
  const map = new Map();
  registros.forEach((r) => {
    const mes = r.fecha?.slice(0, 7); // YYYY-MM
    if (!mes) return;
    const cur = map.get(mes) || { mes, totalSeg: 0 };
    cur.totalSeg += tramoSegundos(r);
    map.set(mes, cur);
  });
  return Array.from(map.values()).sort((a, b) => (a.mes < b.mes ? 1 : -1));
}

/* =========================
   CSV
========================= */

function downloadCSV(filename, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================
   APP
========================= */

export default function App() {
  const [session, setSession] = useState(null);
  const [perfil, setPerfil] = useState(null);
  const [empleado, setEmpleado] = useState(null);

  const [tab, setTab] = useState("inicio");

  const [registrosHoy, setRegistrosHoy] = useState([]);
  const [registrosRango, setRegistrosRango] = useState([]);

  const [desde, setDesde] = useState(toInputDate(new Date()));
  const [hasta, setHasta] = useState(toInputDate(new Date()));

  /* =========================
     SESIÓN
  ========================= */

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    supabase.auth.onAuthStateChange((_e, s) => setSession(s));
  }, []);

  useEffect(() => {
    if (!session?.user?.id) return;
    supabase
      .from("usuarios")
      .select("empleado_id")
      .eq("user_id", session.user.id)
      .single()
      .then(({ data }) => setPerfil(data));

    supabase
      .from("empleados")
      .select("*")
      .eq("id", perfil?.empleado_id)
      .single()
      .then(({ data }) => setEmpleado(data));
  }, [session?.user?.id, perfil?.empleado_id]);

  /* =========================
     DATOS
  ========================= */

  async function cargarHoy() {
    if (!perfil?.empleado_id) return;
    const { data } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .eq("fecha", hoyISO());
    setRegistrosHoy(data || []);
  }

  async function cargarRango() {
    if (!perfil?.empleado_id) return;
    const { data } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .gte("fecha", desde)
      .lte("fecha", hasta);
    setRegistrosRango(data || []);
  }

  useEffect(() => {
    cargarHoy();
  }, [perfil?.empleado_id]);

  useEffect(() => {
    if (tab === "historico") cargarRango();
  }, [tab, desde, hasta]);

  /* =========================
     MEMOS
  ========================= */

  const porDia = useMemo(() => agruparPorFecha(registrosRango), [registrosRango]);
  const porMes = useMemo(() => agruparPorMes(registrosRango), [registrosRango]);

  /* =========================
     UI
  ========================= */

  return (
    <div style={{ padding: 20 }}>
      <h2>Control horario</h2>

      <button onClick={() => setTab("inicio")}>Inicio</button>
      <button onClick={() => setTab("historico")}>Histórico</button>

      {tab === "inicio" && (
        <>
          <h3>Hoy ({fechaISOaES(hoyISO())})</h3>
          {registrosHoy.map((r) => (
            <div key={r.id}>
              {fechaISOaES(r.fecha)} · {r.entrada} → {r.salida} (
              {secondsToHHMM(tramoSegundos(r))})
            </div>
          ))}
        </>
      )}

      {tab === "historico" && (
        <>
          <h3>Histórico</h3>

          <div>
            Desde:
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
            Hasta:
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>

          <h4>Totales por mes</h4>
          {porMes.map((m) => (
            <div key={m.mes}>
              {m.mes} → {secondsToHHMM(m.totalSeg)}
            </div>
          ))}

          <h4>Detalle diario</h4>
          {porDia.map((d) => (
            <div key={d.fecha}>
              <strong>
                {fechaISOaES(d.fecha)} — {secondsToHHMM(d.totalSeg)}
              </strong>
              {d.items.map((r) => (
                <div key={r.id}>
                  {r.entrada} → {r.salida} ({secondsToHHMM(tramoSegundos(r))})
                </div>
              ))}
            </div>
          ))}

          <button
            onClick={() =>
              downloadCSV(
                `control_horario_${fechaISOaES(desde)}_a_${fechaISOaES(hasta)}.csv`,
                [
                  ["Fecha", "Entrada", "Salida", "Duración"],
                  ...registrosRango.map((r) => [
                    fechaISOaES(r.fecha),
                    r.entrada,
                    r.salida,
                    secondsToHHMM(tramoSegundos(r)),
                  ]),
                ]
              )
            }
          >
            Exportar CSV
          </button>
        </>
      )}
    </div>
  );
}
