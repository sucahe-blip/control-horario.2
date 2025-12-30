import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";

/**
 * App Control Horario (Cañizares) — ESQUEMA ACTUAL (según captura):
 * public.registros:
 *   id uuid
 *   empleado_id uuid
 *   fecha date
 *   tipo text            (ej: "Trabajo", "Pausa")
 *   entrada time
 *   salida time
 *   (opcional) nota text
 *
 * public.usuarios (según lo que veníamos usando):
 *   user_id uuid
 *   empleado_id uuid
 *   rol text (empleado/admin/inspector) o es_admin/es_inspector
 *
 * public.empleados:
 *   id uuid
 *   nombre text
 *   apellidos text
 *   email text (opcional)
 */

const EMPRESA = {
  nombre: "Cañizares, Instalaciones y Proyectos, S.A.",
  cif: "A78593316",
  direccion: "Calle Islas Cíes 35, 28035 Madrid",
  email: "canizares@jcanizares.com",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtHora(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtFechaLarga(d) {
  const dias = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const meses = [
    "enero","febrero","marzo","abril","mayo","junio",
    "julio","agosto","septiembre","octubre","noviembre","diciembre",
  ];
  return `Hoy, ${dias[d.getDay()]}, ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function toInputDate(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

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

// HH:MM:SS (time) a string legible (en caso de null)
function timePretty(t) {
  if (!t) return "-";
  return String(t).slice(0, 8);
}

function calcularEstadoHoy(rowsHoy) {
  // Con tu esquema:
  // - Si hay una fila tipo "Pausa" con salida null => Pausa
  // - Si hay una fila tipo "Trabajo" con salida null => Dentro
  // - Si no, Fuera
  const abiertasPausa = (rowsHoy || []).find((r) => (r.tipo || "").toLowerCase() === "pausa" && !r.salida);
  if (abiertasPausa) return { estado: "Pausa", abiertoTrabajo: true, abiertoPausa: true };

  const abiertaTrabajo = (rowsHoy || []).find((r) => (r.tipo || "").toLowerCase() !== "pausa" && !r.salida);
  if (abiertaTrabajo) return { estado: "Dentro", abiertoTrabajo: true, abiertoPausa: false };

  return { estado: "Fuera", abiertoTrabajo: false, abiertoPausa: false };
}

export default function App() {
  const [ahora, setAhora] = useState(new Date());

  // Auth/UI
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState(null); // {type:'ok'|'err', text:''}

  // Perfil/roles
  const [perfil, setPerfil] = useState(null); // usuarios row
  const [empleado, setEmpleado] = useState(null); // empleados row
  const [rol, setRol] = useState("empleado"); // empleado | admin | inspector
  const isInspector = rol === "inspector";
  const isAdmin = rol === "admin";

  // Tabs
  const [tab, setTab] = useState("inicio"); // inicio | historico

  // Registros
  const [registrosHoy, setRegistrosHoy] = useState([]);
  const [registrosRango, setRegistrosRango] = useState([]);

  // Nota (si existe columna)
  const [nota, setNota] = useState("");

  // Filtros rango
  const [desde, setDesde] = useState(toInputDate(new Date()));
  const [hasta, setHasta] = useState(toInputDate(new Date()));

  // Inspector/admin
  const [empleados, setEmpleados] = useState([]);
  const [empleadoSel, setEmpleadoSel] = useState(""); // empleado_id o "" (todos)
  const [registrosInspector, setRegistrosInspector] = useState([]);
  const [cargandoInspector, setCargandoInspector] = useState(false);

  // Modales
  const [showPrivacidad, setShowPrivacidad] = useState(false);
  const [showRecover, setShowRecover] = useState(false);

  // Recovery mode
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPass1, setNewPass1] = useState("");
  const [newPass2, setNewPass2] = useState("");

  // Tick reloj
  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Detectar si vienes de un link de reset (Supabase)
  useEffect(() => {
    const hash = window.location.hash || "";
    const isRecovery =
      hash.includes("type=recovery") ||
      hash.includes("access_token=") ||
      hash.includes("code=");
    if (isRecovery) setRecoveryMode(true);
  }, []);

  // Cargar sesión + listener
  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(data.session || null);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((evt, newSession) => {
      setSession(newSession || null);
      if (evt === "PASSWORD_RECOVERY") setRecoveryMode(true);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // Cargar perfil cuando hay sesión
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
        if (e2) {
          setMsg({ type: "err", text: `Error cargando empleado: ${e2.message}` });
        } else {
          setEmpleado(emp || null);
        }
      }
    }

    cargarPerfil();
  }, [session?.user?.id]);

  const hoyStr = useMemo(() => toInputDate(new Date()), []);

  // Cargar registros de HOY (por fecha = YYYY-MM-DD)
  useEffect(() => {
    async function cargarHoy() {
      setRegistrosHoy([]);
      if (!session?.user?.id || !perfil?.empleado_id) return;

      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", perfil.empleado_id)
        .eq("fecha", hoyStr)
        .order("entrada", { ascending: false })
        .order("id", { ascending: false });

      if (error) {
        setMsg({ type: "err", text: `Error cargando registros de hoy: ${error.message}` });
        return;
      }
      setRegistrosHoy(data || []);
    }

    cargarHoy();
  }, [session?.user?.id, perfil?.empleado_id, hoyStr]);

  // Histórico rango (usuario)
  useEffect(() => {
    async function cargarRangoUsuario() {
      setRegistrosRango([]);
      if (tab !== "historico") return;
      if (!session?.user?.id || !perfil?.empleado_id) return;

      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", perfil.empleado_id)
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .order("fecha", { ascending: false })
        .order("entrada", { ascending: false });

      if (error) {
        setMsg({ type: "err", text: `Error cargando histórico: ${error.message}` });
        return;
      }
      setRegistrosRango(data || []);
    }

    cargarRangoUsuario();
  }, [tab, session?.user?.id, perfil?.empleado_id, desde, hasta]);

  // Inspector/admin: cargar lista empleados
  useEffect(() => {
    async function cargarEmpleados() {
      setEmpleados([]);
      if (!session?.user?.id) return;
      if (!(isInspector || isAdmin)) return;

      const { data, error } = await supabase
        .from("empleados")
        .select("*")
        .order("apellidos", { ascending: true })
        .order("nombre", { ascending: true });

      if (error) {
        setMsg({ type: "err", text: `Error cargando empleados: ${error.message}` });
        return;
      }
      setEmpleados(data || []);
    }

    cargarEmpleados();
  }, [session?.user?.id, isInspector, isAdmin]);

  // Inspector/admin: cargar registros
  async function cargarInspector() {
    if (!(isInspector || isAdmin)) return;
    setCargandoInspector(true);
    setRegistrosInspector([]);

    let q = supabase
      .from("registros")
      .select("*")
      .gte("fecha", desde)
      .lte("fecha", hasta)
      .order("fecha", { ascending: false })
      .order("entrada", { ascending: false });

    if (empleadoSel) q = q.eq("empleado_id", empleadoSel);

    const { data, error } = await q;

    setCargandoInspector(false);

    if (error) {
      setMsg({ type: "err", text: `Error cargando registros (inspector): ${error.message}` });
      return;
    }
    setRegistrosInspector(data || []);
  }

  const estadoHoy = useMemo(() => calcularEstadoHoy(registrosHoy), [registrosHoy]);

  // Detectar si existe columna nota (por si no está)
  const notaDisponible = useMemo(() => {
    if (!registrosHoy?.length && !registrosRango?.length && !registrosInspector?.length) return true; // asumimos sí
    const sample = registrosHoy?.[0] || registrosRango?.[0] || registrosInspector?.[0];
    return sample ? Object.prototype.hasOwnProperty.call(sample, "nota") : true;
  }, [registrosHoy, registrosRango, registrosInspector]);

  // --- FICHAJES adaptados a tu esquema ---

  async function iniciarJornada() {
    setMsg(null);
    if (!session?.user?.id || !perfil?.empleado_id) return setMsg({ type: "err", text: "No hay sesión activa." });
    if (estadoHoy.abiertoTrabajo) return setMsg({ type: "err", text: "No puedes iniciar: ya estás dentro." });

    const payload = {
      empleado_id: perfil.empleado_id,
      fecha: hoyStr,
      tipo: "Trabajo",
      entrada: fmtHora(new Date()),
      salida: null,
    };
    if (notaDisponible) payload.nota = (nota || "").trim() || null;

    const { error } = await supabase.from("registros").insert(payload);
    if (error) return setMsg({ type: "err", text: `Error iniciando jornada: ${error.message}` });

    setNota("");
    setMsg({ type: "ok", text: "OK ✅" });
    await refrescarHoy();
  }

  async function finalizarJornada() {
    setMsg(null);
    if (!session?.user?.id || !perfil?.empleado_id) return setMsg({ type: "err", text: "No hay sesión activa." });
    if (!estadoHoy.abiertoTrabajo) return setMsg({ type: "err", text: "No puedes finalizar: ya estás fuera." });
    if (estadoHoy.abiertoPausa) return setMsg({ type: "err", text: "Cierra la pausa antes de finalizar." });

    // Buscar última fila Trabajo abierta (salida null)
    const { data: open, error: e1 } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .eq("fecha", hoyStr)
      .neq("tipo", "Pausa")
      .is("salida", null)
      .order("entrada", { ascending: false })
      .limit(1);

    if (e1) return setMsg({ type: "err", text: `Error buscando jornada abierta: ${e1.message}` });
    const row = open?.[0];
    if (!row) return setMsg({ type: "err", text: "No se encontró una jornada abierta." });

    const upd = { salida: fmtHora(new Date()) };
    if (notaDisponible && (nota || "").trim()) upd.nota = (nota || "").trim();

    const { error: e2 } = await supabase.from("registros").update(upd).eq("id", row.id);
    if (e2) return setMsg({ type: "err", text: `Error finalizando jornada: ${e2.message}` });

    setNota("");
    setMsg({ type: "ok", text: "OK ✅" });
    await refrescarHoy();
  }

  async function iniciarPausa() {
    setMsg(null);
    if (!session?.user?.id || !perfil?.empleado_id) return setMsg({ type: "err", text: "No hay sesión activa." });
    if (!estadoHoy.abiertoTrabajo) return setMsg({ type: "err", text: "No puedes pausar: estás fuera." });
    if (estadoHoy.abiertoPausa) return setMsg({ type: "err", text: "Ya tienes una pausa abierta." });

    const payload = {
      empleado_id: perfil.empleado_id,
      fecha: hoyStr,
      tipo: "Pausa",
      entrada: fmtHora(new Date()),
      salida: null,
    };
    if (notaDisponible) payload.nota = (nota || "").trim() || null;

    const { error } = await supabase.from("registros").insert(payload);
    if (error) return setMsg({ type: "err", text: `Error iniciando pausa: ${error.message}` });

    setNota("");
    setMsg({ type: "ok", text: "OK ✅" });
    await refrescarHoy();
  }

  async function finalizarPausa() {
    setMsg(null);
    if (!session?.user?.id || !perfil?.empleado_id) return setMsg({ type: "err", text: "No hay sesión activa." });
    if (!estadoHoy.abiertoPausa) return setMsg({ type: "err", text: "No hay pausa abierta." });

    const { data: open, error: e1 } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .eq("fecha", hoyStr)
      .eq("tipo", "Pausa")
      .is("salida", null)
      .order("entrada", { ascending: false })
      .limit(1);

    if (e1) return setMsg({ type: "err", text: `Error buscando pausa abierta: ${e1.message}` });
    const row = open?.[0];
    if (!row) return setMsg({ type: "err", text: "No se encontró una pausa abierta." });

    const upd = { salida: fmtHora(new Date()) };
    if (notaDisponible && (nota || "").trim()) upd.nota = (nota || "").trim();

    const { error: e2 } = await supabase.from("registros").update(upd).eq("id", row.id);
    if (e2) return setMsg({ type: "err", text: `Error finalizando pausa: ${e2.message}` });

    setNota("");
    setMsg({ type: "ok", text: "OK ✅" });
    await refrescarHoy();
  }

  async function refrescarHoy() {
    const { data, error } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .eq("fecha", hoyStr)
      .order("entrada", { ascending: false })
      .order("id", { ascending: false });

    if (error) {
      setMsg({ type: "err", text: `Error refrescando hoy: ${error.message}` });
      return;
    }
    setRegistrosHoy(data || []);
  }

  // Login / Logout
  async function entrar(e) {
    e?.preventDefault?.();
    setMsg(null);

    const { error } = await supabase.auth.signInWithPassword({
      email: (email || "").trim(),
      password: pass || "",
    });

    if (error) return setMsg({ type: "err", text: error.message });

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

  // Recuperar contraseña
  async function enviarRecuperacion() {
    setMsg(null);
    const em = (email || "").trim();
    if (!em) return setMsg({ type: "err", text: "Escribe tu email primero." });

    const { error } = await supabase.auth.resetPasswordForEmail(em, {
      redirectTo: window.location.origin,
    });

    if (error) return setMsg({ type: "err", text: error.message });

    setMsg({ type: "ok", text: "Te hemos enviado un email para restablecer la contraseña." });
  }

  // Reset password
  async function guardarNuevaPass() {
    setMsg(null);
    if (!newPass1 || newPass1.length < 6) return setMsg({ type: "err", text: "Mínimo 6 caracteres." });
    if (newPass1 !== newPass2) return setMsg({ type: "err", text: "Las contraseñas no coinciden." });

    const { error } = await supabase.auth.updateUser({ password: newPass1 });
    if (error) return setMsg({ type: "err", text: error.message });

    setRecoveryMode(false);
    setNewPass1("");
    setNewPass2("");
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    setMsg({ type: "ok", text: "Contraseña actualizada ✅" });
  }

  async function cerrarRecoverySinGuardar() {
    // CLAVE: si cierras sin guardar, fuera sesión
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
    const n = [empleado?.nombre, empleado?.apellidos].filter(Boolean).join(" ").trim();
    return n || "(Sin nombre)";
  }, [empleado?.nombre, empleado?.apellidos]);

  const fechaLarga = useMemo(() => fmtFechaLarga(ahora), [ahora]);
  const horaGrande = useMemo(() => fmtHora(ahora), [ahora]);

  const haySesion = !!session?.user?.id;
  const showHeaderNav = haySesion;

  const s = styles;

  return (
    <div style={s.pagina}>
      <div style={s.shell}>
        {/* HEADER ROJO */}
        <div style={s.header}>
          <div style={s.headerTop}>
            <div style={s.marca}>
              <div style={s.nombreMarca}>Cañizares S.A.</div>
              <div style={s.brandSub}>Control horario</div>
            </div>
            <div style={s.datePill}>{fechaLarga}</div>
          </div>

          <div style={s.reloj}>
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
                      background:
                        estadoHoy.estado === "Dentro"
                          ? "#7CFC00"
                          : estadoHoy.estado === "Pausa"
                          ? "#FFD700"
                          : "#d9d9d9",
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

        {/* TARJETA */}
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

              <button style={s.btnMain} type="submit">
                Entrar
              </button>

              <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <button type="button" style={s.linkBtn} onClick={() => { setShowRecover(true); setMsg(null); }}>
                  ¿Has olvidado la contraseña?
                </button>

                <button type="button" style={s.linkBtn} onClick={() => { setShowPrivacidad(true); setMsg(null); }}>
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
                  <span style={{ fontWeight: 900 }}>{nombreVisible}</span>
                  {(isInspector || isAdmin) && (
                    <span style={s.roleBadge}>{isAdmin ? "ADMIN" : "INSPECCIÓN"}</span>
                  )}
                </div>
                <button style={s.btnOut} onClick={salir}>Salir</button>
              </div>

              <div style={s.hr} />

              {tab === "inicio" && (
                <>
                  <div style={s.label}>Nota</div>
                  <input
                    style={s.input}
                    placeholder="(Opcional) Se guardará en el próximo fichaje"
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

                  {registrosHoy.length === 0 ? (
                    <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin registros hoy)</div>
                  ) : (
                    <div style={s.list}>
                      {registrosHoy.slice(0, 20).map((r) => (
                        <div key={r.id} style={s.listRow}>
                          <div style={{ fontWeight: 950 }}>{r.tipo || "-"}</div>
                          <div style={{ opacity: 0.85, fontWeight: 800 }}>
                            {r.fecha} — {timePretty(r.entrada)} → {timePretty(r.salida)}
                          </div>
                          {"nota" in r && (
                            <div style={{ opacity: 0.85 }}>
                              <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                            </div>
                          )}
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

                  <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                    <button
                      style={s.btnSoftSmall}
                      onClick={iniciarPausa}
                      disabled={!estadoHoy.abiertoTrabajo || estadoHoy.abiertoPausa}
                    >
                      Iniciar pausa
                    </button>
                    <button
                      style={s.btnSoftSmall}
                      onClick={finalizarPausa}
                      disabled={!estadoHoy.abiertoTrabajo || !estadoHoy.abiertoPausa}
                    >
                      Finalizar pausa
                    </button>
                  </div>
                </>
              )}

              {tab === "historico" && (
                <>
                  <div style={s.sectionTitle}>Histórico</div>

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
                        {empleados.map((emp) => {
                          const label = `${emp.apellidos || ""} ${emp.nombre || ""}`.trim() || emp.email || emp.id;
                          return (
                            <option key={emp.id} value={emp.id}>
                              {label}
                            </option>
                          );
                        })}
                      </select>

                      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                        <button style={s.btnMainSmall} onClick={cargarInspector} disabled={cargandoInspector}>
                          {cargandoInspector ? "Cargando..." : "Buscar"}
                        </button>

                        <button
                          style={s.btnMainSmall}
                          onClick={() => {
                            const rows = [
                              ["Empleado", "Fecha", "Tipo", "Entrada", "Salida", "Nota"],
                              ...(registrosInspector || []).map((r) => {
                                const emp = empleados.find((x) => x.id === r.empleado_id);
                                const empName = emp ? `${emp.apellidos || ""} ${emp.nombre || ""}`.trim() : r.empleado_id;
                                return [
                                  empName,
                                  r.fecha,
                                  r.tipo || "",
                                  timePretty(r.entrada),
                                  timePretty(r.salida),
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
                      {!registrosInspector?.length ? (
                        <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                      ) : (
                        <div style={s.list}>
                          {registrosInspector.slice(0, 300).map((r) => {
                            const emp = empleados.find((x) => x.id === r.empleado_id);
                            const empName = emp ? `${emp.apellidos || ""} ${emp.nombre || ""}`.trim() : r.empleado_id;

                            return (
                              <div key={r.id} style={s.listRow}>
                                <div style={{ fontWeight: 950 }}>{empName}</div>
                                <div style={{ opacity: 0.85, fontWeight: 900 }}>
                                  {r.fecha} — {r.tipo || "-"}
                                </div>
                                <div style={{ opacity: 0.85 }}>
                                  {timePretty(r.entrada)} → {timePretty(r.salida)}
                                </div>
                                {"nota" in r && (
                                  <div style={{ opacity: 0.85 }}>
                                    <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {!isInspector && !isAdmin && (
                    <div style={{ marginTop: 12 }}>
                      {!registrosRango?.length ? (
                        <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                      ) : (
                        <div style={s.list}>
                          {registrosRango.slice(0, 300).map((r) => (
                            <div key={r.id} style={s.listRow}>
                              <div style={{ fontWeight: 950 }}>{r.fecha} — {r.tipo || "-"}</div>
                              <div style={{ opacity: 0.85 }}>
                                {timePretty(r.entrada)} → {timePretty(r.salida)}
                              </div>
                              {"nota" in r && (
                                <div style={{ opacity: 0.85 }}>
                                  <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* MODAL: RECUPERAR CONTRASEÑA */}
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

      {/* MODAL: RESET PASSWORD */}
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

      {/* MODAL: PRIVACIDAD (SIN texto orientativo) */}
      {showPrivacidad && (
        <Modal title="Aviso de privacidad" onClose={() => setShowPrivacidad(false)}>
          <div style={{ lineHeight: 1.5 }}>
            <div style={{ fontWeight: 950, marginBottom: 6 }}>{EMPRESA.nombre}</div>
            <div><b>CIF:</b> {EMPRESA.cif}</div>
            <div><b>Domicilio:</b> {EMPRESA.direccion}</div>
            <div><b>Email:</b> {EMPRESA.email}</div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Finalidad</div>
            <div>
              Gestión del control horario y registro de jornada laboral (entradas, salidas y pausas),
              incluyendo notas asociadas al fichaje cuando el usuario las añada.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Base legal</div>
            <div>
              Cumplimiento de obligaciones legales en materia laboral y gestión de la relación laboral.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Conservación</div>
            <div>
              Los registros se conservarán durante el tiempo legalmente exigible y el necesario para
              atender posibles responsabilidades.
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

/* Modal simple */
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

/* Estilos inline */
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
  nombreMarca: { fontSize: 42, lineHeight: 1.0, fontWeight: 950, letterSpacing: -0.5 },
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
  clockBig: { fontSize: 64, fontWeight: 950, letterSpacing: -1, lineHeight: 1.0, marginTop: 6 },
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
  userRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  userPill: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 10,
    borderRadius: 999,
    padding: "12px 14px",
    border: "2px solid rgba(0,0,0,0.08)",
    background: "#fafafa",
    fontSize: 20,
    minWidth: 0,
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
  },
  btnOut: {
    borderRadius: 18,
    padding: "12px 16px",
    border: "2px solid rgba(0,0,0,0.10)",
    background: "white",
    fontWeight: 950,
    fontSize: 18,
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
  btnSoftSmall: {
    flex: 1,
    minWidth: 160,
    borderRadius: 18,
    padding: "12px 14px",
    fontSize: 16,
    fontWeight: 950,
    border: "2px solid rgba(0,0,0,0.08)",
    background: "#f6f6f6",
  },
  filters: { display: "flex", gap: 12, flexWrap: "wrap" },
  filterCol: { flex: 1, minWidth: 160 },
  filterLabel: { fontWeight: 950, opacity: 0.8, marginBottom: 6 },

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
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 },
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
