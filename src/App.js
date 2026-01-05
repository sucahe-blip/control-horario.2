import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";
import * as XLSX from "xlsx";

/**
 * Control horario - Cañizares S.A.
 *
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
  const [y, m, d] = str.split("-").map((v) => parseInt(v, 10));
  const dt = new Date();
  dt.setFullYear(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

// ISO YYYY-MM-DD -> DD/MM/YYYY (APP)
function fmtFechaDDMMYYYY(iso) {
  if (!iso || typeof iso !== "string" || iso.length < 10) return iso || "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

// ISO YYYY-MM-DD -> DD-MM-YYYY (Excel/CSV)
function fmtFechaDDMMYYYY_DASH(iso) {
  if (!iso || typeof iso !== "string" || iso.length < 10) return iso || "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}-${m}-${y}`;
}

function monthNameEs(idx1to12) {
  const meses = [
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
  return meses[(idx1to12 || 1) - 1] || "Mes";
}

function monthRangeISO(year, month1to12) {
  const y = Number(year);
  const m = Number(month1to12);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0); // último día del mes
  return { desdeISO: toInputDate(start), hastaISO: toInputDate(end) };
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

  // Tramo abierto:
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

// ---------- Excel (.xlsx) ----------
function safeSheetName(name) {
  const s = String(name || "Hoja").trim() || "Hoja";
  // Excel no permite: : \ / ? * [ ]
  const cleaned = s.replace(/[:\\/?*\[\]]/g, "-");
  return cleaned.slice(0, 31) || "Hoja";
}

function downloadXLSX(filename, sheets /* [{name, rows}] */) {
  const wb = XLSX.utils.book_new();
  for (const sh of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows || []);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sh.name));
  }
  XLSX.writeFile(wb, filename);
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

  // Filtros rango
  const [desde, setDesde] = useState(toInputDate(new Date()));
  const [hasta, setHasta] = useState(toInputDate(new Date()));

  // Inspector/admin
  const [empleados, setEmpleados] = useState([]);
  const [empleadoSel, setEmpleadoSel] = useState(""); // empleado_id seleccionado o "" (todos)
  const [registrosInspector, setRegistrosInspector] = useState([]);
  const [cargandoInspector, setCargandoInspector] = useState(false);

  // Resúmenes (histórico)
  const nowY = new Date().getFullYear();
  const [yearSel, setYearSel] = useState(nowY);
  const [monthSel, setMonthSel] = useState(new Date().getMonth() + 1);
  const [registrosYear, setRegistrosYear] = useState([]); // para totales mensuales del año seleccionado
  const [cargandoYear, setCargandoYear] = useState(false);

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

  // Histórico usuario (rango)
  useEffect(() => {
    async function cargarRangoUsuario() {
      setRegistrosRango([]);
      if (tab !== "historico") return;
      if (!perfil?.empleado_id) return;

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
  }, [tab, perfil?.empleado_id, desde, hasta]);

  // Inspector/admin: cargar empleados
  useEffect(() => {
    async function cargarEmpleados() {
      setEmpleados([]);
      if (!session?.user?.id) return;
      if (!(isInspector || isAdmin)) return;

      const { data, error } = await supabase
        .from("empleados")
        .select("*")
        .order("nombre", { ascending: true });

      if (error) {
        setMsg({ type: "err", text: `Error cargando empleados: ${error.message}` });
        return;
      }
      setEmpleados(data || []);
    }

    cargarEmpleados();
  }, [session?.user?.id, isInspector, isAdmin]);

  // Inspector/admin: buscar registros rango + empleado
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

  // Año seleccionado: cargar registros del año para totales mensuales/anual
  useEffect(() => {
    async function cargarYear() {
      if (tab !== "historico") return;
      if (!session?.user?.id) return;

      const y = Number(yearSel);
      if (!y || Number.isNaN(y)) return;

      const desdeISO = `${y}-01-01`;
      const hastaISO = `${y}-12-31`;

      setCargandoYear(true);
      setRegistrosYear([]);

      let q = supabase
        .from("registros")
        .select("*")
        .gte("fecha", desdeISO)
        .lte("fecha", hastaISO);

      // Admin/Inspector: si (Todos) => todos, si no => filtro por empleadoSel
      // Empleado normal: solo los suyos
      if (isAdmin || isInspector) {
        if (empleadoSel) q = q.eq("empleado_id", empleadoSel);
      } else {
        if (perfil?.empleado_id) q = q.eq("empleado_id", perfil.empleado_id);
        else {
          setCargandoYear(false);
          return;
        }
      }

      // Orden no es obligatorio para totales, pero ayuda para exportes
      q = q.order("fecha", { ascending: true }).order("entrada", { ascending: true });

      const { data, error } = await q;
      setCargandoYear(false);

      if (error) {
        setMsg({ type: "err", text: `Error cargando año: ${error.message}` });
        return;
      }
      setRegistrosYear(data || []);
    }

    cargarYear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, yearSel, empleadoSel, isAdmin, isInspector, perfil?.empleado_id, session?.user?.id]);

  const estadoHoy = useMemo(() => calcularEstadoHoy(registrosHoy), [registrosHoy]);

  // Totales
  const totalHoySeg = useMemo(
    () => (registrosHoy || []).reduce((acc, r) => acc + tramoSegundos(r), 0),
    [registrosHoy]
  );

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

  // Resumen anual del año seleccionado
  const totalYearSeg = useMemo(
    () => (registrosYear || []).reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0),
    [registrosYear]
  );

  // Totales por mes (año seleccionado)
  const totalsByMonthSeg = useMemo(() => {
    const arr = Array.from({ length: 12 }, () => 0);
    for (const r of registrosYear || []) {
      const f = String(r.fecha || "");
      // f = YYYY-MM-DD
      const parts = f.split("-");
      if (parts.length >= 2) {
        const m = parseInt(parts[1], 10);
        if (m >= 1 && m <= 12) arr[m - 1] += tramoSegundos(r, { contarAbiertosHoyHastaAhora: false });
      }
    }
    return arr;
  }, [registrosYear]);

  // Años (selector) — si no hay datos, igualmente mostramos un rango razonable
  const yearsOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return [y + 1, y, y - 1, y - 2].filter((x, i, a) => a.indexOf(x) === i);
  }, []);

  // --------- Jornada partida ---------
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

  // Nombre visible
  const nombreVisible = useMemo(() => {
    const n = (empleado?.nombre || "").trim();
    return n || "(Sin nombre)";
  }, [empleado?.nombre]);

  // UI helpers
  const fechaLarga = useMemo(() => fmtFechaLarga(ahora), [ahora]);
  const horaGrande = useMemo(() => fmtHora(ahora), [ahora]);

  const s = styles;
  const haySesion = !!session?.user?.id;
  const showHeaderNav = haySesion;

  // --------- Acciones: click mes (autocompletar rango) ---------
  function onClickMes(m1to12) {
    const y = Number(yearSel);
    const { desdeISO, hastaISO } = monthRangeISO(y, m1to12);
    setMonthSel(m1to12);
    setDesde(desdeISO);
    setHasta(hastaISO);
    // si eres admin/inspector, normalmente querrás “Buscar” igualmente
    setMsg({ type: "ok", text: `Rango rellenado: ${monthNameEs(m1to12)} ${y}` });
  }

  // --------- Exportes Excel (.xlsx) ---------
  async function exportarInformeMensualXLSX() {
    try {
      setMsg(null);
      const y = Number(yearSel);
      const m = Number(monthSel);
      if (!y || !m) return;

      const { desdeISO, hastaISO } = monthRangeISO(y, m);

      // Preparamos los registros a exportar
      let registros = [];
      let empleadosMap = new Map((empleados || []).map((e) => [e.id, e]));

      // Si admin/inspector y (Todos): exportar por pestañas
      if ((isAdmin || isInspector) && !empleadoSel) {
        // aseguramos lista de empleados
        if (!empleados?.length) {
          const { data: emps } = await supabase.from("empleados").select("*").order("nombre", { ascending: true });
          empleadosMap = new Map((emps || []).map((e) => [e.id, e]));
        }

        const { data, error } = await supabase
          .from("registros")
          .select("*")
          .gte("fecha", desdeISO)
          .lte("fecha", hastaISO)
          .order("fecha", { ascending: true })
          .order("entrada", { ascending: true });

        if (error) {
          setMsg({ type: "err", text: `Error exportando: ${error.message}` });
          return;
        }
        registros = data || [];

        // Agrupar por empleado
        const byEmp = new Map();
        for (const r of registros) {
          const k = r.empleado_id || "Sin empleado";
          if (!byEmp.has(k)) byEmp.set(k, []);
          byEmp.get(k).push(r);
        }

        const sheets = [];
        // Hoja resumen
        const resumenRows = [
          [`Informe mensual`, `${monthNameEs(m)} ${y}`],
          [`Rango`, `${fmtFechaDDMMYYYY_DASH(desdeISO)} a ${fmtFechaDDMMYYYY_DASH(hastaISO)}`],
          [``, ``],
          [`Empleado`, `Total mes (HH:MM)`],
        ];

        for (const [empId, items] of byEmp.entries()) {
          const total = items.reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0);
          const emp = empleadosMap.get(empId);
          resumenRows.push([emp?.nombre || empId, secondsToHHMM(total)]);
        }

        sheets.push({ name: `Resumen ${monthNameEs(m)}`, rows: resumenRows });

        // Hojas por empleado
        for (const [empId, items] of byEmp.entries()) {
          const emp = empleadosMap.get(empId);
          const empName = emp?.nombre || empId;

          const rows = [
            [`Empleado`, empName],
            [`Mes`, `${monthNameEs(m)} ${y}`],
            [``, ``],
            [`Fecha`, `Entrada`, `Salida`, `Duración (HH:MM)`, `Tipo`, `Nota`],
            ...items.map((r) => [
              fmtFechaDDMMYYYY_DASH(r.fecha),
              r.entrada || "",
              r.salida || "",
              secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
              tipoBonito(r.tipo),
              r.nota || "",
            ]),
          ];

          sheets.push({ name: empName, rows });
        }

        downloadXLSX(`informe_mensual_${y}_${pad2(m)}.xlsx`, sheets);
        setMsg({ type: "ok", text: "Informe mensual (Excel) descargado ✅" });
        return;
      }

      // Si no (Todos), exporta solo el empleado seleccionado / usuario
      let q = supabase
        .from("registros")
        .select("*")
        .gte("fecha", desdeISO)
        .lte("fecha", hastaISO)
        .order("fecha", { ascending: true })
        .order("entrada", { ascending: true });

      if (isAdmin || isInspector) {
        if (empleadoSel) q = q.eq("empleado_id", empleadoSel);
      } else {
        q = q.eq("empleado_id", perfil?.empleado_id);
      }

      const { data, error } = await q;
      if (error) {
        setMsg({ type: "err", text: `Error exportando: ${error.message}` });
        return;
      }

      const items = data || [];
      const total = items.reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0);

      const empName =
        (isAdmin || isInspector) && empleadoSel
          ? empleados.find((x) => x.id === empleadoSel)?.nombre || "Empleado"
          : nombreVisible;

      const rows = [
        [`Informe mensual`, `${monthNameEs(m)} ${y}`],
        [`Empleado`, empName],
        [`Rango`, `${fmtFechaDDMMYYYY_DASH(desdeISO)} a ${fmtFechaDDMMYYYY_DASH(hastaISO)}`],
        [`Total mes`, secondsToHHMM(total)],
        [``, ``],
        [`Fecha`, `Entrada`, `Salida`, `Duración (HH:MM)`, `Tipo`, `Nota`],
        ...items.map((r) => [
          fmtFechaDDMMYYYY_DASH(r.fecha),
          r.entrada || "",
          r.salida || "",
          secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
          tipoBonito(r.tipo),
          r.nota || "",
        ]),
      ];

      downloadXLSX(`informe_mensual_${y}_${pad2(m)}.xlsx`, [{ name: `Mes ${monthNameEs(m)}`, rows }]);
      setMsg({ type: "ok", text: "Informe mensual (Excel) descargado ✅" });
    } catch (e) {
      setMsg({ type: "err", text: `Error exportando Excel: ${e?.message || String(e)}` });
    }
  }

  async function exportarInformeAnualXLSX() {
    try {
      setMsg(null);
      const y = Number(yearSel);
      if (!y) return;

      const desdeISO = `${y}-01-01`;
      const hastaISO = `${y}-12-31`;

      // Admin/inspector y (Todos): por pestañas
      if ((isAdmin || isInspector) && !empleadoSel) {
        let empleadosMap = new Map((empleados || []).map((e) => [e.id, e]));
        if (!empleados?.length) {
          const { data: emps } = await supabase.from("empleados").select("*").order("nombre", { ascending: true });
          empleadosMap = new Map((emps || []).map((e) => [e.id, e]));
        }

        const { data, error } = await supabase
          .from("registros")
          .select("*")
          .gte("fecha", desdeISO)
          .lte("fecha", hastaISO)
          .order("fecha", { ascending: true })
          .order("entrada", { ascending: true });

        if (error) {
          setMsg({ type: "err", text: `Error exportando: ${error.message}` });
          return;
        }
        const registros = data || [];

        const byEmp = new Map();
        for (const r of registros) {
          const k = r.empleado_id || "Sin empleado";
          if (!byEmp.has(k)) byEmp.set(k, []);
          byEmp.get(k).push(r);
        }

        // Hoja resumen anual por empleado
        const resumenRows = [
          [`Informe anual`, String(y)],
          [`Rango`, `${fmtFechaDDMMYYYY_DASH(desdeISO)} a ${fmtFechaDDMMYYYY_DASH(hastaISO)}`],
          [``, ``],
          [`Empleado`, `Total año (HH:MM)`],
        ];

        for (const [empId, items] of byEmp.entries()) {
          const total = items.reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0);
          const emp = empleadosMap.get(empId);
          resumenRows.push([emp?.nombre || empId, secondsToHHMM(total)]);
        }

        const sheets = [{ name: `Resumen ${y}`, rows: resumenRows }];

        // hojas por empleado
        for (const [empId, items] of byEmp.entries()) {
          const emp = empleadosMap.get(empId);
          const empName = emp?.nombre || empId;

          // Totales por mes para ese empleado
          const monthTotals = Array.from({ length: 12 }, () => 0);
          for (const r of items) {
            const parts = String(r.fecha || "").split("-");
            if (parts.length >= 2) {
              const m = parseInt(parts[1], 10);
              if (m >= 1 && m <= 12) monthTotals[m - 1] += tramoSegundos(r, { contarAbiertosHoyHastaAhora: false });
            }
          }

          const rows = [
            [`Empleado`, empName],
            [`Año`, String(y)],
            [``, ``],
            [`Mes`, `Total (HH:MM)`],
            ...monthTotals.map((seg, idx) => [monthNameEs(idx + 1), secondsToHHMM(seg)]),
            [``, ``],
            [`Detalle`],
            [`Fecha`, `Entrada`, `Salida`, `Duración (HH:MM)`, `Tipo`, `Nota`],
            ...items.map((r) => [
              fmtFechaDDMMYYYY_DASH(r.fecha),
              r.entrada || "",
              r.salida || "",
              secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
              tipoBonito(r.tipo),
              r.nota || "",
            ]),
          ];

          sheets.push({ name: empName, rows });
        }

        downloadXLSX(`informe_anual_${y}.xlsx`, sheets);
        setMsg({ type: "ok", text: "Informe anual (Excel) descargado ✅" });
        return;
      }

      // No (Todos): anual de un empleado (seleccionado o actual)
      let q = supabase
        .from("registros")
        .select("*")
        .gte("fecha", desdeISO)
        .lte("fecha", hastaISO)
        .order("fecha", { ascending: true })
        .order("entrada", { ascending: true });

      if (isAdmin || isInspector) {
        if (empleadoSel) q = q.eq("empleado_id", empleadoSel);
      } else {
        q = q.eq("empleado_id", perfil?.empleado_id);
      }

      const { data, error } = await q;
      if (error) {
        setMsg({ type: "err", text: `Error exportando: ${error.message}` });
        return;
      }

      const items = data || [];
      const total = items.reduce((acc, r) => acc + tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }), 0);

      const monthTotals = Array.from({ length: 12 }, () => 0);
      for (const r of items) {
        const parts = String(r.fecha || "").split("-");
        if (parts.length >= 2) {
          const m = parseInt(parts[1], 10);
          if (m >= 1 && m <= 12) monthTotals[m - 1] += tramoSegundos(r, { contarAbiertosHoyHastaAhora: false });
        }
      }

      const empName =
        (isAdmin || isInspector) && empleadoSel
          ? empleados.find((x) => x.id === empleadoSel)?.nombre || "Empleado"
          : nombreVisible;

      const rowsResumen = [
        [`Informe anual`, String(y)],
        [`Empleado`, empName],
        [`Rango`, `${fmtFechaDDMMYYYY_DASH(desdeISO)} a ${fmtFechaDDMMYYYY_DASH(hastaISO)}`],
        [`Total año`, secondsToHHMM(total)],
        [``, ``],
        [`Mes`, `Total (HH:MM)`],
        ...monthTotals.map((seg, idx) => [monthNameEs(idx + 1), secondsToHHMM(seg)]),
      ];

      const rowsDetalle = [
        [`Detalle`],
        [`Fecha`, `Entrada`, `Salida`, `Duración (HH:MM)`, `Tipo`, `Nota`],
        ...items.map((r) => [
          fmtFechaDDMMYYYY_DASH(r.fecha),
          r.entrada || "",
          r.salida || "",
          secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false })),
          tipoBonito(r.tipo),
          r.nota || "",
        ]),
      ];

      downloadXLSX(`informe_anual_${y}.xlsx`, [
        { name: `Resumen ${y}`, rows: rowsResumen },
        { name: `Detalle ${y}`, rows: rowsDetalle },
      ]);
      setMsg({ type: "ok", text: "Informe anual (Excel) descargado ✅" });
    } catch (e) {
      setMsg({ type: "err", text: `Error exportando Excel: ${e?.message || String(e)}` });
    }
  }

  // --------- UI ---------
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
                  <div style={{ fontSize: 13, opacity: 0.75, fontWeight: 700 }}>Ej.: motivo de ausencia, detalle del día, etc.</div>

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

                  {/* ADMIN/INSPECTOR: selector empleado arriba para que afecte a todo */}
                  {(isInspector || isAdmin) && (
                    <div style={{ marginTop: 6 }}>
                      <div style={s.filterLabel}>Empleado</div>
                      <select style={s.select} value={empleadoSel} onChange={(e) => setEmpleadoSel(e.target.value)}>
                        <option value="">(Todos)</option>
                        {empleados.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.nombre || emp.id}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* INFORME ANUAL + SELECTOR AÑO */}
                  <div style={{ marginTop: 14, ...s.listRow }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                      <div style={{ fontWeight: 950, fontSize: 18 }}>Informe anual</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ fontWeight: 900, opacity: 0.85 }}>Año</div>
                        <select
                          style={{ ...s.select, marginTop: 0, width: 140 }}
                          value={yearSel}
                          onChange={(e) => setYearSel(Number(e.target.value))}
                        >
                          {yearsOptions.map((y) => (
                            <option key={y} value={y}>
                              {y}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <div
                        style={{
                          flex: "1 1 220px",
                          borderRadius: 16,
                          padding: "12px 14px",
                          border: "2px solid rgba(0,0,0,0.10)",
                          background: "#f7f7f7",
                        }}
                      >
                        <div style={{ fontWeight: 950, display: "flex", justifyContent: "space-between" }}>
                          <span>{yearSel}</span>
                          <span>{secondsToHHMM(totalYearSeg)}</span>
                        </div>
                        <div style={{ marginTop: 6, opacity: 0.8, fontWeight: 800 }}>
                          {cargandoYear ? "Cargando..." : `Año seleccionado (${yearSel}) — Total: ${secondsToHHMM(totalYearSeg)}`}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                      <button style={s.btnMainSmall} onClick={exportarInformeAnualXLSX}>
                        Informe anual (Excel)
                      </button>
                    </div>
                  </div>

                  {/* INFORME MENSUAL: selector mes + export */}
                  <div style={{ marginTop: 14, ...s.listRow }}>
                    <div style={{ fontWeight: 950, fontSize: 18, marginBottom: 10 }}>Informe mensual</div>

                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 950, opacity: 0.85 }}>Selector mes</div>
                      <select
                        style={{ ...s.select, marginTop: 0, width: 220 }}
                        value={monthSel}
                        onChange={(e) => {
                          const m = Number(e.target.value);
                          setMonthSel(m);
                          // también rellena rango para ese mes
                          onClickMes(m);
                        }}
                      >
                        {Array.from({ length: 12 }).map((_, idx) => (
                          <option key={idx + 1} value={idx + 1}>
                            {monthNameEs(idx + 1)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                      <button style={s.btnMainSmall} onClick={exportarInformeMensualXLSX}>
                        Informe mensual (Excel)
                      </button>
                    </div>

                    <div style={{ marginTop: 14, fontWeight: 950 }}>Totales mensuales ({yearSel})</div>
                    <div style={{ fontSize: 13, opacity: 0.75, fontWeight: 800, marginTop: 4 }}>
                      Tip: pincha un mes para rellenar Desde y Hasta con ese mes.
                    </div>

                    <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {Array.from({ length: 12 }).map((_, idx) => {
                        const m = idx + 1;
                        const seg = totalsByMonthSeg[idx] || 0;
                        const active = monthSel === m;
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => onClickMes(m)}
                            style={{
                              borderRadius: 16,
                              border: active ? "2px solid rgba(17,24,39,0.55)" : "2px solid rgba(0,0,0,0.08)",
                              background: active ? "rgba(17,24,39,0.06)" : "#fff",
                              padding: "12px 14px",
                              textAlign: "left",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              fontWeight: 950,
                            }}
                          >
                            <span>{monthNameEs(m)}</span>
                            <span style={{ opacity: 0.85 }}>{secondsToHHMM(seg)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* RANGO + RESULTADOS */}
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
                      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                        <button style={s.btnMainSmall} onClick={cargarInspector} disabled={cargandoInspector}>
                          {cargandoInspector ? "Cargando..." : "Buscar"}
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
                            <div key={d.fecha} stylel style={s.listRow}>
                              <div style={{ fontWeight: 950, marginBottom: 6 }}>
                                {fmtFechaDDMMYYYY(d.fecha)} — Total día: {secondsToHHMM(d.totalSeg)}
                              </div>

                              {d.items
                                .slice()
                                .sort((a, b) => (a.entrada < b.entrada ? 1 : -1))
                                .map((r) => {
                                  const emp = empleados.find((x) => x.id === r.empleado_id);
                                  return (
                                    <div
                                      key={r.id}
                                      style={{ padding: "6px 0", borderTop: "1px solid rgba(0,0,0,0.06)" }}
                                    >
                                      <div style={{ fontWeight: 950 }}>{emp?.nombre || r.empleado_id}</div>
                                      <div style={{ opacity: 0.85, fontWeight: 800 }}>
                                        {r.entrada || "--:--:--"} → {r.salida || "--:--:--"} ({" "}
                                        {secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }))} )
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
                                  <div
                                    key={r.id}
                                    style={{ padding: "6px 0", borderTop: "1px solid rgba(0,0,0,0.06)" }}
                                  >
                                    <div style={{ opacity: 0.85, fontWeight: 800 }}>
                                      {r.entrada || "--:--:--"} → {r.salida || "--:--:--"} ({" "}
                                      {secondsToHHMM(tramoSegundos(r, { contarAbiertosHoyHastaAhora: false }))} )
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
              Gestión del control horario y registro de jornada laboral (entradas y salidas), incluyendo notas asociadas al fichaje
              cuando el usuario las añada.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Base legal</div>
            <div>Cumplimiento de obligaciones legales en materia laboral y gestión de la relación laboral.</div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Conservación</div>
            <div>
              Los registros se conservarán durante el tiempo legalmente exigible y el necesario para atender posibles responsabilidades.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Derechos</div>
            <div>Puedes solicitar acceso, rectificación, supresión, oposición o limitación escribiendo a {EMPRESA.email}.</div>
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

  // Modal
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
