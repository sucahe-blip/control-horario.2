import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";

/**
 * Control horario (Cañizares)
 * Adaptado a tu BD real:
 * - empleados: id, nombre, rol
 * - registros: id, empleado_id, fecha (date), tipo (text), entrada (time), salida (time)
 *
 * Funciona como “un registro por día”:
 * - Iniciar jornada => crea (o actualiza) fila del día con entrada = hora actual, salida = null
 * - Finalizar jornada => actualiza salida = hora actual
 *
 * NOTA: en este esquema NO hay pausas (no hay columnas para ello).
 *       Si quieres pausas, habría que ampliar tabla o hacer tabla aparte.
 */

const EMPRESA = {
  nombre: "Cañizares, Instalaciones y Proyectos, S.A.",
  cif: "A78593316",
  direccion: "Calle Islas Cíes 35, 28035 Madrid",
  email: "canizares@jcanizares.com",
};

// Columnas reales en tu BD:
const REG_FECHA_COL = "fecha"; // date
const REG_ENTRADA_COL = "entrada"; // time
const REG_SALIDA_COL = "salida"; // time
const REG_TIPO_COL = "tipo"; // text

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtHora(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtHoraSinSeg(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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

function toInputDate(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = pad2(x.getMonth() + 1);
  const day = pad2(x.getDate());
  return `${y}-${m}-${day}`;
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

function estadoPorRegistroHoy(regHoy) {
  // regHoy: fila de hoy (o null)
  if (!regHoy) return { estado: "Fuera", dentro: false };
  if (regHoy[REG_ENTRADA_COL] && !regHoy[REG_SALIDA_COL]) return { estado: "Dentro", dentro: true };
  return { estado: "Fuera", dentro: false };
}

export default function App() {
  const [ahora, setAhora] = useState(new Date());

  const [session, setSession] = useState(null);
  const [cargandoSesion, setCargandoSesion] = useState(true);

  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");

  const [msg, setMsg] = useState(null); // {type:'ok'|'err', text:''}

  // Perfil
  const [perfil, setPerfil] = useState(null); // row de usuarios (si existe)
  const [empleado, setEmpleado] = useState(null); // row de empleados
  const [rol, setRol] = useState("empleado"); // empleado | admin | inspector

  const isInspector = rol === "inspector";
  const isAdmin = rol === "admin";

  // Tabs
  const [tab, setTab] = useState("inicio");

  // Registro hoy (1 fila)
  const [registroHoy, setRegistroHoy] = useState(null);

  // Histórico (propio)
  const [desde, setDesde] = useState(toInputDate(new Date()));
  const [hasta, setHasta] = useState(toInputDate(new Date()));
  const [registrosRango, setRegistrosRango] = useState([]);

  // Inspector/admin
  const [empleados, setEmpleados] = useState([]);
  const [empleadoSel, setEmpleadoSel] = useState(""); // "" = todos
  const [registrosInspector, setRegistrosInspector] = useState([]);
  const [cargandoInspector, setCargandoInspector] = useState(false);

  // Modales
  const [showPrivacidad, setShowPrivacidad] = useState(false);
  const [showRecover, setShowRecover] = useState(false);

  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPass1, setNewPass1] = useState("");
  const [newPass2, setNewPass2] = useState("");

  // reloj
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

  // Sesión + listener
  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(data.session || null);
      setCargandoSesion(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession || null);
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // Cargar perfil (usuarios) y empleado
  useEffect(() => {
    (async () => {
      setPerfil(null);
      setEmpleado(null);
      setRol("empleado");

      if (!session?.user?.id) return;

      // 1) Intentar leer tabla usuarios (si existe)
      const { data: u, error: eU } = await supabase
        .from("usuarios")
        .select("user_id, empleado_id, rol, es_admin, es_inspector")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (eU && !String(eU.message || "").toLowerCase().includes("relation")) {
        setMsg({ type: "err", text: `Error cargando usuarios: ${eU.message}` });
      }

      if (u) {
        setPerfil(u);

        const r =
          (u?.rol && String(u.rol).toLowerCase()) ||
          (u?.es_inspector ? "inspector" : u?.es_admin ? "admin" : "empleado");
        setRol(r === "admin" ? "admin" : r === "inspector" ? "inspector" : "empleado");

        if (u?.empleado_id) {
          const { data: emp, error: eEmp } = await supabase
            .from("empleados")
            .select("*")
            .eq("id", u.empleado_id)
            .maybeSingle();
          if (eEmp) {
            setMsg({ type: "err", text: `Error cargando empleado: ${eEmp.message}` });
          } else {
            setEmpleado(emp || null);
            // Si en empleados tienes rol, por si acaso:
            if (emp?.rol && !u?.rol) {
              const rr = String(emp.rol).toLowerCase();
              setRol(rr === "admin" ? "admin" : rr === "inspector" ? "inspector" : "empleado");
            }
          }
        }
        return;
      }

      // 2) Si no hay tabla usuarios o no tiene fila:
      //    intentamos emparejar por email en empleados (si tuvieras email) -> pero NO tienes.
      //    En tu caso es normal que dependas de usuarios.empleado_id.
      //    Si no existe, dejamos el nombre como (Sin nombre).
    })();
  }, [session?.user?.id]);

  // Cargar registro de HOY (1 fila) del empleado
  useEffect(() => {
    (async () => {
      setRegistroHoy(null);

      const empleadoId = perfil?.empleado_id;
      if (!session?.user?.id || !empleadoId) return;

      const hoy = todayYMD();

      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", empleadoId)
        .eq(REG_FECHA_COL, hoy)
        .maybeSingle();

      if (error) {
        setMsg({ type: "err", text: `Error cargando registros de hoy: ${error.message}` });
        return;
      }

      setRegistroHoy(data || null);
    })();
  }, [session?.user?.id, perfil?.empleado_id]);

  // Histórico propio
  useEffect(() => {
    (async () => {
      setRegistrosRango([]);
      if (tab !== "historico") return;

      const empleadoId = perfil?.empleado_id;
      if (!session?.user?.id || !empleadoId) return;

      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", empleadoId)
        .gte(REG_FECHA_COL, desde)
        .lte(REG_FECHA_COL, hasta)
        .order(REG_FECHA_COL, { ascending: false });

      if (error) {
        setMsg({ type: "err", text: `Error cargando histórico: ${error.message}` });
        return;
      }

      setRegistrosRango(data || []);
    })();
  }, [tab, session?.user?.id, perfil?.empleado_id, desde, hasta]);

  // Inspector/admin: cargar lista empleados (solo nombre)
  useEffect(() => {
    (async () => {
      setEmpleados([]);
      if (!session?.user?.id) return;
      if (!(isInspector || isAdmin)) return;

      const { data, error } = await supabase.from("empleados").select("*").order("nombre", {
        ascending: true,
      });

      if (error) {
        setMsg({ type: "err", text: `Error cargando empleados: ${error.message}` });
        return;
      }
      setEmpleados(data || []);
    })();
  }, [session?.user?.id, isInspector, isAdmin]);

  async function cargarInspector() {
    if (!(isInspector || isAdmin)) return;
    setCargandoInspector(true);
    setRegistrosInspector([]);

    let q = supabase
      .from("registros")
      .select("*")
      .gte(REG_FECHA_COL, desde)
      .lte(REG_FECHA_COL, hasta)
      .order(REG_FECHA_COL, { ascending: false });

    if (empleadoSel) q = q.eq("empleado_id", empleadoSel);

    const { data, error } = await q;

    setCargandoInspector(false);

    if (error) {
      setMsg({ type: "err", text: `Error cargando registros (inspector): ${error.message}` });
      return;
    }
    setRegistrosInspector(data || []);
  }

  const haySesion = !!session?.user?.id;
  const fechaLarga = useMemo(() => fmtFechaLarga(ahora), [ahora]);
  const horaGrande = useMemo(() => fmtHora(ahora), [ahora]);

  const nombreVisible = useMemo(() => {
    return (empleado?.nombre || "").trim() || "(Sin nombre)";
  }, [empleado?.nombre]);

  const estadoHoy = useMemo(() => estadoPorRegistroHoy(registroHoy), [registroHoy]);

  // ---- Fichajes (según tu esquema entrada/salida) ----
  async function refrescarHoy() {
    const empleadoId = perfil?.empleado_id;
    if (!empleadoId) return;
    const hoy = todayYMD();

    const { data } = await supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", empleadoId)
      .eq(REG_FECHA_COL, hoy)
      .maybeSingle();

    setRegistroHoy(data || null);
  }

  async function iniciarJornada() {
    setMsg(null);

    const empleadoId = perfil?.empleado_id;
    if (!haySesion || !empleadoId) {
      setMsg({ type: "err", text: "No hay sesión activa o empleado asociado." });
      return;
    }

    if (estadoHoy.dentro) {
      setMsg({ type: "err", text: "Ya tienes una jornada iniciada (salida vacía)." });
      return;
    }

    const hoy = todayYMD();
    const entrada = fmtHoraSinSeg(new Date());

    // Si ya existe fila de hoy, actualizamos entrada y borramos salida
    // Si no existe, insertamos
    const { data: existing, error: e1 } = await supabase
      .from("registros")
      .select("id")
      .eq("empleado_id", empleadoId)
      .eq(REG_FECHA_COL, hoy)
      .maybeSingle();

    if (e1) {
      setMsg({ type: "err", text: `Error comprobando hoy: ${e1.message}` });
      return;
    }

    if (existing?.id) {
      const { error: eUp } = await supabase
        .from("registros")
        .update({
          [REG_TIPO_COL]: "Trabajo",
          [REG_ENTRADA_COL]: entrada,
          [REG_SALIDA_COL]: null,
        })
        .eq("id", existing.id);

      if (eUp) {
        setMsg({ type: "err", text: `Error iniciando jornada: ${eUp.message}` });
        return;
      }
    } else {
      const { error: eIns } = await supabase.from("registros").insert({
        empleado_id: empleadoId,
        [REG_FECHA_COL]: hoy,
        [REG_TIPO_COL]: "Trabajo",
        [REG_ENTRADA_COL]: entrada,
        [REG_SALIDA_COL]: null,
      });

      if (eIns) {
        setMsg({ type: "err", text: `Error iniciando jornada: ${eIns.message}` });
        return;
      }
    }

    setMsg({ type: "ok", text: "Jornada iniciada ✅" });
    await refrescarHoy();
  }

  async function finalizarJornada() {
    setMsg(null);

    const empleadoId = perfil?.empleado_id;
    if (!haySesion || !empleadoId) {
      setMsg({ type: "err", text: "No hay sesión activa o empleado asociado." });
      return;
    }

    if (!estadoHoy.dentro) {
      setMsg({ type: "err", text: "No puedes finalizar: estás fuera (no hay entrada abierta)." });
      return;
    }

    if (!registroHoy?.id) {
      setMsg({ type: "err", text: "No encuentro el registro de hoy para cerrar." });
      return;
    }

    const salida = fmtHoraSinSeg(new Date());

    const { error } = await supabase
      .from("registros")
      .update({ [REG_SALIDA_COL]: salida })
      .eq("id", registroHoy.id);

    if (error) {
      setMsg({ type: "err", text: `Error finalizando jornada: ${error.message}` });
      return;
    }

    setMsg({ type: "ok", text: "Jornada finalizada ✅" });
    await refrescarHoy();
  }

  // ---- Login/Logout ----
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

    setSession(null);
    setPerfil(null);
    setEmpleado(null);
    setRol("empleado");
    setTab("inicio");

    setEmail("");
    setPass("");

    setRegistroHoy(null);
    setRegistrosRango([]);
    setEmpleados([]);
    setEmpleadoSel("");
    setRegistrosInspector([]);

    setMsg({ type: "ok", text: "Sesión cerrada" });
  }

  // ---- Recuperar contraseña ----
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
    // Evita que el token de recovery deje sesión abierta
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

  const showHeaderNav = haySesion;

  return (
    <div style={styles.pagina}>
      <div style={styles.shell}>
        {/* HEADER */}
        <div style={styles.header}>
          <div style={styles.headerTop}>
            <div style={styles.marca}>
              <div style={styles.nombreMarca}>Cañizares S.A.</div>
              <div style={styles.brandSub}>Control horario</div>
            </div>

            <div style={styles.datePill}>{fechaLarga}</div>
          </div>

          <div style={styles.reloj}>
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
                      background: estadoHoy.estado === "Dentro" ? "#7CFC00" : "#d9d9d9",
                      border: "2px solid rgba(255,255,255,0.55)",
                    }}
                  />
                  {estadoHoy.estado}
                </div>
              </div>

              <div style={styles.tabs}>
                <button
                  style={tab === "inicio" ? styles.tabActive : styles.tab}
                  onClick={() => setTab("inicio")}
                >
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

        {/* CARD */}
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

              <button style={styles.btnMain} type="submit" disabled={cargandoSesion}>
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

              {msg && (
                <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>
                  {msg.type === "ok" ? "✅ " : "❌ "}
                  {msg.text}
                </div>
              )}
            </form>
          )}

          {haySesion && (
            <>
              {/* USER ROW (grid para que no se monte Salir) */}
              <div style={styles.userRow}>
                <div style={styles.userPill}>
                  <span style={{ marginRight: 10 }}>👤</span>
                  <span style={{ fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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

              {/* INICIO */}
              {tab === "inicio" && (
                <>
                  {msg && (
                    <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>
                      {msg.type === "ok" ? "✅ " : "❌ "}
                      {msg.text}
                    </div>
                  )}

                  <div style={styles.hr} />

                  <div style={styles.sectionTitle}>Registro de hoy</div>

                  {!registroHoy ? (
                    <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin registros hoy)</div>
                  ) : (
                    <div style={styles.list}>
                      <div style={styles.listRow}>
                        <div style={{ fontWeight: 950 }}>{registroHoy[REG_TIPO_COL] || "Trabajo"}</div>
                        <div style={{ opacity: 0.85, fontWeight: 800 }}>
                          {registroHoy[REG_FECHA_COL]} —{" "}
                          {(registroHoy[REG_ENTRADA_COL] || "--:--") + " → " + (registroHoy[REG_SALIDA_COL] || "--:--")}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* BOTONES */}
                  <div style={styles.bottomBar}>
                    <button
                      style={styles.btnSoft}
                      onClick={iniciarJornada}
                      disabled={estadoHoy.dentro}
                    >
                      Iniciar jornada
                    </button>
                    <button
                      style={styles.btnSoft}
                      onClick={finalizarJornada}
                      disabled={!estadoHoy.dentro}
                    >
                      Finalizar jornada
                    </button>
                  </div>
                </>
              )}

              {/* HISTÓRICO */}
              {tab === "historico" && (
                <>
                  <div style={styles.sectionTitle}>Histórico</div>

                  <div style={styles.filters}>
                    <div style={styles.filterCol}>
                      <div style={styles.filterLabel}>Desde</div>
                      <input
                        type="date"
                        value={desde}
                        onChange={(e) => setDesde(e.target.value)}
                        style={styles.input}
                      />
                    </div>
                    <div style={styles.filterCol}>
                      <div style={styles.filterLabel}>Hasta</div>
                      <input
                        type="date"
                        value={hasta}
                        onChange={(e) => setHasta(e.target.value)}
                        style={styles.input}
                      />
                    </div>
                  </div>

                  {/* Inspector/Admin */}
                  {(isInspector || isAdmin) && (
                    <div style={{ marginTop: 12 }}>
                      <div style={styles.filterLabel}>Empleado</div>
                      <select
                        style={styles.select}
                        value={empleadoSel}
                        onChange={(e) => setEmpleadoSel(e.target.value)}
                      >
                        <option value="">(Todos)</option>
                        {empleados.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {(emp.nombre || "").trim() || emp.id}
                          </option>
                        ))}
                      </select>

                      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                        <button
                          style={styles.btnMainSmall}
                          onClick={cargarInspector}
                          disabled={cargandoInspector}
                        >
                          {cargandoInspector ? "Cargando..." : "Buscar"}
                        </button>

                        <button
                          style={styles.btnMainSmall}
                          onClick={() => {
                            const rows = [
                              ["Empleado", "Fecha", "Entrada", "Salida", "Tipo"],
                              ...(registrosInspector || []).map((r) => {
                                const emp = empleados.find((x) => x.id === r.empleado_id);
                                const empName = emp ? (emp.nombre || "").trim() : r.empleado_id;
                                return [
                                  empName,
                                  r[REG_FECHA_COL],
                                  r[REG_ENTRADA_COL] || "",
                                  r[REG_SALIDA_COL] || "",
                                  r[REG_TIPO_COL] || "",
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

                      <div style={styles.hr} />

                      <div style={styles.sectionTitle}>Resultados</div>
                      {!registrosInspector?.length ? (
                        <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                      ) : (
                        <div style={styles.list}>
                          {registrosInspector.slice(0, 300).map((r) => {
                            const emp = empleados.find((x) => x.id === r.empleado_id);
                            const empName = emp ? (emp.nombre || "").trim() : r.empleado_id;

                            return (
                              <div key={r.id || `${r.empleado_id}-${r[REG_FECHA_COL]}`} style={styles.listRow}>
                                <div style={{ fontWeight: 950 }}>{empName}</div>
                                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                                  {r[REG_FECHA_COL]} — {(r[REG_ENTRADA_COL] || "--:--") + " → " + (r[REG_SALIDA_COL] || "--:--")}
                                </div>
                                <div style={{ opacity: 0.8, fontWeight: 800 }}>
                                  {r[REG_TIPO_COL] || "Trabajo"}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Usuario normal */}
                  {!isInspector && !isAdmin && (
                    <div style={{ marginTop: 12 }}>
                      {!registrosRango?.length ? (
                        <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                      ) : (
                        <div style={styles.list}>
                          {registrosRango.slice(0, 300).map((r) => (
                            <div key={r.id || `${r[REG_FECHA_COL]}-${r[REG_ENTRADA_COL]}`} style={styles.listRow}>
                              <div style={{ fontWeight: 950 }}>{r[REG_TIPO_COL] || "Trabajo"}</div>
                              <div style={{ opacity: 0.85, fontWeight: 800 }}>
                                {r[REG_FECHA_COL]} — {(r[REG_ENTRADA_COL] || "--:--") + " → " + (r[REG_SALIDA_COL] || "--:--")}
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

      {/* MODAL: RECUPERAR CONTRASEÑA */}
      {showRecover && (
        <Modal title="Recuperar contraseña" onClose={() => setShowRecover(false)}>
          <div style={{ fontWeight: 800, opacity: 0.8, marginBottom: 10 }}>
            Te enviaremos un email con un enlace para restablecer la contraseña.
          </div>

          <input
            style={styles.input}
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

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

      {/* MODAL: PRIVACIDAD */}
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
              Gestión del control horario y registro de jornada laboral (entradas y salidas).
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

/* Modal */
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

/* Estilos */
const styles = {
  pagina: {
    minHeight: "100vh",
    background: "#f2f3f6",
    padding: "18px 12px 28px",
    display: "flex",
    justifyContent: "center",
  },
  shell: {
    width: "100%",
    maxWidth: 520,
  },
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
  brandSub: {
    fontSize: 22,
    fontWeight: 800,
    opacity: 0.95,
    marginTop: 6,
  },
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
  statusValue: {
    fontWeight: 950,
    fontSize: 20,
    display: "flex",
    alignItems: "center",
  },
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
  cardTitle: {
    fontSize: 34,
    fontWeight: 950,
    color: "#1f2a37",
    marginBottom: 12,
  },
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

  // ✅ GRID para que nunca se monte el botón Salir
  userRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 12,
    alignItems: "center",
  },
  userPill: {
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
    flexShrink: 0,
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
  hr: {
    height: 1,
    background: "rgba(0,0,0,0.08)",
    margin: "14px 0",
  },
  sectionTitle: {
    fontSize: 26,
    fontWeight: 950,
    color: "#111827",
    marginBottom: 8,
  },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  listRow: {
    borderRadius: 18,
    border: "2px solid rgba(0,0,0,0.06)",
    padding: "12px 14px",
    background: "#fbfbfb",
  },
  bottomBar: {
    display: "flex",
    gap: 12,
    marginTop: 14,
    flexWrap: "wrap",
  },
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
