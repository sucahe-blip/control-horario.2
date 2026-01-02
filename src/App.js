import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";

/**
 * App Control Horario (Cañizares)
 * - Login / Logout
 * - Recuperar contraseña (envía email)
 * - Reset contraseña desde link (Supabase) con modal:
 *      - si cierras sin guardar => signOut() para evitar "entrar" sin cambiar
 * - Privacidad (modal)
 * - Registro jornada + nota
 * - Histórico con filtro Desde/Hasta
 * - Inspector/Admin: lista empleados + histórico por rango + export CSV
 */

const FECHA_COL = "ts"; // si tu columna se llama "created_at" o "fecha", cámbialo aquí

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
  return `Hoy, ${dias[d.getDay()]}, ${pad2(d.getDate())} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function startOfDayISO(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfDayISO(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function toInputDate(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = pad2(x.getMonth() + 1);
  const day = pad2(x.getDate());
  return `${y}-${m}-${day}`;
}

function fromInputDate(str) {
  const [y, m, d] = str.split("-").map((v) => parseInt(v, 10));
  const dt = new Date();
  dt.setFullYear(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
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

function tipoBonito(tipo) {
  const t = (tipo || "").toLowerCase();
  if (t.includes("inicio") && t.includes("pausa")) return "Inicio pausa";
  if (t.includes("fin") && t.includes("pausa")) return "Fin pausa";
  if (t === "inicio") return "Inicio jornada";
  if (t === "fin") return "Fin jornada";
  if (t === "pausa_inicio") return "Inicio pausa";
  if (t === "pausa_fin") return "Fin pausa";
  return tipo || "-";
}

function calcularEstadoHoy(registrosHoy) {
  if (!registrosHoy || registrosHoy.length === 0) {
    return { estado: "Fuera", abiertoTrabajo: false, abiertoPausa: false };
  }
  const last = registrosHoy[0]; // orden desc
  const tipo = (last.tipo || "").toLowerCase();

  const esFin = tipo === "fin" || tipo.includes("fin jornada") || tipo === "salida";
  if (esFin) return { estado: "Fuera", abiertoTrabajo: false, abiertoPausa: false };

  const abiertoPausa =
    tipo === "pausa_inicio" || tipo.includes("inicio pausa") || tipo.includes("pausa_inicio");

  if (abiertoPausa) return { estado: "Pausa", abiertoTrabajo: true, abiertoPausa: true };
  return { estado: "Dentro", abiertoTrabajo: true, abiertoPausa: false };
}

export default function App() {
  const [ahora, setAhora] = useState(new Date());

  const [session, setSession] = useState(null);
  const [cargandoSesion, setCargandoSesion] = useState(true);
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");

  const [msg, setMsg] = useState(null);

  const [perfil, setPerfil] = useState(null);
  const [empleado, setEmpleado] = useState(null);
  const [rol, setRol] = useState("empleado");
  const isInspector = rol === "inspector";
  const isAdmin = rol === "admin";

  const [tab, setTab] = useState("inicio");

  const [registrosHoy, setRegistrosHoy] = useState([]);
  const [registrosRango, setRegistrosRango] = useState([]);
  const [nota, setNota] = useState("");

  const [desde, setDesde] = useState(toInputDate(new Date()));
  const [hasta, setHasta] = useState(toInputDate(new Date()));

  const [empleados, setEmpleados] = useState([]);
  const [empleadoSel, setEmpleadoSel] = useState("");
  const [registrosInspector, setRegistrosInspector] = useState([]);
  const [cargandoInspector, setCargandoInspector] = useState(false);

  const [showPrivacidad, setShowPrivacidad] = useState(false);
  const [showRecover, setShowRecover] = useState(false);

  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPass1, setNewPass1] = useState("");
  const [newPass2, setNewPass2] = useState("");

  const relojRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const hash = window.location.hash || "";
    const isRecovery =
      hash.includes("type=recovery") ||
      hash.includes("type=magiclink") ||
      hash.includes("access_token=") ||
      hash.includes("code=");

    if (isRecovery) setRecoveryMode(true);
  }, []);

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

  useEffect(() => {
    async function cargarHoy() {
      setRegistrosHoy([]);
      if (!session?.user?.id || !perfil?.empleado_id) return;

      const hoy = new Date();
      const desdeISO = startOfDayISO(hoy);
      const hastaISO = endOfDayISO(hoy);

      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", perfil.empleado_id)
        .gte(FECHA_COL, desdeISO)
        .lte(FECHA_COL, hastaISO)
        .order(FECHA_COL, { ascending: false });

      if (error) {
        setMsg({ type: "err", text: `Error cargando registros de hoy: ${error.message}` });
        return;
      }
      setRegistrosHoy(data || []);
    }

    cargarHoy();
  }, [session?.user?.id, perfil?.empleado_id]);

  useEffect(() => {
    async function cargarRangoUsuario() {
      setRegistrosRango([]);
      if (tab !== "historico") return;
      if (!session?.user?.id || !perfil?.empleado_id) return;

      const d = fromInputDate(desde);
      const h = fromInputDate(hasta);

      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", perfil.empleado_id)
        .gte(FECHA_COL, startOfDayISO(d))
        .lte(FECHA_COL, endOfDayISO(h))
        .order(FECHA_COL, { ascending: false });

      if (error) {
        setMsg({ type: "err", text: `Error cargando histórico: ${error.message}` });
        return;
      }
      setRegistrosRango(data || []);
    }

    cargarRangoUsuario();
  }, [tab, session?.user?.id, perfil?.empleado_id, desde, hasta]);

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

  async function cargarInspector() {
    if (!(isInspector || isAdmin)) return;
    setCargandoInspector(true);
    setRegistrosInspector([]);

    const d = fromInputDate(desde);
    const h = fromInputDate(hasta);

    let q = supabase
      .from("registros")
      .select("*")
      .gte(FECHA_COL, startOfDayISO(d))
      .lte(FECHA_COL, endOfDayISO(h))
      .order(FECHA_COL, { ascending: false });

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

  async function insertarRegistro(tipo) {
    if (!session?.user?.id || !perfil?.empleado_id) {
      setMsg({ type: "err", text: "No hay sesión activa." });
      return;
    }

    const payload = {
      user_id: session.user.id,
      empleado_id: perfil.empleado_id,
      tipo,
      nota: (nota || "").trim() || null,
      [FECHA_COL]: new Date().toISOString(),
    };

    const { error } = await supabase.from("registros").insert(payload);

    if (error) {
      setMsg({ type: "err", text: `Error guardando registro: ${error.message}` });
      return;
    }

    setMsg({ type: "ok", text: "OK ✅" });
    setNota("");

    const hoy = new Date();
    const desdeISO = startOfDayISO(hoy);
    const hastaISO = endOfDayISO(hoy);

    const { data } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .gte(FECHA_COL, desdeISO)
      .lte(FECHA_COL, hastaISO)
      .order(FECHA_COL, { ascending: false });

    setRegistrosHoy(data || []);
  }

  async function iniciarJornada() {
    if (estadoHoy.abiertoTrabajo) {
      setMsg({ type: "err", text: "No puedes iniciar: ya estás dentro." });
      return;
    }
    await insertarRegistro("inicio");
  }

  async function finalizarJornada() {
    if (!estadoHoy.abiertoTrabajo) {
      setMsg({ type: "err", text: "No puedes finalizar: ya estás fuera." });
      return;
    }
    if (estadoHoy.abiertoPausa) {
      setMsg({ type: "err", text: "Antes de finalizar, debes cerrar la pausa." });
      return;
    }
    await insertarRegistro("fin");
  }

  async function iniciarPausa() {
    if (!estadoHoy.abiertoTrabajo) {
      setMsg({ type: "err", text: "No puedes pausar: estás fuera." });
      return;
    }
    if (estadoHoy.abiertoPausa) {
      setMsg({ type: "err", text: "Ya tienes una pausa abierta." });
      return;
    }
    await insertarRegistro("pausa_inicio");
  }

  async function finalizarPausa() {
    if (!estadoHoy.abiertoTrabajo) {
      setMsg({ type: "err", text: "No puedes: estás fuera." });
      return;
    }
    if (!estadoHoy.abiertoPausa) {
      setMsg({ type: "err", text: "No hay pausa abierta." });
      return;
    }
    await insertarRegistro("pausa_fin");
  }

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

  const nombreVisible = useMemo(() => {
    const n = [empleado?.nombre, empleado?.apellidos].filter(Boolean).join(" ").trim();
    return n || "(Sin nombre)";
  }, [empleado?.nombre, empleado?.apellidos]);

  const fechaLarga = useMemo(() => fmtFechaLarga(ahora), [ahora]);
  const horaGrande = useMemo(() => fmtHora(ahora), [ahora]);

  const haySesion = !!session?.user?.id;
  const showHeaderNav = haySesion;

  return (
    <div style={styles.pagina}>
      <div style={styles.shell}>
        <div style={styles.header}>
          <div style={styles.headerTop}>
            <div style={styles.marca}>
              <div style={styles.nombreMarca}>Cañizares S.A.</div>
              <div style={styles.brandSub}>Control horario</div>
            </div>

            <div style={styles.datePill}>{fechaLarga}</div>
          </div>

          <div style={styles.reloj} ref={relojRef}>
            <div style={{ fontSize: 12, opacity: 0.9, fontWeight: 800 }}>Hora actual</div>
            <div style={styles.clockBig}>{horaGrande}</div>
          </div>

          {showHeaderNav && (
            <>
              <div style={styles.statusPill}>
                <div style={{ opacity: 0.9, fontWeight: 800 }}>Estado</div>
                <div style={styles.statusValue}>
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

              <div style={styles.tabs}>
                <button style={tab === "inicio" ? styles.tabActive : styles.tab} onClick={() => setTab("inicio")}>
                  Inicio
                </button>
                <button
                  style={tab === "historico" ? styles.tabActive : styles.tab}
                  onClick={() => setTab("historico")}
                >
                  Histórico
                </button>
              </div>
            </>
          )}
        </div>

        <div style={styles.card}>
          {!haySesion && (
            <form onSubmit={entrar}>
              <div style={styles.cardTitle}>Acceso</div>

              <input
                style={styles.input}
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <input
                style={styles.input}
                placeholder="Password"
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                autoComplete="current-password"
              />

              <button style={styles.btnMain} type="submit">
                Entrar
              </button>

              <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={styles.linkBtn}
                  onClick={() => {
                    setShowRecover(true);
                    setMsg(null);
                  }}
                >
                  ¿Has olvidado la contraseña?
                </button>

                <button
                  type="button"
                  style={styles.linkBtn}
                  onClick={() => {
                    setShowPrivacidad(true);
                    setMsg(null);
                  }}
                >
                  Aviso de privacidad
                </button>
              </div>

              {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}
            </form>
          )}

          {haySesion && (
            <>
              <div style={styles.userRow}>
                <div style={styles.userPill}>
                  <span style={{ marginRight: 10 }}>👤</span>
                  <span style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {nombreVisible}
                  </span>
                  {(isInspector || isAdmin) && (
                    <span style={styles.roleBadge}>{isAdmin ? "ADMIN" : "INSPECCIÓN"}</span>
                  )}
                </div>

                <button style={styles.btnOut} onClick={salir}>
                  Salir
                </button>
              </div>

              <div style={styles.hr} />

              {tab === "inicio" && (
                <>
                  <div style={styles.label}>Nota</div>
                  <input
                    style={styles.input}
                    placeholder="(Opcional) Se guardará en el próximo fichaje"
                    value={nota}
                    onChange={(e) => setNota(e.target.value)}
                  />
                  <div style={{ fontSize: 13, opacity: 0.75, fontWeight: 700 }}>
                    Ej.: motivo de ausencia, detalle del día, etc.
                  </div>

                  {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}

                  <div style={styles.hr} />

                  <div style={styles.sectionTitle}>Registro de hoy</div>
                  {registrosHoy.length === 0 ? (
                    <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin registros hoy)</div>
                  ) : (
                    <div style={styles.list}>
                      {registrosHoy.slice(0, 12).map((r) => (
                        <div key={r.id || `${r.tipo}-${r[FECHA_COL]}`} style={styles.listRow}>
                          <div style={{ fontWeight: 900 }}>{tipoBonito(r.tipo)}</div>
                          <div style={{ opacity: 0.8, fontWeight: 800 }}>
                            {new Date(r[FECHA_COL]).toLocaleString()}
                          </div>
                          <div style={{ opacity: 0.85 }}>
                            <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Deja hueco para la barra fija */}
                  <div style={{ height: 160 }} />
                </>
              )}

              {tab === "historico" && (
                <>
                  <div style={styles.sectionTitle}>Histórico</div>

                  <div style={styles.filters}>
                    <div style={styles.filterCol}>
                      <div style={styles.filterLabel}>Desde</div>
                      <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} style={styles.input} />
                    </div>
                    <div style={styles.filterCol}>
                      <div style={styles.filterLabel}>Hasta</div>
                      <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} style={styles.input} />
                    </div>
                  </div>

                  {(isInspector || isAdmin) && (
                    <div style={{ marginTop: 12 }}>
                      <div style={styles.filterLabel}>Empleado</div>
                      <select style={styles.select} value={empleadoSel} onChange={(e) => setEmpleadoSel(e.target.value)}>
                        <option value="">(Todos)</option>
                        {empleados.map((emp) => {
                          const label =
                            `${emp.apellidos || ""} ${emp.nombre || ""}`.trim() || emp.email || emp.id;
                          return (
                            <option key={emp.id} value={emp.id}>
                              {label}
                            </option>
                          );
                        })}
                      </select>

                      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                        <button style={styles.btnMainSmall} onClick={cargarInspector} disabled={cargandoInspector}>
                          {cargandoInspector ? "Cargando..." : "Buscar"}
                        </button>
                        <button
                          style={styles.btnMainSmall}
                          onClick={() => {
                            const rows = [
                              ["Empleado", "Tipo", "Fecha/Hora", "Nota"],
                              ...(registrosInspector || []).map((r) => {
                                const emp = empleados.find((x) => x.id === r.empleado_id);
                                const empName = emp
                                  ? `${emp.apellidos || ""} ${emp.nombre || ""}`.trim()
                                  : r.empleado_id;
                                return [empName, tipoBonito(r.tipo), new Date(r[FECHA_COL]).toLocaleString(), r.nota || ""];
                              }),
                            ];
                            downloadCSV(`control_horario_${desde}_a_${hasta}.csv`, rows);
                          }}
                          disabled={!registrosInspector?.length}
                        >
                          Exportar CSV (Excel)
                        </button>
                      </div>

                      <div style={styles.hr} />

                      <div style={styles.sectionTitle}>Resultados</div>
                      {!registrosInspector?.length ? (
                        <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                      ) : (
                        <div style={styles.list}>
                          {registrosInspector.slice(0, 200).map((r) => {
                            const emp = empleados.find((x) => x.id === r.empleado_id);
                            const empName = emp
                              ? `${emp.apellidos || ""} ${emp.nombre || ""}`.trim()
                              : r.empleado_id;

                            return (
                              <div key={r.id || `${r.empleado_id}-${r[FECHA_COL]}`} style={styles.listRow}>
                                <div style={{ fontWeight: 950 }}>{empName}</div>
                                <div style={{ fontWeight: 900 }}>{tipoBonito(r.tipo)}</div>
                                <div style={{ opacity: 0.8, fontWeight: 800 }}>
                                  {new Date(r[FECHA_COL]).toLocaleString()}
                                </div>
                                <div style={{ opacity: 0.85 }}>
                                  <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                                </div>
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
                        <div style={styles.list}>
                          {registrosRango.slice(0, 200).map((r) => (
                            <div key={r.id || `${r.tipo}-${r[FECHA_COL]}`} style={styles.listRow}>
                              <div style={{ fontWeight: 900 }}>{tipoBonito(r.tipo)}</div>
                              <div style={{ opacity: 0.8, fontWeight: 800 }}>
                                {new Date(r[FECHA_COL]).toLocaleString()}
                              </div>
                              <div style={{ opacity: 0.85 }}>
                                <span style={{ fontWeight: 900 }}>Nota:</span> {r.nota ? r.nota : "-"}
                              </div>
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

      {/* BARRA FIJA ABAJO: siempre visible en Inicio */}
      {haySesion && tab === "inicio" && (
        <div style={styles.fixedBar}>
          <div style={styles.fixedInner}>
            <div style={styles.fixedGrid2}>
              <button
                style={styles.fixedPrimary}
                onClick={iniciarJornada}
                disabled={estadoHoy.abiertoTrabajo}
              >
                Iniciar jornada
              </button>
              <button
                style={styles.fixedSecondary}
                onClick={finalizarJornada}
                disabled={!estadoHoy.abiertoTrabajo || estadoHoy.abiertoPausa}
              >
                Finalizar jornada
              </button>
            </div>

            <div style={styles.fixedGrid2Small}>
              <button
                style={styles.fixedSoft}
                onClick={iniciarPausa}
                disabled={!estadoHoy.abiertoTrabajo || estadoHoy.abiertoPausa}
              >
                Iniciar pausa
              </button>
              <button
                style={styles.fixedSoft}
                onClick={finalizarPausa}
                disabled={!estadoHoy.abiertoTrabajo || !estadoHoy.abiertoPausa}
              >
                Finalizar pausa
              </button>
            </div>
          </div>
        </div>
      )}

      {showRecover && (
        <Modal title="Recuperar contraseña" onClose={() => setShowRecover(false)}>
          <div style={{ fontWeight: 800, opacity: 0.8, marginBottom: 10 }}>
            Te enviaremos un email con un enlace para restablecer la contraseña.
          </div>

          <input style={styles.input} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />

          <button style={styles.btnMain} onClick={enviarRecuperacion}>
            Enviar enlace
          </button>

          {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}
        </Modal>
      )}

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

          {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}
        </Modal>
      )}

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
              Gestión del control horario y registro de jornada laboral (entradas, salidas y pausas),
              incluyendo notas asociadas al fichaje cuando el usuario las añada.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Base legal</div>
            <div>Cumplimiento de obligaciones legales en materia laboral y gestión de la relación laboral.</div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Conservación</div>
            <div>
              Los registros se conservarán durante el tiempo legalmente exigible y el necesario para atender
              posibles responsabilidades.
            </div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Derechos</div>
            <div>
              Puedes solicitar acceso, rectificación, supresión, oposición o limitación escribiendo a{" "}
              {EMPRESA.email}.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

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

const styles = {
  pagina: {
    minHeight: "100vh",
    background: "#f2f3f6",
    padding: "18px 12px 200px", // <-- MUY IMPORTANTE: hueco para barra fija
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
  headerTop: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" },
  marca: { minWidth: 200 },
  nombreMarca: { fontSize: 42, lineHeight: 1.0, fontWeight: 950, letterSpacing: -0.5 },
  brandSub: { fontSize: 22, fontWeight: 800, opacity: 0.95, marginTop: 6 },

  datePill: {
    background: "rgba(255,255,255,0.16)",
    border: "2px solid rgba(255,255,255,0.18)",
    padding: "10px 14px",
    borderRadius: 999,
    fontWeight: 900,
    maxWidth: 320,
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
    whiteSpace: "nowrap",
  },

  hr: { height: 1, background: "rgba(0,0,0,0.08)", margin: "14px 0" },
  label: { fontSize: 18, fontWeight: 950, color: "#374151", marginTop: 6 },
  sectionTitle: { fontSize: 26, fontWeight: 950, color: "#111827", marginBottom: 8 },

  list: { display: "flex", flexDirection: "column", gap: 10 },
  listRow: { borderRadius: 18, border: "2px solid rgba(0,0,0,0.06)", padding: "12px 14px", background: "#fbfbfb" },

  filters: { display: "flex", gap: 12, flexWrap: "wrap" },
  filterCol: { flex: 1, minWidth: 160 },
  filterLabel: { fontWeight: 950, opacity: 0.8, marginBottom: 6 },

  // ✅ BARRA FIJA INFERIOR
  fixedBar: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    padding: "12px 12px calc(12px + env(safe-area-inset-bottom))",
    background: "rgba(242,243,246,0.92)",
    backdropFilter: "blur(10px)",
    borderTop: "1px solid rgba(0,0,0,0.08)",
    zIndex: 9999,
  },
  fixedInner: { width: "100%", maxWidth: 520, margin: "0 auto", display: "grid", gap: 10 },
  fixedGrid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  fixedGrid2Small: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },

  fixedPrimary: {
    borderRadius: 18,
    padding: "16px 14px",
    fontSize: 18,
    fontWeight: 950,
    border: "none",
    background: "#b30000",
    color: "white",
    boxShadow: "0 10px 20px rgba(179,0,0,0.20)",
  },
  fixedSecondary: {
    borderRadius: 18,
    padding: "16px 14px",
    fontSize: 18,
    fontWeight: 950,
    border: "2px solid rgba(0,0,0,0.10)",
    background: "white",
  },
  fixedSoft: {
    borderRadius: 16,
    padding: "12px 10px",
    fontSize: 16,
    fontWeight: 950,
    border: "2px solid rgba(0,0,0,0.10)",
    background: "#f6f6f6",
  },

  // Modal
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: 12,
    zIndex: 10000,
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
