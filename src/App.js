import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./style.css";

/* ===================== CONFIG ===================== */

const EMPRESA = {
  nombre: "Cañizares, Instalaciones y Proyectos, S.A.",
  cif: "A78593316",
  direccion: "Calle Islas Cíes 35, 28035 Madrid",
  email: "canizares@jcanizares.com",
};

// COLUMNAS REALES DE TU BD
const FECHA_COL = "fecha";
const ENTRADA_COL = "entrada";
const SALIDA_COL = "salida";

/* ===================== HELPERS ===================== */

const pad = (n) => String(n).padStart(2, "0");

const hora = (d) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const fechaLarga = (d) =>
  `Hoy, ${["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"][d.getDay()]}, ${d.getDate()} de ${
    [
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
    ][d.getMonth()]
  } de ${d.getFullYear()}`;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
};

const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.toISOString();
};

const toInputDate = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* ===================== APP ===================== */

export default function App() {
  const [now, setNow] = useState(new Date());
  const [session, setSession] = useState(null);
  const [perfil, setPerfil] = useState(null);
  const [empleado, setEmpleado] = useState(null);

  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");

  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState("inicio");

  const [nota, setNota] = useState("");
  const [registrosHoy, setRegistrosHoy] = useState([]);

  const [showRecover, setShowRecover] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPass1, setNewPass1] = useState("");
  const [newPass2, setNewPass2] = useState("");

  /* ===================== CLOCK ===================== */
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);

  /* ===================== AUTH ===================== */
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((evt, s) => {
      setSession(s);

      if (evt === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  /* ===================== PERFIL ===================== */
  useEffect(() => {
    if (!session?.user?.id) return;

    (async () => {
      const { data } = await supabase
        .from("usuarios")
        .select("*")
        .eq("user_id", session.user.id)
        .single();

      setPerfil(data || null);

      if (data?.empleado_id) {
        const { data: emp } = await supabase
          .from("empleados")
          .select("*")
          .eq("id", data.empleado_id)
          .single();
        setEmpleado(emp);
      }
    })();
  }, [session]);

  /* ===================== REGISTROS HOY ===================== */
  useEffect(() => {
    if (!perfil?.empleado_id) return;

    const hoy = new Date();

    supabase
      .from("registros")
      .select("*")
      .eq("empleado_id", perfil.empleado_id)
      .gte(FECHA_COL, startOfDay(hoy))
      .lte(FECHA_COL, endOfDay(hoy))
      .order(ENTRADA_COL, { ascending: false })
      .then(({ data }) => setRegistrosHoy(data || []));
  }, [perfil]);

  /* ===================== LOGIN ===================== */
  async function login(e) {
    e.preventDefault();

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: pass,
    });

    if (error) {
      setMsg({ type: "err", text: error.message });
    } else {
      setMsg({ type: "ok", text: "Sesión iniciada" });
      setPass("");
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    setSession(null);
    setPerfil(null);
    setEmpleado(null);
  }

  /* ===================== RECOVERY ===================== */
  async function sendRecovery() {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });

    if (error) setMsg({ type: "err", text: error.message });
    else setMsg({ type: "ok", text: "Te hemos enviado un email." });
  }

  async function saveNewPassword() {
    if (newPass1.length < 6) {
      setMsg({ type: "err", text: "Mínimo 6 caracteres." });
      return;
    }
    if (newPass1 !== newPass2) {
      setMsg({ type: "err", text: "Las contraseñas no coinciden." });
      return;
    }

    await supabase.auth.updateUser({ password: newPass1 });

    setRecoveryMode(false);
    setNewPass1("");
    setNewPass2("");
    await supabase.auth.signOut();
  }

  const estado =
    registrosHoy.length === 0
      ? "Fuera"
      : registrosHoy[0].salida
      ? "Fuera"
      : "Dentro";

  const nombre = empleado
    ? `${empleado.nombre || ""} ${empleado.apellidos || ""}`
    : "(Sin nombre)";

  const haySesion = !!session?.user;

  /* ===================== RENDER ===================== */

  return (
    <div style={styles.pagina}>
      <div style={styles.shell}>
        {/* CABECERA */}
        <div style={styles.header}>
          <div style={styles.marca}>
            <div style={styles.nombreMarca}>Cañizares S.A.</div>
            <div style={styles.brandSub}>Control horario</div>
          </div>

          <div style={styles.datePill}>{fechaLarga(now)}</div>

          <div style={styles.reloj}>
            <div style={{ fontWeight: 800 }}>Hora actual</div>
            <div style={styles.clockBig}>{hora(now)}</div>
          </div>

          {haySesion && (
            <>
              <div style={styles.statusPill}>
                <div>Estado</div>
                <div style={styles.statusValue}>
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      background: estado === "Dentro" ? "#00ff7f" : "#ddd",
                      marginRight: 8,
                    }}
                  />
                  {estado}
                </div>
              </div>

              <div style={styles.tabs}>
                <button style={styles.tabActive}>Inicio</button>
                <button style={styles.tab}>Histórico</button>
              </div>
            </>
          )}
        </div>

        {/* CONTENIDO */}
        <div style={styles.card}>
          {!haySesion && (
            <>
              <div style={styles.cardTitle}>Acceso</div>

              <input
                style={styles.input}
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <input
                style={styles.input}
                type="password"
                placeholder="Contraseña"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />

              <button style={styles.btnMain} onClick={login}>
                Entrar
              </button>

              <button
                style={styles.linkBtn}
                onClick={() => setShowRecover(true)}
              >
                ¿Has olvidado la contraseña?
              </button>

              {msg && (
                <div style={msg.type === "ok" ? styles.msgOk : styles.msgErr}>
                  {msg.text}
                </div>
              )}
            </>
          )}

          {haySesion && (
            <>
              <div style={styles.userRow}>
                <div style={styles.userPill}>
                  👤 <b>{nombre}</b>
                </div>

                <button style={styles.btnOut} onClick={logout}>
                  Salir
                </button>
              </div>

              <div style={styles.hr} />

              <div style={styles.label}>Nota</div>
              <input
                style={styles.input}
                placeholder="(Opcional)"
                value={nota}
                onChange={(e) => setNota(e.target.value)}
              />

              <div style={styles.msgOk}>✅ Sesión iniciada</div>

              <div style={styles.sectionTitle}>Registro de hoy</div>

              {registrosHoy.map((r) => (
                <div key={r.id} style={styles.listRow}>
                  <b>Trabajo</b>
                  <div>
                    {r.fecha} — {r.entrada} → {r.salida || "--"}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* RECUPERAR PASSWORD */}
      {showRecover && (
        <Modal title="Recuperar contraseña" onClose={() => setShowRecover(false)}>
          <input
            style={styles.input}
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <button style={styles.btnMain} onClick={sendRecovery}>
            Enviar enlace
          </button>
        </Modal>
      )}

      {/* RESET PASSWORD */}
      {recoveryMode && (
        <Modal title="Restablecer contraseña" onClose={() => setRecoveryMode(false)}>
          <input
            style={styles.input}
            placeholder="Nueva contraseña"
            type="password"
            value={newPass1}
            onChange={(e) => setNewPass1(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="Repetir contraseña"
            type="password"
            value={newPass2}
            onChange={(e) => setNewPass2(e.target.value)}
          />
          <button style={styles.btnMain} onClick={saveNewPassword}>
            Guardar contraseña
          </button>
        </Modal>
      )}
    </div>
  );
}

/* ===================== MODAL ===================== */

function Modal({ title, children, onClose }) {
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div style={styles.modalTitle}>{title}</div>
          <button style={styles.modalClose} onClick={onClose}>
            Cerrar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ===================== ESTILOS ===================== */

const styles = {
  pagina: { minHeight: "100vh", background: "#f2f3f6", padding: 12 },
  shell: { maxWidth: 520, margin: "0 auto" },

  header: {
    background: "#b30000",
    color: "white",
    padding: 22,
    borderRadius: 28,
  },

  marca: { marginBottom: 8 },
  nombreMarca: { fontSize: 40, fontWeight: 900 },
  brandSub: { fontSize: 20 },

  datePill: {
    background: "rgba(255,255,255,0.15)",
    padding: 10,
    borderRadius: 20,
    marginTop: 10,
  },

  reloj: { marginTop: 10 },
  clockBig: { fontSize: 52, fontWeight: 900 },

  statusPill: {
    marginTop: 12,
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,255,255,0.15)",
    display: "flex",
    justifyContent: "space-between",
  },

  statusValue: { display: "flex", alignItems: "center", fontWeight: 800 },

  tabs: { display: "flex", gap: 12, marginTop: 12 },
  tab: {
    flex: 1,
    padding: 14,
    borderRadius: 18,
    border: "2px solid rgba(255,255,255,0.3)",
    background: "transparent",
    color: "white",
  },
  tabActive: {
    flex: 1,
    padding: 14,
    borderRadius: 18,
    background: "white",
    fontWeight: 900,
  },

  card: {
    marginTop: 16,
    background: "white",
    padding: 18,
    borderRadius: 28,
  },

  cardTitle: { fontSize: 28, fontWeight: 900 },

  input: {
    width: "100%",
    padding: 14,
    borderRadius: 16,
    border: "2px solid #ddd",
    marginTop: 12,
  },

  btnMain: {
    width: "100%",
    padding: 16,
    marginTop: 14,
    background: "#b30000",
    color: "white",
    fontWeight: 900,
    borderRadius: 20,
    border: "none",
  },

  linkBtn: {
    background: "none",
    border: "none",
    color: "#b30000",
    fontWeight: 900,
    marginTop: 10,
  },

  msgOk: {
    marginTop: 10,
    padding: 12,
    background: "#e6f9ee",
    borderRadius: 12,
    fontWeight: 900,
  },

  msgErr: {
    marginTop: 10,
    padding: 12,
    background: "#fde8e8",
    borderRadius: 12,
    fontWeight: 900,
  },

  userRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
  },

  userPill: {
    flex: "1 1 260px",
    padding: 12,
    borderRadius: 999,
    border: "2px solid #eee",
    fontWeight: 900,
  },

  btnOut: {
    width: "100%",
    padding: 12,
    borderRadius: 18,
    border: "2px solid #ddd",
    fontWeight: 900,
    background: "white",
  },

  hr: { height: 1, background: "#eee", margin: "16px 0" },

  sectionTitle: { fontSize: 22, fontWeight: 900 },

  listRow: {
    border: "2px solid #eee",
    borderRadius: 16,
    padding: 12,
    marginTop: 8,
  },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.4)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: 12,
    zIndex: 9999,
  },

  modal: {
    width: "100%",
    maxWidth: 500,
    background: "white",
    borderRadius: 20,
    padding: 16,
  },

  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 10,
  },

  modalTitle: { fontSize: 24, fontWeight: 900 },

  modalClose: {
    border: "none",
    background: "transparent",
    fontWeight: 900,
    color: "#2563eb",
  },
};
