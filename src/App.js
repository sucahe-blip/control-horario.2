import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";

/**
 * Control horario - Cañizares S.A.
 *
 * Tablas esperadas:
 * public.empleados:  id (uuid), nombre (text), rol (text)
 * public.usuarios:   user_id (uuid), empleado_id (uuid), rol (text), es_admin (bool), es_inspector (bool)
 * public.registros:  id (uuid), empleado_id (uuid), fecha (date), tipo (text), entrada (time), salida (time), nota (text)
 *
 * Jornada partida => VARIAS FILAS mismo día:
 *  - iniciar jornada: inserta nueva fila (fecha hoy, entrada hora, salida null)
 *  - finalizar jornada: actualiza la ÚLTIMA fila abierta (salida null) poniendo salida hora
 */

const EMPRESA = {
  nombre: "Cañizares, Instalaciones y Proyectos, S.A.",
  cif: "A78593316",
  direccion: "Calle Islas Cíes 35, 28035 Madrid",
  email: "canizares@jcanizares.com",
};

const MESES_ES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

// ---------- helpers fecha/hora ----------
function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtHora(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtFechaLarga(d) {
  const dias = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const meses = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  return `Hoy, ${dias[d.getDay()]}, ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
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
  const [y, m, d] = String(str || "")
    .split("-")
    .map((v) => parseInt(v, 10));
  const dt = new Date();
  dt.setFullYear(y, (m || 1) - 1, d || 1);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

// Convierte "YYYY-MM-DD" -> "DD-MM-YYYY"
function fmtFechaDDMMYYYY(isoDate) {
  if (!isoDate) return "";
  const s = String(isoDate);
  const just = s.slice(0, 10);
  const [y, m, d] = just.split("-");
  if (!y || !m || !d) return s;
  return `${d}-${m}-${y}`;
}

// Primer y último día del mes (ISO YYYY-MM-DD)
function firstDayOfMonthISO(year, monthIndex) {
  const d = new Date(year, monthIndex, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function lastDayOfMonthISO(year, monthIndex) {
  const d = new Date(year, monthIndex + 1, 0); // día 0 del siguiente mes => último del actual
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------- helpers horas ----------
function timeToSeconds(t) {
  if (!t) return null;
  const parts = String(t).split(":").map((x) => parseInt(x, 10));
  if (parts.length < 2) return null;
  const [hh, mm, ss] = [parts[0], parts[1], parts[2] ?? 0];
  if ([hh, mm, ss].some((n) => Number.isNaN(n))) return null;
  return hh * 3600 + mm * 60 + ss;
}
function secondsToHHMM(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return `${pad2(hh)}:${pad2(mm)}`;
}
function tramoSegundos(r, opts = { contarAbiertosHoyHastaAhora: true }) {
  const en = timeToSeconds(r.entrada);
  if (en == null) return 0;

  const sa = timeToSeconds(r.salida);

  // tramo abierto:
  if (sa == null) {
    if (opts.contarAbiertosHoyHastaAhora && r.fecha === hoyISO()) {
      const ahora = new Date();
      const nowSec = ahora.getHours() * 3600 + ahora.getMinutes() * 60 + ahora.getSeconds();
      return Math.max(0, nowSec - en);
    }
    return 0;
  }

  return Math.max(0, sa - en);
}

function agruparPorFecha(registros) {
  const map = new Map(); // fecha -> { items, totalSeg }
  for (const r of registros || []) {
    const key = r.fecha || "Sin fecha";
    const cur = map.get(key) || { items: [], totalSeg: 0 };
    cur.items.push(r);
    cur.totalSeg += tramoSegundos(r);
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([fecha, data]) => ({ fecha, ...data }));
}

function calcularTotalesMensualesDesdeRegistros(registros, year) {
  const tot = new Array(12).fill(0);
  for (const r of registros || []) {
    if (!r?.fecha) continue;
    const f = String(r.fecha).slice(0, 10);
    const [yy, mm] = f.split("-");
    const y = parseInt(yy, 10);
    const m = parseInt(mm, 10);
    if (!y || !m) continue;
    if (y !== Number(year)) continue;
    const idx = m - 1;
    if (idx < 0 || idx > 11) continue;
    tot[idx] += tramoSegundos(r, { contarAbiertosHoyHastaAhora: false });
  }
  return tot;
}

function calcularTotalesPorAnio(registros) {
  const map = new Map(); // year -> seconds
  for (const r of registros || []) {
    const f = String(r.fecha || "").slice(0, 10);
    if (!f) continue;
    const yy = parseInt(f.slice(0, 4), 10);
    if (!yy || Number.isNaN(yy)) continue;
    const prev = map.get(yy) || 0;
    map.set(yy, prev + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }));
  }
  return map;
}

// ---------- CSV ----------
function downloadCSV(filename, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = rows.map((r) => r.map(esc).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function tipoBonito(tipo) {
  const t = (tipo || "").toLowerCase();
  if (t === "inicio") return "Inicio jornada";
  if (t === "fin") return "Fin jornada";
  return tipo || "-";
}

function calcularEstadoHoy(registrosHoy) {
  const abierto = (registrosHoy || []).some((r) => !r.salida);
  return { estado: abierto ? "Dentro" : "Fuera", abiertoTrabajo: abierto };
}

function nombreEmpleadoById(empleados, id) {
  const emp = (empleados || []).find((e) => e.id === id);
  return emp?.nombre || id || "";
}

// ---------- App ----------
export default function App() {
  const [ahora, setAhora] = useState(new Date());

  // Auth/UI
  const [session, setSession] = useState(null);
  const [cargandoSesion, setCargandoSesion] = useState(true);
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");

  const [msg, setMsg] = useState(null); // {type:'ok'|'err', text:''}

  // Perfil/roles
  const [perfil, setPerfil] = useState(null); // usuarios row
  const [empleado, setEmpleado] = useState(null); // empleados row (del usuario)
  const [rol, setRol] = useState("empleado"); // empleado | admin | inspector
  const isInspector = rol === "inspector";
  const isAdmin = rol === "admin";

  // Tabs
  const [tab, setTab] = useState("inicio"); // inicio | historico

  // Registros (usuario actual)
  const [registrosHoy, setRegistrosHoy] = useState([]);
  const [registrosRango, setRegistrosRango] = useState([]);
  const [nota, setNota] = useState("");

  // Filtros rango (inputs "date" requieren YYYY-MM-DD como value)
  const [desde, setDesde] = useState(toInputDate(new Date()));
  const [hasta, setHasta] = useState(toInputDate(new Date()));

  // Inspector/admin
  const [empleados, setEmpleados] = useState([]);
  const [empleadoSel, setEmpleadoSel] = useState(""); // empleado_id seleccionado o "" (todos)
  const [registrosInspector, setRegistrosInspector] = useState([]);
  const [cargandoInspector, setCargandoInspector] = useState(false);

  // Cache de registros para resumen anual/mensual (según scope: tu usuario / empleado seleccionado / todos)
  const [scopeRegistros, setScopeRegistros] = useState([]);
  const [cargandoScopeRegistros, setCargandoScopeRegistros] = useState(false);

  // Selector año/mes
  const [aniosDisponibles, setAniosDisponibles] = useState([]); // [2026,2025...]
  const [anioSel, setAnioSel] = useState(new Date().getFullYear());
  const [mesSel, setMesSel] = useState(""); // "" = ninguno, "0".."11"

  // Resumen anual bonito
  const [resumenAnual, setResumenAnual] = useState([]); // [{year,totalSeg}]

  // Modales
  const [showPrivacidad, setShowPrivacidad] = useState(false);
  const [showRecover, setShowRecover] = useState(false);

  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPass1, setNewPass1] = useState("");
  const [newPass2, setNewPass2] = useState("");

  const relojRef = useRef(null);

  // Tick reloj
  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Detectar link de recovery
  useEffect(() => {
    const hash = window.location.hash || "";
    const isRecovery =
      hash.includes("type=recovery") ||
      hash.includes("type=magiclink") ||
      hash.includes("access_token=") ||
      hash.includes("code=");
    if (isRecovery) setRecoveryMode(true);
  }, []);

  // Cargar sesión + listener
  useEffect(() => {
    let mounted = true;

    async function init() {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(data.session || null);
      setCargandoSesion(false);
    }
    init();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession || null);
      if (_event === "PASSWORD_RECOVERY") setRecoveryMode(true);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // Cargar perfil
  useEffect(() => {
    async function cargarPerfil() {
      setPerfil(null);
      setEmpleado(null);
      setRol("empleado");

      if (!session?.user?.id) return;

      const { data: u, error: e1 } = await supabase
        .from("usuarios")
        .select("user_id, empleado_id, rol, es_admin, es_inspector")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (e1) {
        setMsg({ type: "err", text: `Error cargando usuario: ${e1.message}` });
        return;
      }

      setPerfil(u || null);

      const r =
        (u?.rol && String(u.rol).toLowerCase()) ||
        (u?.es_inspector ? "inspector" : u?.es_admin ? "admin" : "empleado");

      setRol(r === "inspector" ? "inspector" : r === "admin" ? "admin" : "empleado");

      if (u?.empleado_id) {
        const { data: emp, error: e2 } = await supabase
          .from("empleados")
          .select("*")
          .eq("id", u.empleado_id)
          .maybeSingle();
        if (!e2) setEmpleado(emp || null);
      }
    }

    cargarPerfil();
  }, [session?.user?.id]);

  // Refrescar HOY (usuario)
  async function refrescarHoy() {
    setRegistrosHoy([]);
    if (!perfil?.empleado_id) return;

    const { data, error } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .eq("fecha", hoyISO())
      .order("entrada", { ascending: false });

    if (error) {
      setMsg({ type: "err", text: `Error cargando registros de hoy: ${error.message}` });
      return;
    }
    setRegistrosHoy(data || []);
  }

  useEffect(() => {
    if (session?.user?.id && perfil?.empleado_id) refrescarHoy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, perfil?.empleado_id]);

  // Inspector/admin: cargar empleados
  useEffect(() => {
    async function cargarEmpleados() {
      setEmpleados([]);
      if (!session?.user?.id) return;
      if (!(isInspector || isAdmin)) return;

      const { data, error } = await supabase.from("empleados").select("*").order("nombre", { ascending: true });

      if (error) {
        setMsg({ type: "err", text: `Error cargando empleados: ${error.message}` });
        return;
      }
      setEmpleados(data || []);
    }

    cargarEmpleados();
  }, [session?.user?.id, isInspector, isAdmin]);

  // Inspector/admin: buscar registros rango + empleado (botón Buscar)
  async function cargarInspector() {
    if (!(isInspector || isAdmin)) return;
    setCargandoInspector(true);
    setRegistrosInspector([]);

    const d = fromInputDate(desde);
    const h = fromInputDate(hasta);

    const desdeISO = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const hastaISO = `${h.getFullYear()}-${pad2(h.getMonth() + 1)}-${pad2(h.getDate())}`;

    let q = supabase
      .from("registros")
      .select("*")
      .gte("fecha", desdeISO)
      .lte("fecha", hastaISO)
      .order("fecha", { ascending: false })
      .order("entrada", { ascending: false });

    if (empleadoSel) q = q.eq("empleado_id", empleadoSel);

    const { data, error } = await q;

    setCargandoInspector(false);

    if (error) {
      setMsg({ type: "err", text: `Error cargando registros: ${error.message}` });
      return;
    }
    setRegistrosInspector(data || []);
  }

  // Empleado normal: histórico rango auto (sin botón)
  useEffect(() => {
    async function cargarRangoUsuario() {
      setRegistrosRango([]);
      if (tab !== "historico") return;
      if (!perfil?.empleado_id) return;
      if (isInspector || isAdmin) return;

      const d = fromInputDate(desde);
      const h = fromInputDate(hasta);

      const desdeISO = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const hastaISO = `${h.getFullYear()}-${pad2(h.getMonth() + 1)}-${pad2(h.getDate())}`;

      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", perfil.empleado_id)
        .gte("fecha", desdeISO)
        .lte("fecha", hastaISO)
        .order("fecha", { ascending: false })
        .order("entrada", { ascending: false });

      if (error) {
        setMsg({ type: "err", text: `Error cargando histórico: ${error.message}` });
        return;
      }
      setRegistrosRango(data || []);
    }

    cargarRangoUsuario();
  }, [tab, perfil?.empleado_id, desde, hasta, isInspector, isAdmin]);

  // Cargar scopeRegistros para:
  // - lista de años disponibles
  // - resumen anual bonito
  // - totales mensuales del año seleccionado
  useEffect(() => {
    async function cargarScopeRegistros() {
      setScopeRegistros([]);
      setAniosDisponibles([]);
      setResumenAnual([]);

      if (tab !== "historico") return;
      if (!session?.user?.id) return;

      // Si no es admin/inspector, necesitamos empleado_id
      if (!(isAdmin || isInspector) && !perfil?.empleado_id) return;

      setCargandoScopeRegistros(true);

      let q = supabase
        .from("registros")
        .select("id,empleado_id,fecha,entrada,salida,tipo,nota")
        .order("fecha", { ascending: true })
        .order("entrada", { ascending: true });

      if (isAdmin || isInspector) {
        if (empleadoSel) q = q.eq("empleado_id", empleadoSel);
      } else {
        q = q.eq("empleado_id", perfil.empleado_id);
      }

      const { data, error } = await q;

      setCargandoScopeRegistros(false);

      if (error) {
        setMsg({ type: "err", text: `Error cargando resumen anual: ${error.message}` });
        return;
      }

      const regs = data || [];
      setScopeRegistros(regs);

      const mapYear = calcularTotalesPorAnio(regs);
      const years = Array.from(mapYear.keys()).sort((a, b) => b - a);

      setAniosDisponibles(years);

      const resumen = years.map((y) => ({ year: y, totalSeg: mapYear.get(y) || 0 }));
      setResumenAnual(resumen);

      if (years.length > 0 && !years.includes(Number(anioSel))) {
        setAnioSel(years[0]);
      }
      if (years.length === 0) {
        setAnioSel(new Date().getFullYear());
      }
    }

    cargarScopeRegistros();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, session?.user?.id, isAdmin, isInspector, perfil?.empleado_id, empleadoSel]);

  // Totales mensuales del año seleccionado (calculado desde scopeRegistros)
  const totalesMensualesSeg = useMemo(() => {
    const y = Number(anioSel);
    if (!y || Number.isNaN(y)) return new Array(12).fill(0);
    return calcularTotalesMensualesDesdeRegistros(scopeRegistros, y);
  }, [scopeRegistros, anioSel]);

  const totalAnualSelSeg = useMemo(
    () => (totalesMensualesSeg || []).reduce((a, b) => a + (b || 0), 0),
    [totalesMensualesSeg]
  );

  const estadoHoy = useMemo(() => calcularEstadoHoy(registrosHoy), [registrosHoy]);

  // Totales día/rango
  const totalHoySeg = useMemo(() => (registrosHoy || []).reduce((acc, r) => acc + tramoSegundos(r), 0), [registrosHoy]);

  const porDiaRangoUsuario = useMemo(() => agruparPorFecha(registrosRango), [registrosRango]);
  const totalRangoUsuarioSeg = useMemo(
    () => (registrosRango || []).reduce((acc, r) => acc + tramoSegundos(r), 0),
    [registrosRango]
  );

  const porDiaInspector = useMemo(() => agruparPorFecha(registrosInspector), [registrosInspector]);
  const totalInspectorSeg = useMemo(
    () => (registrosInspector || []).reduce((acc, r) => acc + tramoSegundos(r), 0),
    [registrosInspector]
  );

  // --------- Jornada partida: varias filas mismo día ---------
  async function iniciarJornada() {
    setMsg(null);
    if (!perfil?.empleado_id) return;

    const abierta = (registrosHoy || []).some((r) => !r.salida);
    if (abierta) {
      setMsg({ type: "err", text: "Ya tienes la jornada iniciada (hay un tramo abierto)." });
      return;
    }

    const payload = {
      empleado_id: perfil.empleado_id,
      fecha: hoyISO(),
      tipo: "inicio",
      entrada: horaAhora(),
      salida: null,
      nota: (nota || "").trim() || null,
    };

    const { error } = await supabase.from("registros").insert(payload);

    if (error) {
      setMsg({ type: "err", text: `Error iniciando jornada: ${error.message}` });
      return;
    }

    setMsg({ type: "ok", text: "Jornada iniciada ✅" });
    setNota("");
    await refrescarHoy();
  }

  async function finalizarJornada() {
    setMsg(null);
    if (!perfil?.empleado_id) return;

    const { data, error } = await supabase
      .from("registros")
      .select("id, entrada, salida, nota")
      .eq("empleado_id", perfil.empleado_id)
      .eq("fecha", hoyISO())
      .is("salida", null)
      .order("entrada", { ascending: false })
      .limit(1);

    if (error) {
      setMsg({ type: "err", text: `Error buscando tramo abierto: ${error.message}` });
      return;
    }

    const abierto = data?.[0];
    if (!abierto?.id) {
      setMsg({ type: "err", text: "No hay jornada abierta para finalizar." });
      return;
    }

    const notaLimpia = (nota || "").trim() || null;
    const updatePayload = { salida: horaAhora(), tipo: "fin" };
    if (notaLimpia) updatePayload.nota = notaLimpia;

    const { error: e2 } = await supabase.from("registros").update(updatePayload).eq("id", abierto.id);

    if (e2) {
      setMsg({ type: "err", text: `Error finalizando jornada: ${e2.message}` });
      return;
    }

    setMsg({ type: "ok", text: "Jornada finalizada ✅" });
    setNota("");
    await refrescarHoy();
  }

  // --------- Login/Logout ---------
  async function entrar(e) {
    e?.preventDefault?.();
    setMsg(null);

    const { error } = await supabase.auth.signInWithPassword({
      email: (email || "").trim(),
      password: pass || "",
    });

    if (error) {
      setMsg({ type: "err", text: error.message });
      return;
    }

    setPass("");
    setTab("inicio");
    setMsg({ type: "ok", text: "Sesión iniciada ✅" });
  }

  async function salir() {
    setMsg(null);
    await supabase.auth.signOut();
    setTab("inicio");
    setEmail("");
    setPass("");
    setPerfil(null);
    setEmpleado(null);
    setRol("empleado");
    setRegistrosHoy([]);
    setRegistrosRango([]);
    setRegistrosInspector([]);
    setEmpleadoSel("");
    setScopeRegistros([]);
    setAniosDisponibles([]);
    setResumenAnual([]);
    setMsg({ type: "ok", text: "Sesión cerrada" });
  }

  // --------- Recuperar contraseña ---------
  async function enviarRecuperacion() {
    setMsg(null);
    const em = (email || "").trim();
    if (!em) {
      setMsg({ type: "err", text: "Escribe tu email primero." });
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(em, {
      redirectTo: window.location.origin,
    });

    if (error) {
      setMsg({ type: "err", text: error.message });
      return;
    }

    setMsg({ type: "ok", text: "Te hemos enviado un email para restablecer la contraseña." });
  }

  async function guardarNuevaPass() {
    setMsg(null);
    if (!newPass1 || newPass1.length < 6) {
      setMsg({ type: "err", text: "La contraseña debe tener mínimo 6 caracteres." });
      return;
    }
    if (newPass1 !== newPass2) {
      setMsg({ type: "err", text: "Las contraseñas no coinciden." });
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: newPass1 });

    if (error) {
      setMsg({ type: "err", text: error.message });
      return;
    }

    setRecoveryMode(false);
    setNewPass1("");
    setNewPass2("");
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    setMsg({ type: "ok", text: "Contraseña actualizada ✅" });
  }

  async function cerrarRecoverySinGuardar() {
    setRecoveryMode(false);
    setNewPass1("");
    setNewPass2("");
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    await supabase.auth.signOut();
    setSession(null);
    setPerfil(null);
    setEmpleado(null);
    setRol("empleado");
    setMsg({ type: "ok", text: "Cancelado. No se ha cambiado la contraseña." });
  }

  // ------- Mes/año: aplicar rango -------
  function aplicarMesAlRango(year, monthIndex) {
    const dISO = firstDayOfMonthISO(year, monthIndex);
    const hISO = lastDayOfMonthISO(year, monthIndex);
    setDesde(dISO);
    setHasta(hISO);
  }
  function onClickMes(monthIndex) {
    setMesSel(String(monthIndex));
    aplicarMesAlRango(Number(anioSel), monthIndex);
  }
  function onSelectorMesChange(val) {
    setMesSel(val);
    if (val === "") return;
    const mi = parseInt(val, 10);
    if (Number.isNaN(mi)) return;
    aplicarMesAlRango(Number(anioSel), mi);
  }
  function onSelectorAnioChange(val) {
    const y = parseInt(val, 10);
    if (Number.isNaN(y)) return;
    setAnioSel(y);
    if (mesSel !== "") {
      const mi = parseInt(mesSel, 10);
      if (!Number.isNaN(mi)) aplicarMesAlRango(y, mi);
    }
  }

  // Nombre visible
  const nombreVisible = useMemo(() => {
    const n = (empleado?.nombre || "").trim();
    return n || "(Sin nombre)";
  }, [empleado?.nombre]);

  const s = styles;
  const haySesion = !!session?.user?.id;

  // UI helpers
  const fechaLarga = useMemo(() => fmtFechaLarga(ahora), [ahora]);
  const horaGrande = useMemo(() => fmtHora(ahora), [ahora]);

  // ------- Export CSV MES -------
  async function exportarCSVDelMes() {
    setMsg(null);
    const year = Number(anioSel);

    let monthIndex = null;
    if (mesSel !== "") {
      const mi = parseInt(mesSel, 10);
      if (!Number.isNaN(mi)) monthIndex = mi;
    } else {
      const d = fromInputDate(desde);
      monthIndex = d.getMonth();
    }

    if (monthIndex == null || monthIndex < 0 || monthIndex > 11) {
      setMsg({ type: "err", text: "Selecciona un mes para exportar." });
      return;
    }

    const desdeM = firstDayOfMonthISO(year, monthIndex);
    const hastaM = lastDayOfMonthISO(year, monthIndex);

    const esAdminTodos = (isAdmin || isInspector) && !empleadoSel;

    let q = supabase
      .from("registros")
      .select("*")
      .gte("fecha", desdeM)
      .lte("fecha", hastaM)
      .order("empleado_id", { ascending: true })
      .order("fecha", { ascending: true })
      .order("entrada", { ascending: true });

    let labelEmpleado = "todos";

    if (isInspector || isAdmin) {
      if (empleadoSel) {
        q = q.eq("empleado_id", empleadoSel);
        labelEmpleado = (empleados.find((e) => e.id === empleadoSel)?.nombre || "empleado").replace(/\s+/g, "_");
      } else {
        labelEmpleado = "todos";
      }
    } else {
      if (!perfil?.empleado_id) {
        setMsg({ type: "err", text: "No se ha detectado tu empleado_id." });
        return;
      }
      q = q.eq("empleado_id", perfil.empleado_id);
      labelEmpleado = (empleado?.nombre || "mi_usuario").replace(/\s+/g, "_");
    }

    const { data, error } = await q;

    if (error) {
      setMsg({ type: "err", text: `Error exportando CSV del mes: ${error.message}` });
      return;
    }

    const registros = data || [];

    if (esAdminTodos) {
      const mapEmp = new Map();
      for (const r of registros) {
        const key = r.empleado_id || "sin_empleado";
        const arr = mapEmp.get(key) || [];
        arr.push(r);
        mapEmp.set(key, arr);
      }

      const empleadosOrdenados = Array.from(mapEmp.keys()).sort((a, b) => {
        const na = nombreEmpleadoById(empleados, a).toLowerCase();
        const nb = nombreEmpleadoById(empleados, b).toLowerCase();
        return na.localeCompare(nb);
      });

      const totalMesSeg = registros.reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0);

      const rows = [
        ["MES", `${MESES_ES[monthIndex]} ${year}`],
        ["DESDE", fmtFechaDDMMYYYY(desdeM)],
        ["HASTA", fmtFechaDDMMYYYY(hastaM)],
        ["TOTAL MES (TODOS)", secondsToHHMM(totalMesSeg)],
        [],
        ["AGRUPADO POR EMPLEADO"],
      ];

      // Resumen inicial "Empleado -> Total"
      rows.push([]);
      rows.push(["RESUMEN"]);
      rows.push(["Empleado", "Total"]);
      for (const empId of empleadosOrdenados) {
        const regsEmp = mapEmp.get(empId) || [];
        const empNom = nombreEmpleadoById(empleados, empId);
        const totalEmp = regsEmp.reduce(
          (acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }),
          0
        );
        rows.push([empNom, secondsToHHMM(totalEmp)]);
      }

      // Detalle por empleado
      for (const empId of empleadosOrdenados) {
        const regsEmp = mapEmp.get(empId) || [];
        const empNom = nombreEmpleadoById(empleados, empId);
        const totalEmp = regsEmp.reduce(
          (acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }),
          0
        );

        rows.push([]);
        rows.push(["EMPLEADO", empNom]);
        rows.push(["TOTAL EMPLEADO", secondsToHHMM(totalEmp)]);
        rows.push(["Fecha", "Entrada", "Salida", "Duración", "Tipo", "Nota"]);

        for (const r of regsEmp) {
          rows.push([
            fmtFechaDDMMYYYY(r.fecha),
            r.entrada || "",
            r.salida || "",
            secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
            tipoBonito(r.tipo),
            r.nota || "",
          ]);
        }
      }

      const filename = `control_horario_${year}_${pad2(monthIndex + 1)}_TODOS_AGRUPADO.csv`;
      downloadCSV(filename, rows);
      setMsg({ type: "ok", text: `CSV del mes (Todos agrupado) exportado ✅` });
      return;
    }

    const totalMesSeg = registros.reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0);

    const rows = [
      ["MES", `${MESES_ES[monthIndex]} ${year}`],
      ["DESDE", fmtFechaDDMMYYYY(desdeM)],
      ["HASTA", fmtFechaDDMMYYYY(hastaM)],
      ["TOTAL MES", secondsToHHMM(totalMesSeg)],
      [],
      ["DETALLE"],
      ["Fecha", "Empleado", "Entrada", "Salida", "Duración", "Tipo", "Nota"],
      ...registros.map((r) => [
        fmtFechaDDMMYYYY(r.fecha),
        isInspector || isAdmin ? nombreEmpleadoById(empleados, r.empleado_id) : (empleado?.nombre || ""),
        r.entrada || "",
        r.salida || "",
        secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
        tipoBonito(r.tipo),
        r.nota || "",
      ]),
    ];

    const filename = `control_horario_${year}_${pad2(monthIndex + 1)}_${labelEmpleado}.csv`;
    downloadCSV(filename, rows);
    setMsg({ type: "ok", text: `CSV del mes (${MESES_ES[monthIndex]} ${year}) exportado ✅` });
  }

  // ------- Export CSV AÑO -------
  async function exportarCSVDelAnio() {
    setMsg(null);
    const year = Number(anioSel);
    const desdeY = `${year}-01-01`;
    const hastaY = `${year}-12-31`;

    let q = supabase
      .from("registros")
      .select("*")
      .gte("fecha", desdeY)
      .lte("fecha", hastaY)
      .order("fecha", { ascending: true })
      .order("entrada", { ascending: true });

    let labelEmpleado = "todos";

    if (isInspector || isAdmin) {
      if (empleadoSel) {
        q = q.eq("empleado_id", empleadoSel);
        labelEmpleado = (empleados.find((e) => e.id === empleadoSel)?.nombre || "empleado").replace(/\s+/g, "_");
      } else {
        labelEmpleado = "todos";
      }
    } else {
      if (!perfil?.empleado_id) {
        setMsg({ type: "err", text: "No se ha detectado tu empleado_id." });
        return;
      }
      q = q.eq("empleado_id", perfil.empleado_id);
      labelEmpleado = (empleado?.nombre || "mi_usuario").replace(/\s+/g, "_");
    }

    const { data, error } = await q;

    if (error) {
      setMsg({ type: "err", text: `Error exportando CSV del año: ${error.message}` });
      return;
    }

    const registros = data || [];
    const totalYearSeg = registros.reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0);
    const totMes = calcularTotalesMensualesDesdeRegistros(registros, year);

    const rows = [
      ["AÑO", String(year)],
      ["DESDE", fmtFechaDDMMYYYY(desdeY)],
      ["HASTA", fmtFechaDDMMYYYY(hastaY)],
      ["TOTAL AÑO", secondsToHHMM(totalYearSeg)],
      [],
      ["RESUMEN MENSUAL"],
      ["Mes", "Total"],
      ...MESES_ES.map((m, i) => [m, secondsToHHMM(totMes[i] || 0)]),
      [],
      ["DETALLE"],
      ["Fecha", "Empleado", "Entrada", "Salida", "Duración", "Tipo", "Nota"],
      ...registros.map((r) => [
        fmtFechaDDMMYYYY(r.fecha),
        isInspector || isAdmin ? nombreEmpleadoById(empleados, r.empleado_id) : (empleado?.nombre || ""),
        r.entrada || "",
        r.salida || "",
        secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
        tipoBonito(r.tipo),
        r.nota || "",
      ]),
    ];

    const filename = `control_horario_${year}_ANIO_${labelEmpleado}.csv`;
    downloadCSV(filename, rows);
    setMsg({ type: "ok", text: `CSV del año (${year}) exportado ✅` });
  }

  // --------- UI ---------
  const showHeaderNav = haySesion;

  return (
    <div style={s.pagina}>
      <div style={s.shell}>
        <div style={s.header}>
          <div style={s.headerTop}>
            <div style={s.marca}>
              <div style={s.nombreMarca}>Cañizares S.A.</div>
              <div style={s.brandSub}>Control horario</div>
            </div>
            <div style={s.datePill}>{fechaLarga}</div>
          </div>

          <div style={s.reloj} ref={relojRef}>
            <div style={{ fontSize: 12, opacity: 0.9, fontWeight: 800 }}>Hora actual</div>
            <div style={s.clockBig}>{horaGrande}</div>
          </div>

          {showHeaderNav && (
            <>
              <div style={s.statusPill}>
                <div style={{ opacity: 0.9, fontWeight: 800 }}>Estado</div>
                <div style={s.statusValue}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      marginRight: 8,
                      background: estadoHoy.estado === "Dentro" ? "#7CFC00" : "#d9d9d9",
                      border: "2px solid rgba(255,255,255,0.55)",
                    }}
                  />
                  {estadoHoy.estado}
                </div>
              </div>

              <div style={s.tabs}>
                <button style={tab === "inicio" ? s.tabActive : s.tab} onClick={() => setTab("inicio")}>
                  Inicio
                </button>
                <button style={tab === "historico" ? s.tabActive : s.tab} onClick={() => setTab("historico")}>
                  Histórico
                </button>
              </div>
            </>
          )}
        </div>

        <div style={s.card}>
          {!haySesion && (
            <form onSubmit={entrar}>
              <div style={s.cardTitle}>Acceso</div>

              <input
                style={s.input}
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <input
                style={s.input}
                placeholder="Password"
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                autoComplete="current-password"
              />

              <button style={s.btnMain} type="submit" disabled={cargandoSesion}>
                Entrar
              </button>

              <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={s.linkBtn}
                  onClick={() => {
                    setShowRecover(true);
                    setMsg(null);
                  }}
                >
                  ¿Has olvidado la contraseña?
                </button>

                <button
                  type="button"
                  style={s.linkBtn}
                  onClick={() => {
                    setShowPrivacidad(true);
                    setMsg(null);
                  }}
                >
                  Aviso de privacidad
                </button>
              </div>

              {msg && (
                <div style={msg.type === "ok" ? s.msgOk : s.msgErr}>
                  {msg.type === "ok" ? "✅ " : "❌ "}
                  {msg.text}
                </div>
              )}
            </form>
          )}

          {haySesion && (
            <>
              <div style={s.userRow}>
                <div style={s.userPill}>
                  <span style={{ marginRight: 10 }}>👤</span>
                  <span style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {nombreVisible}
                  </span>
                  {(isInspector || isAdmin) && <span style={s.roleBadge}>{isAdmin ? "ADMIN" : "INSPECCIÓN"}</span>}
                </div>

                <button style={s.btnOut} onClick={salir}>
                  Salir
                </button>
              </div>

              <div style={s.hr} />

              {tab === "inicio" && (
                <>
                  <div style={s.label}>Nota</div>
                  <input
                    style={s.input}
                    placeholder="(Opcional) Se guardará al iniciar o finalizar"
                    value={nota}
                    onChange={(e) => setNota(e.target.value)}
                  />
                  <div style={{ fontSize: 13, opacity: 0.75, fontWeight: 700 }}>
                    Ej.: motivo de ausencia, detalle del día, etc.
                  </div>

                  {msg && (
                    <div style={msg.type === "ok" ? s.msgOk : s.msgErr}>
                      {msg.type === "ok" ? "✅ " : "❌ "}
                      {msg.text}
                    </div>
                  )}

                  <div style={s.hr} />

                  <div style={s.sectionTitle}>Registro de hoy</div>
                  <div style={{ fontWeight: 950, opacity: 0.85, marginBottom: 10 }}>
                    Total hoy: {secondsToHHMM(totalHoySeg)}
                  </div>

                  {registrosHoy.length === 0 ? (
                    <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin registros hoy)</div>
                  ) : (
                    <div style={s.list}>
                      {registrosHoy.slice(0, 50).map((r) => (
                        <div key={r.id} style={s.listRow}>
                          <div style={{ fontWeight: 900 }}>{tipoBonito(r.tipo)}</div>
                          <div style={{ opacity: 0.85, fontWeight: 800 }}>
                            {fmtFechaDDMMYYYY(r.fecha)} — {r.entrada || "--:--:--"} → {r.salida || "--:--:--"} ({" "}
                            {secondsToHHMM(tramoSegundos(r))} )
                          </div>
                          <div style={{ opacity: 0.85 }}>
                            <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={s.bottomBar}>
                    <button style={s.btnSoft} onClick={iniciarJornada} disabled={estadoHoy.abiertoTrabajo}>
                      Iniciar jornada
                    </button>
                    <button style={s.btnSoft} onClick={finalizarJornada} disabled={!estadoHoy.abiertoTrabajo}>
                      Finalizar jornada
                    </button>
                  </div>
                </>
              )}

              {tab === "historico" && (
                <>
                  <div style={s.sectionTitle}>Histórico</div>

                  {/* BLOQUE RESUMEN ANUAL BONITO + SELECTOR AÑO + MENSUAL */}
                  <div style={s.monthBox}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 950, fontSize: 18 }}>Resumen anual</div>

                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 900, opacity: 0.8 }}>Año</span>
                        <select
                          style={s.selectMini}
                          value={String(anioSel)}
                          onChange={(e) => onSelectorAnioChange(e.target.value)}
                        >
                          {aniosDisponibles.length === 0 && <option value={String(anioSel)}>{anioSel}</option>}
                          {aniosDisponibles.map((y) => (
                            <option key={y} value={String(y)}>
                              {y}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {cargandoScopeRegistros ? (
                      <div style={{ marginTop: 10, fontWeight: 900, opacity: 0.7 }}>Cargando resumen…</div>
                    ) : resumenAnual.length === 0 ? (
                      <div style={{ marginTop: 10, fontWeight: 900, opacity: 0.7 }}>(Sin registros)</div>
                    ) : (
                      <div style={s.yearGrid}>
                        {resumenAnual.map((x) => {
                          const active = Number(x.year) === Number(anioSel);
                          return (
                            <button
                              key={x.year}
                              type="button"
                              onClick={() => onSelectorAnioChange(String(x.year))}
                              style={active ? s.yearPillActive : s.yearPill}
                              title="Pincha para seleccionar este año"
                            >
                              <span style={{ fontWeight: 950 }}>{x.year}</span>
                              <span style={{ fontWeight: 950, opacity: 0.85 }}>{secondsToHHMM(x.totalSeg || 0)}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div style={{ marginTop: 12, fontWeight: 950, opacity: 0.85 }}>
                      Año seleccionado ({anioSel}) — Total: {secondsToHHMM(totalAnualSelSeg)}
                    </div>

                    <div style={s.hrMini} />

                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 950, fontSize: 16 }}>Totales mensuales</div>

                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 950, opacity: 0.85 }}>Selector mes</div>
                        <select style={s.selectMini} value={mesSel} onChange={(e) => onSelectorMesChange(e.target.value)}>
                          <option value="">(Sin seleccionar)</option>
                          {MESES_ES.map((m, i) => (
                            <option key={m} value={String(i)}>
                              {m}
                            </option>
                          ))}
                        </select>

                        <button style={s.btnMini} type="button" onClick={exportarCSVDelMes} disabled={cargandoScopeRegistros}>
                          CSV del mes
                        </button>

                        <button style={s.btnMini} type="button" onClick={exportarCSVDelAnio} disabled={cargandoScopeRegistros}>
                          CSV del año
                        </button>
                      </div>
                    </div>

                    <div style={s.monthGrid}>
                      {MESES_ES.map((m, idx) => {
                        const selected = String(idx) === String(mesSel);
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => onClickMes(idx)}
                            style={selected ? s.monthPillActive : s.monthPill}
                            title="Pincha para rellenar Desde/Hasta con este mes"
                          >
                            <span style={{ fontWeight: 950 }}>{m}</span>
                            <span style={{ fontWeight: 950, opacity: 0.85 }}>{secondsToHHMM(totalesMensualesSeg[idx] || 0)}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div style={{ marginTop: 10, opacity: 0.8, fontWeight: 800, fontSize: 13 }}>
                      Tip: pincha un mes o usa el selector para rellenar Desde y Hasta con ese mes.
                    </div>
                  </div>

                  {/* Rango */}
                  <div style={s.filters}>
                    <div style={s.filterCol}>
                      <div style={s.filterLabel}>Desde</div>
                      <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} style={s.input} />
                    </div>
                    <div style={s.filterCol}>
                      <div style={s.filterLabel}>Hasta</div>
                      <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} style={s.input} />
                    </div>
                  </div>

                  {(isInspector || isAdmin) && (
                    <div style={{ marginTop: 12 }}>
                      <div style={s.filterLabel}>Empleado</div>
                      <select style={s.select} value={empleadoSel} onChange={(e) => setEmpleadoSel(e.target.value)}>
                        <option value="">(Todos)</option>
                        {empleados.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.nombre || emp.id}
                          </option>
                        ))}
                      </select>

                      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                        <button style={s.btnMainSmall} onClick={cargarInspector} disabled={cargandoInspector}>
                          {cargandoInspector ? "Cargando..." : "Buscar"}
                        </button>

                        <button
                          style={s.btnMainSmall}
                          onClick={() => {
                            const rows = [
                              ["TOTAL RANGO", "", "", "", "", secondsToHHMM(totalInspectorSeg)],
                              [],
                              ["Fecha", "Empleado", "Entrada", "Salida", "Duración", "Tipo", "Nota"],
                              ...(registrosInspector || []).map((r) => {
                                const empNom = nombreEmpleadoById(empleados, r.empleado_id);
                                return [
                                  fmtFechaDDMMYYYY(r.fecha),
                                  empNom,
                                  r.entrada || "",
                                  r.salida || "",
                                  secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
                                  tipoBonito(r.tipo),
                                  r.nota || "",
                                ];
                              }),
                            ];
                            downloadCSV(`control_horario_${desde}_a_${hasta}.csv`, rows);
                          }}
                          disabled={!registrosInspector?.length}
                        >
                          Exportar CSV (Excel)
                        </button>
                      </div>

                      <div style={s.hr} />
                      <div style={s.sectionTitle}>Resultados</div>

                      <div style={{ fontWeight: 950, opacity: 0.85, marginBottom: 10 }}>
                        Total rango: {secondsToHHMM(totalInspectorSeg)}
                      </div>

                      {!registrosInspector?.length ? (
                        <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                      ) : (
                        <div style={s.list}>
                          {porDiaInspector.map((d) => (
                            <div key={d.fecha} style={s.listRow}>
                              <div style={{ fontWeight: 950, marginBottom: 6 }}>
                                {fmtFechaDDMMYYYY(d.fecha)} — Total día: {secondsToHHMM(d.totalSeg)}
                              </div>

                              {d.items
                                .slice()
                                .sort((a, b) => (a.entrada < b.entrada ? 1 : -1))
                                .map((r) => {
                                  const empNom = nombreEmpleadoById(empleados, r.empleado_id);
                                  return (
                                    <div key={r.id} style={{ padding: "6px 0", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                                      <div style={{ fontWeight: 950 }}>{empNom}</div>
                                      <div style={{ opacity: 0.85, fontWeight: 800 }}>
                                        {r.entrada || "--:--:--"} → {r.salida || "--:--:--"} ( {secondsToHHMM(tramoSegundos(r))} )
                                      </div>
                                      <div style={{ fontWeight: 900 }}>{tipoBonito(r.tipo)}</div>
                                      <div style={{ opacity: 0.85 }}>
                                        <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {!isInspector && !isAdmin && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontWeight: 950, opacity: 0.85, marginBottom: 10 }}>
                        Total rango: {secondsToHHMM(totalRangoUsuarioSeg)}
                      </div>

                      {!registrosRango?.length ? (
                        <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                      ) : (
                        <div style={s.list}>
                          {porDiaRangoUsuario.map((d) => (
                            <div key={d.fecha} style={s.listRow}>
                              <div style={{ fontWeight: 950, marginBottom: 6 }}>
                                {fmtFechaDDMMYYYY(d.fecha)} — Total día: {secondsToHHMM(d.totalSeg)}
                              </div>

                              {d.items
                                .slice()
                                .sort((a, b) => (a.entrada < b.entrada ? 1 : -1))
                                .map((r) => (
                                  <div key={r.id} style={{ padding: "6px 0", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                                    <div style={{ opacity: 0.85, fontWeight: 800 }}>
                                      {r.entrada || "--:--:--"} → {r.salida || "--:--:--"} ( {secondsToHHMM(tramoSegundos(r))} )
                                    </div>
                                    <div style={{ fontWeight: 900 }}>{tipoBonito(r.tipo)}</div>
                                    <div style={{ opacity: 0.85 }}>
                                      <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                                    </div>
                                  </div>
                                ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {msg && (
                    <div style={msg.type === "ok" ? s.msgOk : s.msgErr}>
                      {msg.type === "ok" ? "✅ " : "❌ "}
                      {msg.text}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* MODAL RECUPERAR */}
      {showRecover && (
        <Modal title="Recuperar contraseña" onClose={() => setShowRecover(false)}>
          <div style={{ fontWeight: 800, opacity: 0.8, marginBottom: 10 }}>
            Te enviaremos un email con un enlace para restablecer la contraseña.
          </div>

          <input style={styles.input} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button style={styles.btnMain} onClick={enviarRecuperacion}>
            Enviar enlace
          </button>

          {msg && (
            <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>
              {msg.type === "ok" ? "✅ " : "❌ "}
              {msg.text}
            </div>
          )}
        </Modal>
      )}

      {/* MODAL RESET PASS */}
      {recoveryMode && (
        <Modal title="Restablecer contraseña" onClose={cerrarRecoverySinGuardar} closeText="Cerrar">
          <div style={{ fontWeight: 800, opacity: 0.8, marginBottom: 10 }}>
            Introduce una nueva contraseña (mínimo 6 caracteres).
          </div>

          <input
            style={styles.input}
            placeholder="Nueva contraseña"
            type="password"
            value={newPass1}
            onChange={(e) => setNewPass1(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="Repite la contraseña"
            type="password"
            value={newPass2}
            onChange={(e) => setNewPass2(e.target.value)}
          />

          <button style={styles.btnMain} onClick={guardarNuevaPass}>
            Guardar contraseña
          </button>

          {msg && (
            <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>
              {msg.type === "ok" ? "✅ " : "❌ "}
              {msg.text}
            </div>
          )}
        </Modal>
      )}

      {/* MODAL PRIVACIDAD */}
      {showPrivacidad && (
        <Modal title="Aviso de privacidad" onClose={() => setShowPrivacidad(false)}>
          <div style={{ lineHeight: 1.5 }}>
            <div style={{ fontWeight: 950, marginBottom: 6 }}>{EMPRESA.nombre}</div>
            <div>
              <b>CIF:</b> {EMPRESA.cif}
            </div>
            <div>
              <b>Domicilio:</b> {EMPRESA.direccion}
            </div>
            <div>
              <b>Email:</b> {EMPRESA.email}
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Finalidad</div>
            <div>
              Gestión del control horario y registro de jornada laboral (entradas y salidas), incluyendo notas asociadas
              al fichaje cuando el usuario las añada.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Base legal</div>
            <div>Cumplimiento de obligaciones legales en materia laboral y gestión de la relación laboral.</div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Conservación</div>
            <div>
              Los registros se conservarán durante el tiempo legalmente exigible y el necesario para atender posibles
              responsabilidades.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Derechos</div>
            <div>
              Puedes solicitar acceso, rectificación, supresión, oposición o limitación escribiendo a {EMPRESA.email}.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Modal ----------
function Modal({ title, children, onClose, closeText = "Cerrar" }) {
  return (
    <div style={styles.modalOverlay} onMouseDown={onClose}>
      <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div style={styles.modalTitle}>{title}</div>
          <button style={styles.modalClose} onClick={onClose} type="button">
            {closeText}
          </button>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
}

// ---------- Estilos ----------
const styles = {
  pagina: {
    minHeight: "100vh",
    background: "#f2f3f6",
    padding: "18px 12px 28px",
    display: "flex",
    justifyContent: "center",
  },
  shell: { width: "100%", maxWidth: 520 },
  header: {
    background: "#b30000",
    borderRadius: 28,
    padding: 22,
    color: "white",
    boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
  },
  headerTop: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 14,
    flexWrap: "wrap",
  },
  marca: { minWidth: 200 },
  nombreMarca: {
    fontSize: 42,
    lineHeight: 1.0,
    fontWeight: 950,
    letterSpacing: -0.5,
  },
  brandSub: { fontSize: 22, fontWeight: 800, opacity: 0.95, marginTop: 6 },
  datePill: {
    background: "rgba(255,255,255,0.16)",
    border: "2px solid rgba(255,255,255,0.18)",
    padding: "10px 14px",
    borderRadius: 999,
    fontWeight: 900,
    maxWidth: 260,
    textAlign: "center",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
  },
  reloj: { marginTop: 16 },
  clockBig: {
    fontSize: 64,
    fontWeight: 950,
    letterSpacing: -1,
    lineHeight: 1.0,
    marginTop: 6,
  },
  statusPill: {
    marginTop: 16,
    background: "rgba(255,255,255,0.14)",
    border: "2px solid rgba(255,255,255,0.16)",
    borderRadius: 18,
    padding: "12px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  statusValue: { fontWeight: 950, fontSize: 20, display: "flex", alignItems: "center" },
  tabs: { marginTop: 14, display: "flex", gap: 14 },
  tab: {
    flex: 1,
    borderRadius: 18,
    padding: "14px 16px",
    fontWeight: 950,
    fontSize: 20,
    border: "2px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.08)",
    color: "white",
  },
  tabActive: {
    flex: 1,
    borderRadius: 18,
    padding: "14px 16px",
    fontWeight: 950,
    fontSize: 20,
    border: "2px solid rgba(255,255,255,0.22)",
    background: "rgba(255,255,255,0.92)",
    color: "#1f2a37",
  },
  card: {
    marginTop: 16,
    background: "white",
    borderRadius: 28,
    padding: 18,
    boxShadow: "0 14px 30px rgba(0,0,0,0.10)",
    border: "1px solid rgba(0,0,0,0.06)",
  },
  cardTitle: { fontSize: 34, fontWeight: 950, color: "#1f2a37", marginBottom: 12 },
  input: {
    width: "100%",
    borderRadius: 18,
    border: "2px solid rgba(0,0,0,0.08)",
    padding: "14px 16px",
    fontSize: 18,
    outline: "none",
    marginTop: 12,
    boxSizing: "border-box",
  },
  select: {
    width: "100%",
    borderRadius: 18,
    border: "2px solid rgba(0,0,0,0.10)",
    padding: "14px 16px",
    fontSize: 16,
    outline: "none",
    marginTop: 8,
    boxSizing: "border-box",
    background: "white",
    fontWeight: 800,
  },
  btnMain: {
    width: "100%",
    marginTop: 16,
    borderRadius: 22,
    padding: "16px 18px",
    fontSize: 22,
    fontWeight: 950,
    border: "none",
    background: "#b30000",
    color: "white",
    boxShadow: "0 10px 20px rgba(179,0,0,0.25)",
  },
  btnMainSmall: {
    borderRadius: 18,
    padding: "12px 14px",
    fontSize: 16,
    fontWeight: 950,
    border: "none",
    background: "#b30000",
    color: "white",
    boxShadow: "0 10px 20px rgba(179,0,0,0.18)",
  },
  linkBtn: {
    border: "none",
    background: "transparent",
    color: "#b30000",
    fontWeight: 950,
    fontSize: 18,
    padding: 0,
    cursor: "pointer",
  },
  msgOk: {
    marginTop: 14,
    padding: "12px 14px",
    borderRadius: 16,
    background: "rgba(34,197,94,0.10)",
    border: "2px solid rgba(34,197,94,0.20)",
    fontWeight: 950,
    color: "#065f46",
  },
  msgErr: {
    marginTop: 14,
    padding: "12px 14px",
    borderRadius: 16,
    background: "rgba(239,68,68,0.10)",
    border: "2px solid rgba(239,68,68,0.20)",
    fontWeight: 950,
    color: "#7f1d1d",
  },

  userRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  userPill: {
    flex: "1 1 auto",
    display: "flex",
    alignItems: "center",
    gap: 10,
    borderRadius: 999,
    padding: "12px 14px",
    border: "2px solid rgba(0,0,0,0.08)",
    background: "#fafafa",
    fontSize: 20,
    minWidth: 0,
    overflow: "hidden",
  },
  roleBadge: {
    marginLeft: 10,
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 999,
    background: "#111827",
    color: "white",
    fontWeight: 950,
    letterSpacing: 0.6,
    flex: "0 0 auto",
  },
  btnOut: {
    borderRadius: 18,
    padding: "12px 16px",
    border: "2px solid rgba(0,0,0,0.10)",
    background: "white",
    fontWeight: 950,
    fontSize: 18,
    whiteSpace: "nowrap",
    flex: "0 0 auto",
  },

  hr: { height: 1, background: "rgba(0,0,0,0.08)", margin: "14px 0" },
  hrMini: { height: 1, background: "rgba(0,0,0,0.08)", margin: "12px 0" },
  label: { fontSize: 18, fontWeight: 950, color: "#374151", marginTop: 6 },
  sectionTitle: { fontSize: 26, fontWeight: 950, color: "#111827", marginBottom: 8 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  listRow: {
    borderRadius: 18,
    border: "2px solid rgba(0,0,0,0.06)",
    padding: "12px 14px",
    background: "#fbfbfb",
  },
  bottomBar: { display: "flex", gap: 12, marginTop: 14, flexWrap: "wrap" },
  btnSoft: {
    flex: 1,
    minWidth: 180,
    borderRadius: 22,
    padding: "16px 18px",
    fontSize: 18,
    fontWeight: 950,
    border: "2px solid rgba(0,0,0,0.08)",
    background: "#f6f6f6",
  },
  filters: { display: "flex", gap: 12, flexWrap: "wrap" },
  filterCol: { flex: 1, minWidth: 160 },
  filterLabel: { fontWeight: 950, opacity: 0.8, marginBottom: 6 },

  monthBox: {
    borderRadius: 18,
    border: "2px solid rgba(0,0,0,0.06)",
    padding: "12px 14px",
    background: "#fbfbfb",
    marginBottom: 14,
  },
  monthGrid: {
    marginTop: 12,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  monthPill: {
    borderRadius: 16,
    border: "2px solid rgba(0,0,0,0.08)",
    background: "white",
    padding: "10px 12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 15,
    fontWeight: 900,
    cursor: "pointer",
  },
  monthPillActive: {
    borderRadius: 16,
    border: "2px solid rgba(179,0,0,0.40)",
    background: "rgba(179,0,0,0.06)",
    padding: "10px 12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 15,
    fontWeight: 900,
    cursor: "pointer",
  },
  yearGrid: {
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  yearPill: {
    borderRadius: 16,
    border: "2px solid rgba(0,0,0,0.08)",
    background: "white",
    padding: "10px 12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 15,
    fontWeight: 900,
    cursor: "pointer",
  },
  yearPillActive: {
    borderRadius: 16,
    border: "2px solid rgba(17,24,39,0.35)",
    background: "rgba(17,24,39,0.06)",
    padding: "10px 12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 15,
    fontWeight: 900,
    cursor: "pointer",
  },
  selectMini: {
    borderRadius: 14,
    border: "2px solid rgba(0,0,0,0.10)",
    padding: "10px 12px",
    fontSize: 14,
    outline: "none",
    background: "white",
    fontWeight: 800,
  },
  btnMini: {
    borderRadius: 14,
    padding: "10px 12px",
    fontSize: 14,
    fontWeight: 950,
    border: "2px solid rgba(0,0,0,0.10)",
    background: "white",
    cursor: "pointer",
  },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: 12,
    zIndex: 9999,
  },
  modal: {
    width: "100%",
    maxWidth: 560,
    background: "white",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 18px 40px rgba(0,0,0,0.22)",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  modalTitle: { fontSize: 28, fontWeight: 950, color: "#111827" },
  modalClose: {
    borderRadius: 999,
    padding: "10px 14px",
    border: "2px solid rgba(0,0,0,0.10)",
    background: "white",
    fontWeight: 950,
    color: "#2563eb",
  },
};
