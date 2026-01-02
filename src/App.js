import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";

const EMPRESA = {
  nombre: "Cañizares, Instalaciones y Proyectos, S.A.",
  cif: "A78593316",
  direccion: "Calle Islas Cíes 35, 28035 Madrid",
  email: "canizares@jcanizares.com",
};

const COL_FECHA = "fecha";   // date
const COL_ENTRADA = "entrada"; // time
const COL_SALIDA = "salida";   // time

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtHora(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function toInputDate(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}
function todayYMD() { return toInputDate(new Date()); }

function fmtFechaLarga(d) {
  const dias = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  return `Hoy, ${dias[d.getDay()]}, ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function tipoBonito(tipo) {
  const t = String(tipo || "").toLowerCase();
  if (t === "inicio") return "Inicio jornada";
  if (t === "fin") return "Fin jornada";
  if (t === "pausa_inicio") return "Inicio pausa";
  if (t === "pausa_fin") return "Fin pausa";
  if (t === "trabajo") return "Trabajo";
  return tipo || "-";
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

function calcularEstado(registrosHoy) {
  if (!registrosHoy?.length) return "Fuera";
  const last = registrosHoy[0];
  if (last?.[COL_SALIDA]) return "Fuera";
  return "Dentro";
}

export default function App() {
  const [ahora, setAhora] = useState(new Date());
  const [isMobile, setIsMobile] = useState(false);

  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState(null); // {type, text}

  const [perfil, setPerfil] = useState(null);
  const [empleado, setEmpleado] = useState(null);

  const [tab, setTab] = useState("inicio"); // inicio | historico

  const [showPrivacidad, setShowPrivacidad] = useState(false);
  const [showRecover, setShowRecover] = useState(false);

  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPass1, setNewPass1] = useState("");
  const [newPass2, setNewPass2] = useState("");

  const [nota, setNota] = useState("");
  const [registrosHoy, setRegistrosHoy] = useState([]);

  const [desde, setDesde] = useState(todayYMD());
  const [hasta, setHasta] = useState(todayYMD());

  const [empleados, setEmpleados] = useState([]);
  const [empleadoSel, setEmpleadoSel] = useState(""); // "" = todos
  const [registrosRango, setRegistrosRango] = useState([]);
  const [cargandoRango, setCargandoRango] = useState(false);

  const haySesion = !!session?.user?.id;

  // reloj
  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // detectar móvil
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 430);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // detectar recovery
  useEffect(() => {
    const hash = window.location.hash || "";
    if (hash.includes("type=recovery") || hash.includes("access_token=") || hash.includes("code=")) {
      setRecoveryMode(true);
    }
  }, []);

  // sesión
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession || null);
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  // cargar perfil + empleado
  useEffect(() => {
    async function loadProfile() {
      setPerfil(null);
      setEmpleado(null);
      if (!session?.user?.id) return;

      const { data: u, error: e1 } = await supabase
        .from("usuarios")
        .select("*")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (e1) {
        setMsg({ type: "err", text: `Error perfil (usuarios): ${e1.message}` });
        return;
      }
      setPerfil(u || null);

      if (u?.empleado_id) {
        const { data: emp, error: e2 } = await supabase
          .from("empleados")
          .select("*")
          .eq("id", u.empleado_id)
          .maybeSingle();
        if (e2) {
          setMsg({ type: "err", text: `Error empleado: ${e2.message}` });
          return;
        }
        setEmpleado(emp || null);
      }
    }
    loadProfile();
  }, [session?.user?.id]);

  // rol (robusto)
  const rol = useMemo(() => {
    const r =
      (perfil?.rol && String(perfil.rol).toLowerCase()) ||
      (perfil?.es_inspector ? "inspector" : perfil?.es_admin ? "admin" : "empleado");
    return r === "admin" ? "admin" : r === "inspector" ? "inspector" : "empleado";
  }, [perfil?.rol, perfil?.es_admin, perfil?.es_inspector]);

  const isInspector = rol === "inspector";
  const isAdmin = rol === "admin";

  // nombre visible (si no hay empleado linked, usa email)
  const nombreVisible = useMemo(() => {
    const n = [empleado?.nombre, empleado?.apellidos].filter(Boolean).join(" ").trim();
    return n || session?.user?.email || "(Sin nombre)";
  }, [empleado?.nombre, empleado?.apellidos, session?.user?.email]);

  // cargar registros hoy
  useEffect(() => {
    async function loadHoy() {
      setRegistrosHoy([]);
      if (!perfil?.empleado_id) return; // si inspector/admin no tiene empleado_id, no cargamos "hoy"
      const hoy = todayYMD();
      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .eq("empleado_id", perfil.empleado_id)
        .eq(COL_FECHA, hoy)
        .order(COL_ENTRADA, { ascending: false });

      if (error) {
        setMsg({ type: "err", text: `Error registros hoy: ${error.message}` });
        return;
      }
      setRegistrosHoy(data || []);
    }
    loadHoy();
  }, [perfil?.empleado_id]);

  const estado = useMemo(() => calcularEstado(registrosHoy), [registrosHoy]);

  // cargar empleados (sin order() para evitar fallo si columnas cambian)
  useEffect(() => {
    async function loadEmpleados() {
      setEmpleados([]);
      if (!haySesion) return;
      if (!(isInspector || isAdmin)) return;

      const { data, error } = await supabase.from("empleados").select("*");
      if (error) {
        setMsg({ type: "err", text: `Error empleados: ${error.message}` });
        return;
      }

      const sorted = (data || []).slice().sort((a, b) => {
        const aa = `${a.apellidos || ""} ${a.nombre || ""}`.trim().toLowerCase();
        const bb = `${b.apellidos || ""} ${b.nombre || ""}`.trim().toLowerCase();
        return aa.localeCompare(bb);
      });

      setEmpleados(sorted);
    }
    loadEmpleados();
  }, [haySesion, isInspector, isAdmin]);

  async function cargarHistoricoRango() {
    setCargandoRango(true);
    setRegistrosRango([]);
    setMsg(null);

    try {
      let q = supabase
        .from("registros")
        .select("*")
        .gte(COL_FECHA, desde)
        .lte(COL_FECHA, hasta)
        .order(COL_FECHA, { ascending: false })
        .order(COL_ENTRADA, { ascending: false });

      if (isInspector || isAdmin) {
        if (empleadoSel) q = q.eq("empleado_id", empleadoSel);
      } else {
        if (!perfil?.empleado_id) {
          setMsg({ type: "err", text: "Tu usuario no tiene empleado_id asociado." });
          return;
        }
        q = q.eq("empleado_id", perfil.empleado_id);
      }

      const { data, error } = await q;
      if (error) {
        setMsg({ type: "err", text: `Error histórico: ${error.message}` });
        return;
      }
      setRegistrosRango(data || []);
    } finally {
      setCargandoRango(false);
    }
  }

  // precarga al entrar en historico
  useEffect(() => {
    if (!haySesion) return;
    if (tab !== "historico") return;
    cargarHistoricoRango();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // login / logout
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
    setEmpleados([]);
    setEmpleadoSel("");
    setRegistrosHoy([]);
    setRegistrosRango([]);
    setMsg({ type: "ok", text: "Sesión cerrada" });
  }

  // recuperar contraseña
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
    await supabase.auth.signOut();
    setMsg({ type: "ok", text: "Contraseña actualizada ✅" });
  }

  async function cerrarRecoverySinGuardar() {
    setRecoveryMode(false);
    setNewPass1("");
    setNewPass2("");
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    await supabase.auth.signOut();
    setMsg({ type: "ok", text: "Cancelado. No se ha cambiado la contraseña." });
  }

  // FIX: tabs siempre clicables (type button) y confirmación visual
  function goTab(t) {
    setTab(t);
    setMsg(null);
  }

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
            <div style={styles.datePill}>{fmtFechaLarga(ahora)}</div>
          </div>

          <div style={styles.reloj}>
            <div style={{ fontSize: 12, opacity: 0.9, fontWeight: 800 }}>Hora actual</div>
            <div style={styles.clockBig}>{fmtHora(ahora)}</div>
          </div>

          {haySesion && (
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
                      background: estado === "Dentro" ? "#7CFC00" : "#d9d9d9",
                      border: "2px solid rgba(255,255,255,0.55)",
                    }}
                  />
                  {estado}
                </div>
              </div>

              <div style={styles.tabs}>
                <button type="button" style={tab === "inicio" ? styles.tabActive : styles.tab} onClick={() => goTab("inicio")}>
                  Inicio
                </button>
                <button type="button" style={tab === "historico" ? styles.tabActive : styles.tab} onClick={() => goTab("historico")}>
                  Histórico
                </button>
              </div>

              {/* DEBUG visible (para confirmar que el click funciona) */}
              <div style={{ marginTop: 10, opacity: 0.9, fontWeight: 900, fontSize: 13 }}>
                TAB: {tab} · ROL: {rol}
              </div>
            </>
          )}
        </div>

        {/* CARD */}
        <div style={styles.card}>
          {!haySesion && (
            <form onSubmit={entrar}>
              <div style={styles.cardTitle}>Acceso</div>

              <input style={styles.input} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input style={styles.input} placeholder="Password" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />

              <button style={styles.btnMain} type="submit">Entrar</button>

              <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <button type="button" style={styles.linkBtn} onClick={() => { setShowRecover(true); setMsg(null); }}>
                  ¿Has olvidado la contraseña?
                </button>
                <button type="button" style={styles.linkBtn} onClick={() => { setShowPrivacidad(true); setMsg(null); }}>
                  Aviso de privacidad
                </button>
              </div>

              {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}
            </form>
          )}

          {haySesion && (
            <>
              <div style={{ ...styles.userRow, flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "center" }}>
                <div style={{ ...styles.userPill, width: "100%" }}>
                  <span style={{ marginRight: 10 }}>👤</span>
                  <span style={{ fontWeight: 900 }}>{nombreVisible}</span>
                  {(isInspector || isAdmin) && (
                    <span style={styles.roleBadge}>{isAdmin ? "ADMIN" : "INSPECCIÓN"}</span>
                  )}
                </div>

                <button type="button" style={{ ...styles.btnOut, width: isMobile ? "100%" : "auto" }} onClick={salir}>
                  Salir
                </button>
              </div>

              {/* botón privacidad también con sesión */}
              <button
                type="button"
                style={{ ...styles.linkBtn, marginTop: 12 }}
                onClick={() => setShowPrivacidad(true)}
              >
                Aviso de privacidad
              </button>

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

                  {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}

                  <div style={styles.hr} />

                  <div style={styles.sectionTitle}>Registro de hoy</div>
                  {!perfil?.empleado_id ? (
                    <div style={{ opacity: 0.7, fontWeight: 700 }}>
                      (Este usuario no tiene empleado_id asociado)
                    </div>
                  ) : registrosHoy.length === 0 ? (
                    <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin registros hoy)</div>
                  ) : (
                    <div style={styles.list}>
                      {registrosHoy.slice(0, 20).map((r) => (
                        <div key={r.id} style={styles.listRow}>
                          <div style={{ fontWeight: 950 }}>{tipoBonito(r.tipo)}</div>
                          <div style={{ opacity: 0.85, fontWeight: 800 }}>
                            {r.fecha} — {r.entrada} → {r.salida || "--"}
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
                          const label = `${emp.apellidos || ""} ${emp.nombre || ""}`.trim() || emp.email || emp.id;
                          return <option key={emp.id} value={emp.id}>{label}</option>;
                        })}
                      </select>
                      {empleados.length === 0 && (
                        <div style={{ marginTop: 8, opacity: 0.7, fontWeight: 800 }}>
                          (No se han cargado empleados — revisa RLS o columnas)
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                    <button type="button" style={styles.btnMainSmall} onClick={cargarHistoricoRango} disabled={cargandoRango}>
                      {cargandoRango ? "Cargando..." : "Buscar"}
                    </button>

                    <button
                      type="button"
                      style={styles.btnMainSmall}
                      onClick={() => {
                        const rows = [
                          ["Empleado", "Tipo", "Fecha", "Entrada", "Salida", "Nota"],
                          ...(registrosRango || []).map((r) => {
                            const emp = empleados.find((x) => x.id === r.empleado_id);
                            const empName = emp ? `${emp.apellidos || ""} ${emp.nombre || ""}`.trim() : r.empleado_id;
                            return [empName, tipoBonito(r.tipo), r.fecha, r.entrada || "", r.salida || "", r.nota || ""];
                          }),
                        ];
                        downloadCSV(`historico_${desde}_a_${hasta}.csv`, rows);
                      }}
                      disabled={!registrosRango?.length}
                    >
                      Exportar CSV
                    </button>
                  </div>

                  {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}

                  <div style={styles.hr} />

                  {!registrosRango.length ? (
                    <div style={{ opacity: 0.7, fontWeight: 700 }}>(Sin resultados en ese rango)</div>
                  ) : (
                    <div style={styles.list}>
                      {registrosRango.slice(0, 250).map((r) => {
                        const emp = empleados.find((x) => x.id === r.empleado_id);
                        const empName = emp ? `${emp.apellidos || ""} ${emp.nombre || ""}`.trim() : r.empleado_id;

                        return (
                          <div key={r.id} style={styles.listRow}>
                            {(isInspector || isAdmin) && <div style={{ fontWeight: 950 }}>{empName}</div>}
                            <div style={{ fontWeight: 900 }}>{tipoBonito(r.tipo)}</div>
                            <div style={{ opacity: 0.85, fontWeight: 800 }}>
                              {r.fecha} — {r.entrada} → {r.salida || "--"}
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
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* MODAL RECOVER */}
      {showRecover && (
        <Modal title="Recuperar contraseña" onClose={() => setShowRecover(false)}>
          <div style={{ fontWeight: 800, opacity: 0.8, marginBottom: 10 }}>
            Te enviaremos un email con un enlace para restablecer la contraseña.
          </div>
          <input style={styles.input} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="button" style={styles.btnMain} onClick={enviarRecuperacion}>Enviar enlace</button>
          {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}
        </Modal>
      )}

      {/* MODAL RESET */}
      {recoveryMode && (
        <Modal title="Restablecer contraseña" onClose={cerrarRecoverySinGuardar} closeText="Cerrar">
          <div style={{ fontWeight: 800, opacity: 0.8, marginBottom: 10 }}>
            Introduce una nueva contraseña (mínimo 6 caracteres).
          </div>
          <input style={styles.input} placeholder="Nueva contraseña" type="password" value={newPass1} onChange={(e) => setNewPass1(e.target.value)} />
          <input style={styles.input} placeholder="Repite la contraseña" type="password" value={newPass2} onChange={(e) => setNewPass2(e.target.value)} />
          <button type="button" style={styles.btnMain} onClick={guardarNuevaPass}>Guardar contraseña</button>
          {msg && <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>{msg.text}</div>}
        </Modal>
      )}

      {/* MODAL PRIVACIDAD */}
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
            <div>Cumplimiento de obligaciones legales en materia laboral y gestión de la relación laboral.</div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Conservación</div>
            <div>Los registros se conservarán durante el tiempo legalmente exigible y el necesario para atender posibles responsabilidades.</div>

            <div style={{ marginTop: 12, fontWeight: 900 }}>Derechos</div>
            <div>Puedes solicitar acceso, rectificación, supresión, oposición o limitación escribiendo a {EMPRESA.email}.</div>
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
          <button type="button" style={styles.modalClose} onClick={onClose}>{closeText}</button>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
}

const styles = {
  pagina: { minHeight: "100vh", background: "#f2f3f6", padding: "18px 12px 28px", display: "flex", justifyContent: "center" },
  shell: { width: "100%", maxWidth: 520 },
  header: { background: "#b30000", borderRadius: 28, padding: 22, color: "white", boxShadow: "0 10px 24px rgba(0,0,0,0.18)" },
  headerTop: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" },
  marca: { minWidth: 200 },
  nombreMarca: { fontSize: 42, lineHeight: 1.0, fontWeight: 950, letterSpacing: -0.5 },
  brandSub: { fontSize: 22, fontWeight: 800, opacity: 0.95, marginTop: 6 },
  datePill: { background: "rgba(255,255,255,0.16)", border: "2px solid rgba(255,255,255,0.18)", padding: "10px 14px", borderRadius: 999, fontWeight: 900, maxWidth: 280, textAlign: "center" },
  reloj: { marginTop: 16 },
  clockBig: { fontSize: 64, fontWeight: 950, letterSpacing: -1, lineHeight: 1.0, marginTop: 6 },
  statusPill: { marginTop: 16, background: "rgba(255,255,255,0.14)", border: "2px solid rgba(255,255,255,0.16)", borderRadius: 18, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  statusValue: { fontWeight: 950, fontSize: 20, display: "flex", alignItems: "center" },
  tabs: { marginTop: 14, display: "flex", gap: 14 },
  tab: { flex: 1, borderRadius: 18, padding: "14px 16px", fontWeight: 950, fontSize: 20, border: "2px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.08)", color: "white" },
  tabActive: { flex: 1, borderRadius: 18, padding: "14px 16px", fontWeight: 950, fontSize: 20, border: "2px solid rgba(255,255,255,0.22)", background: "rgba(255,255,255,0.92)", color: "#1f2a37" },
  card: { marginTop: 16, background: "white", borderRadius: 28, padding: 18, boxShadow: "0 14px 30px rgba(0,0,0,0.10)", border: "1px solid rgba(0,0,0,0.06)" },
  cardTitle: { fontSize: 34, fontWeight: 950, color: "#1f2a37", marginBottom: 12 },
  input: { width: "100%", borderRadius: 18, border: "2px solid rgba(0,0,0,0.08)", padding: "14px 16px", fontSize: 18, outline: "none", marginTop: 12, boxSizing: "border-box" },
  select: { width: "100%", borderRadius: 18, border: "2px solid rgba(0,0,0,0.10)", padding: "14px 16px", fontSize: 16, outline: "none", marginTop: 8, boxSizing: "border-box", background: "white", fontWeight: 800 },
  btnMain: { width: "100%", marginTop: 16, borderRadius: 22, padding: "16px 18px", fontSize: 22, fontWeight: 950, border: "none", background: "#b30000", color: "white" },
  btnMainSmall: { borderRadius: 18, padding: "12px 14px", fontSize: 16, fontWeight: 950, border: "none", background: "#b30000", color: "white" },
  linkBtn: { border: "none", background: "transparent", color: "#b30000", fontWeight: 950, fontSize: 18, padding: 0, cursor: "pointer" },
  msgOk: { marginTop: 14, padding: "12px 14px", borderRadius: 16, background: "rgba(34,197,94,0.10)", border: "2px solid rgba(34,197,94,0.20)", fontWeight: 950, color: "#065f46" },
  msgErr: { marginTop: 14, padding: "12px 14px", borderRadius: 16, background: "rgba(239,68,68,0.10)", border: "2px solid rgba(239,68,68,0.20)", fontWeight: 950, color: "#7f1d1d" },
  userRow: { display: "flex", justifyContent: "space-between", gap: 12 },
  userPill: { display: "flex", alignItems: "center", gap: 10, borderRadius: 999, padding: "12px 14px", border: "2px solid rgba(0,0,0,0.08)", background: "#fafafa", fontSize: 20, minWidth: 0 },
  roleBadge: { marginLeft: 10, fontSize: 12, padding: "4px 8px", borderRadius: 999, background: "#111827", color: "white", fontWeight: 950, letterSpacing: 0.6 },
  btnOut: { borderRadius: 18, padding: "12px 16px", border: "2px solid rgba(0,0,0,0.10)", background: "white", fontWeight: 950, fontSize: 18 },
  hr: { height: 1, background: "rgba(0,0,0,0.08)", margin: "14px 0" },
  label: { fontSize: 18, fontWeight: 950, color: "#374151", marginTop: 6 },
  sectionTitle: { fontSize: 26, fontWeight: 950, color: "#111827", marginBottom: 8 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  listRow: { borderRadius: 18, border: "2px solid rgba(0,0,0,0.06)", padding: "12px 14px", background: "#fbfbfb" },
  filters: { display: "flex", gap: 12, flexWrap: "wrap" },
  filterCol: { flex: 1, minWidth: 160 },
  filterLabel: { fontWeight: 950, opacity: 0.8, marginBottom: 6 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 12, zIndex: 9999 },
  modal: { width: "100%", maxWidth: 560, background: "white", borderRadius: 18, padding: 16, boxShadow: "0 18px 40px rgba(0,0,0,0.22)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 },
  modalTitle: { fontSize: 28, fontWeight: 950, color: "#111827" },
  modalClose: { borderRadius: 999, padding: "10px 14px", border: "2px solid rgba(0,0,0,0.10)", background: "white", fontWeight: 950, color: "#2563eb" },
};
