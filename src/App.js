import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import * as XLSX from 'xlsx';

/* =========================
   CONFIG
   ========================= */

const EMPRESA_NOMBRE_EXCEL = 'CAÑIZARES, INSTALACIONES Y PROYECTOS, S.A.';
const EMPRESA_NOMBRE_UI = 'Cañizares, Instalaciones y Proyectos, S.A.';

/* =========================
   PRIVACIDAD (TEXTO)
   ========================= */

const PRIVACIDAD_TEXTO = `
AVISO DE PRIVACIDAD – CONTROL HORARIO

Responsable del tratamiento
Cañizares, Instalaciones y Proyectos, S.A.
CIF: A78593316
Dirección: Calle Islas Cíes 35, 28035 Madrid
Email de contacto: canizares@jcanizares.com

1. Finalidad del tratamiento
Los datos personales recogidos a través de esta aplicación se utilizan exclusivamente para:
- El registro de la jornada laboral.
- El control horario del personal.
- La gestión laboral y administrativa de los empleados.
- La generación de informes internos y registros obligatorios ante inspecciones laborales.

2. Base legal
El tratamiento se basa en:
- El cumplimiento de una obligación legal (art. 34.9 Estatuto de los Trabajadores).
- La ejecución del contrato laboral.
- El interés legítimo en la organización y control de la actividad laboral.

3. Datos tratados
- Correo electrónico corporativo
- Identificación del empleado
- Registros de entrada y salida
- Fechas, horas y notas asociadas al fichaje
No se recogen datos especialmente protegidos.

4. Conservación de los datos
Los registros se conservarán durante un mínimo de 4 años, conforme a la normativa laboral vigente.

5. Destinatarios
Los datos podrán ser tratados por la propia empresa y por proveedores tecnológicos necesarios (alojamiento/BD),
bajo contrato de confidencialidad. No se cederán datos a terceros salvo obligación legal.

6. Derechos
Acceso, rectificación, supresión, limitación y oposición.
Para ejercerlos: canizares@jcanizares.com

7. Seguridad
Se aplican medidas técnicas y organizativas razonables para proteger los datos.

8. Aceptación
El uso de la aplicación implica la aceptación de este aviso.

AVISO LEGAL
Titular: Cañizares, Instalaciones y Proyectos, S.A. — CIF: A78593316
Domicilio: Calle Islas Cíes 35, 28035 Madrid
Email: canizares@jcanizares.com
`;

/* =========================
   FACTORES / TIEMPOS
   ========================= */

// Solo suman Trabajo y restan Pausa
function tipoFactor(tipo) {
  if (tipo === 'Pausa') return -1;
  if (tipo === 'Trabajo') return 1;
  return 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fechaLocalYYYYMMDD(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function horaLocalHHMM(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fechaHoraExportacion() {
  const d = new Date();
  return `${fechaLocalYYYYMMDD(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatearFechaDDMMYYYY(isoYYYYMMDD) {
  if (!isoYYYYMMDD) return '';
  const [y, m, d] = String(isoYYYYMMDD).split('-');
  if (!y || !m || !d) return String(isoYYYYMMDD);
  return `${d}-${m}-${y}`;
}

function hhmmToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToHHMM(mins) {
  const safe = Math.max(0, mins || 0);
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function minutosDeRegistro(r) {
  const e = hhmmToMinutes(r.entrada);
  const s = hhmmToMinutes(r.salida);
  if (e == null || s == null) return 0;
  if (s < e) return 0;
  const base = s - e;
  return base * tipoFactor(r.tipo);
}

function totalMinutos(registros) {
  return (registros ?? []).reduce((acc, r) => acc + minutosDeRegistro(r), 0);
}

function agruparPorFecha(registros) {
  const map = new Map();
  for (const r of registros ?? []) {
    const f = r.fecha;
    if (!map.has(f)) map.set(f, { fecha: f, items: [], totalMin: 0 });
    const g = map.get(f);
    g.items.push(r);
    g.totalMin += minutosDeRegistro(r);
  }

  return Array.from(map.values())
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .map((g) => ({
      ...g,
      items: g.items.sort((x, y) =>
        (x.entrada ?? '').localeCompare(y.entrada ?? '')
      ),
    }));
}

function startOfWeekISO(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  const day = d.getDay(); // 0 dom, 1 lun...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return fechaLocalYYYYMMDD(d);
}

function endOfWeekISO(dateISO) {
  const start = new Date(startOfWeekISO(dateISO) + 'T00:00:00');
  start.setDate(start.getDate() + 6);
  return fechaLocalYYYYMMDD(start);
}

function startOfMonthISO(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

function endOfMonthISO(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return fechaLocalYYYYMMDD(last);
}

function safeFilePart(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

/* =========================
   EXPORT EXCEL (PLANTILLA)
   ========================= */

function buildAOAForExcel({
  empresaNombre,
  empleadoNombre,
  modo,
  fechaSel,
  registrosPeriodo,
  totalPeriodoHHMM,
}) {
  const periodoTxt = modo === 'DIA' ? 'Día' : modo === 'SEMANA' ? 'Semana' : 'Mes';
  const refTxt = formatearFechaDDMMYYYY(fechaSel);
  const fechaListado = fechaHoraExportacion();

  const tableRows = (registrosPeriodo ?? []).map((r) => [
    formatearFechaDDMMYYYY(r.fecha),
    (r.entrada ?? '').length === 5 ? `${r.entrada}:00` : (r.entrada ?? ''),
    (r.salida ?? '').length === 5 ? `${r.salida}:00` : (r.salida ?? ''),
    r.tipo ?? '',
    r.nota ?? '',
  ]);

  return [
    [empresaNombre],
    [],
    ['EMPLEADO', empleadoNombre || ''],
    ['PERIODO', periodoTxt],
    ['REFERENCIA', refTxt],
    ['TOTAL NETO', `${totalPeriodoHHMM} horas`],
    ['FECHA LISTADO', fechaListado],
    [],
    ['Fecha', 'Entrada', 'Salida', 'Tipo', 'Nota'],
    ...tableRows,
  ];
}

function exportarXLSX({
  empresaNombre,
  empleadoNombre,
  modo,
  fechaSel,
  registrosPeriodo,
  totalPeriodoHHMM,
}) {
  const aoa = buildAOAForExcel({
    empresaNombre,
    empleadoNombre,
    modo,
    fechaSel,
    registrosPeriodo,
    totalPeriodoHHMM,
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Historico');

  const nombreEmpleado = safeFilePart(empleadoNombre || 'Empleado');
  const nombre = `historico_${modo.toLowerCase()}_${fechaSel}_${nombreEmpleado}.xlsx`;
  XLSX.writeFile(wb, nombre);
}

/* =========================
   COMPONENTE: MODAL
   ========================= */

function Modal({ title, children, onClose }) {
  const C = {
    borde: '#e5e7eb',
    blanco: '#ffffff',
    negro: '#111827',
    fondo: 'rgba(0,0,0,.45)',
  };

  const m = {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: C.fondo,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 14,
      zIndex: 9999,
    },
    panel: {
      width: '100%',
      maxWidth: 560,
      background: C.blanco,
      borderRadius: 18,
      border: `1px solid ${C.borde}`,
      boxShadow: '0 20px 50px rgba(0,0,0,.2)',
      overflow: 'hidden',
    },
    head: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 14,
      borderBottom: `1px solid ${C.borde}`,
    },
    title: { fontWeight: 900, color: C.negro },
    close: {
      border: `1px solid ${C.borde}`,
      background: C.blanco,
      borderRadius: 12,
      padding: '8px 10px',
      fontWeight: 900,
      cursor: 'pointer',
    },
    body: {
      padding: 14,
      maxHeight: '70vh',
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      lineHeight: 1.35,
      color: C.negro,
      fontSize: 14,
    },
  };

  return (
    <div style={m.overlay} onClick={onClose}>
      <div style={m.panel} onClick={(e) => e.stopPropagation()}>
        <div style={m.head}>
          <div style={m.title}>{title}</div>
          <button style={m.close} onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div style={m.body}>{children}</div>
      </div>
    </div>
  );
}

/* =========================
   APP
   ========================= */

export default function App() {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [profile, setProfile] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // Abiertos del día
  const [abiertoTrabajo, setAbiertoTrabajo] = useState(null);
  const [abiertoPausa, setAbiertoPausa] = useState(null);
  const [hoy, setHoy] = useState([]);

  // HISTÓRICO
  const [modo, setModo] = useState('DIA');
  const [fechaSel, setFechaSel] = useState(fechaLocalYYYYMMDD());
  const [registrosPeriodo, setRegistrosPeriodo] = useState([]);
  const [loadingPeriodo, setLoadingPeriodo] = useState(false);

  // ADMIN
  const [empleados, setEmpleados] = useState([]);
  const [empleadoSel, setEmpleadoSel] = useState('');

  // Nombre empleado (UI y Excel)
  const [empleadoNombre, setEmpleadoNombre] = useState('');

  // Nota
  const [nota, setNota] = useState('');

  // Tabs
  const [tab, setTab] = useState('FICHAR'); // FICHAR | HISTORICO

  // Privacidad modal
  const [showPrivacidad, setShowPrivacidad] = useState(false);

  // Recuperación de contraseña (modo)
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPass, setNewPass] = useState('');
  const [newPass2, setNewPass2] = useState('');

  // Reloj
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const empleadoObjetivoId = profile?.es_admin
    ? empleadoSel || profile?.empleado_id
    : profile?.empleado_id;

  const estoyViendoMiEmpleado =
    !!profile?.empleado_id && empleadoObjetivoId === profile.empleado_id;

  /* -------- Formatos fecha/hora -------- */
  const fechaLarga = useMemo(() => {
    try {
      const f = new Intl.DateTimeFormat('es-ES', {
        weekday: 'short',
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }).format(now);
      return f.charAt(0).toUpperCase() + f.slice(1);
    } catch {
      return now.toLocaleDateString();
    }
  }, [now]);

  const horaGrande = useMemo(() => {
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(
      now.getSeconds()
    )}`;
  }, [now]);

  /* -------- Auth -------- */
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);

      // Cuando el usuario entra desde el email de recuperación:
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true);
        setMsg('Introduce una nueva contraseña');
      }

      // reset de UI “normal”
      if (event === 'SIGNED_OUT') {
        setRecoveryMode(false);
        setNewPass('');
        setNewPass2('');
      }

      setProfile(null);
      setAbiertoTrabajo(null);
      setAbiertoPausa(null);
      setHoy([]);
      setModo('DIA');
      setFechaSel(fechaLocalYYYYMMDD());
      setRegistrosPeriodo([]);
      setEmpleados([]);
      setEmpleadoSel('');
      setEmpleadoNombre('');
      setNota('');
      setTab('FICHAR');
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  /* -------- Perfil -------- */
  useEffect(() => {
    const run = async () => {
      if (!session?.user?.id) return;

      setMsg('Cargando perfil...');
      const { data, error } = await supabase
        .from('usuarios')
        .select('user_id, empleado_id, es_admin')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (error) setMsg('ERROR: ' + error.message);
      else {
        setProfile(data);
        setMsg('OK ✅');
      }
    };
    run();
  }, [session]);

  /* -------- Admin: empleados -------- */
  useEffect(() => {
    const cargarEmpleados = async () => {
      if (!profile?.es_admin) return;

      const { data, error } = await supabase
        .from('empleados')
        .select('id, nombre')
        .order('nombre', { ascending: true });

      if (error) {
        setMsg('ERROR cargando empleados: ' + error.message);
        return;
      }

      setEmpleados(data ?? []);
      if (!empleadoSel && profile?.empleado_id) setEmpleadoSel(profile.empleado_id);
    };

    cargarEmpleados();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.es_admin, profile?.empleado_id]);

  /* -------- Nombre empleado (UI y Excel) -------- */
  useEffect(() => {
    const cargarNombre = async () => {
      if (!empleadoObjetivoId) {
        setEmpleadoNombre('');
        return;
      }

      const fromList = (empleados ?? []).find((e) => e.id === empleadoObjetivoId);
      if (fromList?.nombre) {
        setEmpleadoNombre(fromList.nombre);
        return;
      }

      const { data, error } = await supabase
        .from('empleados')
        .select('nombre')
        .eq('id', empleadoObjetivoId)
        .maybeSingle();

      if (!error && data?.nombre) setEmpleadoNombre(data.nombre);
    };

    cargarNombre();
  }, [empleadoObjetivoId, empleados]);

  /* -------- Estado del día -------- */
  async function cargarEstadoDia() {
    if (!empleadoObjetivoId) return;
    const fecha = fechaLocalYYYYMMDD();

    const { data: tOpen } = await supabase
      .from('registros')
      .select('id, entrada, tipo')
      .eq('empleado_id', empleadoObjetivoId)
      .eq('fecha', fecha)
      .eq('tipo', 'Trabajo')
      .is('salida', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setAbiertoTrabajo(tOpen ?? null);

    const { data: pOpen } = await supabase
      .from('registros')
      .select('id, entrada, tipo')
      .eq('empleado_id', empleadoObjetivoId)
      .eq('fecha', fecha)
      .eq('tipo', 'Pausa')
      .is('salida', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setAbiertoPausa(pOpen ?? null);

    const { data: lista } = await supabase
      .from('registros')
      .select('id, fecha, entrada, salida, tipo, nota, created_at')
      .eq('empleado_id', empleadoObjetivoId)
      .eq('fecha', fecha)
      .order('created_at', { ascending: true });

    setHoy(lista ?? []);
  }

  /* -------- Histórico -------- */
  async function cargarPeriodo(modoLocal, fechaISO) {
    if (!empleadoObjetivoId) return;

    let desde = fechaISO;
    let hasta = fechaISO;

    if (modoLocal === 'SEMANA') {
      desde = startOfWeekISO(fechaISO);
      hasta = endOfWeekISO(fechaISO);
    }
    if (modoLocal === 'MES') {
      desde = startOfMonthISO(fechaISO);
      hasta = endOfMonthISO(fechaISO);
    }

    setLoadingPeriodo(true);
    setMsg('Cargando histórico...');

    const { data, error } = await supabase
      .from('registros')
      .select('id, fecha, entrada, salida, tipo, nota, created_at')
      .eq('empleado_id', empleadoObjetivoId)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      setMsg('ERROR histórico: ' + error.message);
      setRegistrosPeriodo([]);
    } else {
      setRegistrosPeriodo(data ?? []);
      setMsg('OK ✅');
    }

    setLoadingPeriodo(false);
  }

  useEffect(() => {
    if (!empleadoObjetivoId) return;
    cargarEstadoDia();
    cargarPeriodo(modo, fechaSel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empleadoObjetivoId]);

  useEffect(() => {
    if (!empleadoObjetivoId) return;
    cargarPeriodo(modo, fechaSel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo, fechaSel, empleadoObjetivoId]);

  /* -------- Login / Logout -------- */
  const login = async () => {
    setMsg('Entrando...');
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) setMsg('ERROR: ' + error.message);
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setMsg('Sesión cerrada');
  };

  /* -------- Recuperar contraseña -------- */
  const enviarReset = async () => {
    const e = email.trim();
    if (!e) {
      setMsg('Escribe tu email para enviar el enlace de recuperación.');
      return;
    }

    setMsg('Enviando email de recuperación...');
    const { error } = await supabase.auth.resetPasswordForEmail(e, {
      redirectTo: window.location.origin,
    });

    if (error) setMsg('ERROR: ' + error.message);
    else setMsg('✅ Email enviado. Revisa tu correo y sigue el enlace.');
  };

  const guardarNuevaPassword = async () => {
    if (!newPass || newPass.length < 6) {
      setMsg('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    if (newPass !== newPass2) {
      setMsg('Las contraseñas no coinciden.');
      return;
    }

    setMsg('Guardando nueva contraseña...');
    const { error } = await supabase.auth.updateUser({ password: newPass });

    if (error) {
      setMsg('ERROR: ' + error.message);
      return;
    }

    setMsg('✅ Contraseña actualizada. Ya puedes usar la app.');
    setRecoveryMode(false);
    setNewPass('');
    setNewPass2('');
  };

  /* =========================
     FICHAJES (solo Trabajo/Pausa)
     ========================= */

  async function entradaTrabajo() {
    if (!profile?.empleado_id) return;
    if (!estoyViendoMiEmpleado) return;
    if (busy) return;

    if (abiertoTrabajo || abiertoPausa) {
      setMsg('⚠️ Ya tienes un registro abierto. Finaliza o reanuda.');
      return;
    }

    setBusy(true);
    try {
      const fecha = fechaLocalYYYYMMDD();
      const hora = horaLocalHHMM();
      const notaLimpia = nota.trim();

      const { error } = await supabase.from('registros').insert({
        empleado_id: profile.empleado_id,
        fecha,
        tipo: 'Trabajo',
        entrada: hora,
        nota: notaLimpia ? notaLimpia : null,
      });

      if (error) setMsg('ERROR: ' + error.message);
      else {
        setMsg('✅ Jornada iniciada');
        setNota('');
      }

      await cargarEstadoDia();
      await cargarPeriodo(modo, fechaSel);
    } finally {
      setBusy(false);
    }
  }

  async function salidaTrabajo() {
    if (!profile?.empleado_id) return;
    if (!estoyViendoMiEmpleado) return;
    if (busy) return;

    if (!abiertoTrabajo) {
      setMsg('⚠️ No hay jornada iniciada');
      return;
    }
    if (abiertoPausa) {
      setMsg('⏸️ Reanuda antes de finalizar');
      return;
    }

    setBusy(true);
    try {
      const hora = horaLocalHHMM();
      const notaLimpia = nota.trim();

      const payload = { salida: hora };
      if (notaLimpia) payload.nota = notaLimpia;

      const { error } = await supabase
        .from('registros')
        .update(payload)
        .eq('id', abiertoTrabajo.id);

      if (error) setMsg('ERROR: ' + error.message);
      else {
        setMsg('✅ Jornada finalizada');
        setNota('');
      }

      await cargarEstadoDia();
      await cargarPeriodo(modo, fechaSel);
    } finally {
      setBusy(false);
    }
  }

  // Iniciar pausa: cierra Trabajo y abre Pausa (para cumplir “1 abierto”)
  async function iniciarPausa() {
    if (!profile?.empleado_id) return;
    if (!estoyViendoMiEmpleado) return;
    if (busy) return;

    if (!abiertoTrabajo) {
      setMsg('⚠️ No puedes iniciar pausa si no has iniciado jornada');
      return;
    }
    if (abiertoPausa) {
      setMsg('⚠️ Ya hay una pausa abierta');
      return;
    }

    setBusy(true);
    try {
      const fecha = fechaLocalYYYYMMDD();
      const hora = horaLocalHHMM();
      const notaLimpia = nota.trim();

      const { error: e1 } = await supabase
        .from('registros')
        .update({ salida: hora })
        .eq('id', abiertoTrabajo.id);

      if (e1) {
        setMsg('ERROR: ' + e1.message);
        return;
      }

      const { error: e2 } = await supabase.from('registros').insert({
        empleado_id: profile.empleado_id,
        fecha,
        tipo: 'Pausa',
        entrada: hora,
        nota: notaLimpia ? notaLimpia : null,
      });

      if (e2) setMsg('ERROR: ' + e2.message);
      else {
        setMsg('⏸️ Pausa iniciada');
        setNota('');
      }

      await cargarEstadoDia();
      await cargarPeriodo(modo, fechaSel);
    } finally {
      setBusy(false);
    }
  }

  // Reanudar: cierra Pausa y abre Trabajo
  async function terminarPausa() {
    if (!profile?.empleado_id) return;
    if (!estoyViendoMiEmpleado) return;
    if (busy) return;

    if (!abiertoPausa) {
      setMsg('⚠️ No hay pausa abierta');
      return;
    }

    setBusy(true);
    try {
      const fecha = fechaLocalYYYYMMDD();
      const hora = horaLocalHHMM();
      const notaLimpia = nota.trim();

      const payload = { salida: hora };
      if (notaLimpia) payload.nota = notaLimpia;

      const { error: e1 } = await supabase
        .from('registros')
        .update(payload)
        .eq('id', abiertoPausa.id);

      if (e1) {
        setMsg('ERROR: ' + e1.message);
        return;
      }

      const { error: e2 } = await supabase.from('registros').insert({
        empleado_id: profile.empleado_id,
        fecha,
        tipo: 'Trabajo',
        entrada: hora,
        nota: null,
      });

      if (e2) setMsg('ERROR: ' + e2.message);
      else {
        setMsg('▶️ Reanudado');
        setNota('');
      }

      await cargarEstadoDia();
      await cargarPeriodo(modo, fechaSel);
    } finally {
      setBusy(false);
    }
  }

  /* -------- Totales / estado -------- */
  const totalHoyHHMM = minutesToHHMM(totalMinutos(hoy));
  const totalPeriodoHHMM = minutesToHHMM(totalMinutos(registrosPeriodo));
  const gruposPeriodo = agruparPorFecha(registrosPeriodo);

  const estadoTexto = abiertoPausa
    ? `⏸️ Pausa (desde ${abiertoPausa.entrada})`
    : abiertoTrabajo
    ? `🟢 Trabajo (desde ${abiertoTrabajo.entrada})`
    : '⚪ Fuera';

  /* =========================
     UX MÓVIL: estilos
     ========================= */

  const C = {
    rojo: '#b30000',
    rojoClaro: '#ffeded',
    gris: '#6b7280',
    borde: '#e5e7eb',
    fondo: '#f6f7fb',
    blanco: '#ffffff',
    negro: '#111827',
  };

  const s = {
    page: {
      minHeight: '100vh',
      background: C.fondo,
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial',
      padding: 14,
      color: C.negro,
    },
    shell: {
      maxWidth: 480,
      margin: '0 auto',
      paddingBottom: 120,
    },
    header: {
      background: C.rojo,
      color: C.blanco,
      borderRadius: 18,
      padding: 14,
      boxShadow: '0 10px 25px rgba(0,0,0,.08)',
    },
    headerTop: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    brand: { display: 'flex', flexDirection: 'column', gap: 2 },
    brandName: { fontWeight: 900, fontSize: 18, lineHeight: 1.15 },
    brandSub: { fontSize: 13, opacity: 0.9, fontWeight: 800 },
    datePill: {
      background: 'rgba(255,255,255,.16)',
      border: '1px solid rgba(255,255,255,.25)',
      padding: '6px 10px',
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 800,
      whiteSpace: 'nowrap',
      maxWidth: 180,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    clock: {
      marginTop: 10,
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    clockBig: {
      fontSize: 34,
      fontWeight: 900,
      letterSpacing: 0.5,
      lineHeight: 1,
    },
    statusPill: {
      background: 'rgba(255,255,255,.16)',
      border: '1px solid rgba(255,255,255,.25)',
      padding: '8px 10px',
      borderRadius: 14,
      fontSize: 12,
      fontWeight: 900,
      textAlign: 'right',
      minWidth: 160,
    },
    tabs: { marginTop: 12, display: 'flex', gap: 10 },
    tabBtn: (active) => ({
      flex: 1,
      padding: '12px 12px',
      borderRadius: 14,
      border: `1px solid ${active ? C.rojo : C.borde}`,
      background: active ? C.rojoClaro : C.blanco,
      color: active ? C.rojo : C.negro,
      fontWeight: 900,
      cursor: 'pointer',
    }),
    card: {
      marginTop: 12,
      background: C.blanco,
      border: `1px solid ${C.borde}`,
      borderRadius: 18,
      padding: 14,
      boxShadow: '0 10px 25px rgba(0,0,0,.04)',
    },
    row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
    label: { fontSize: 12, fontWeight: 900, color: C.gris },
    select: {
      padding: '12px 12px',
      borderRadius: 12,
      border: `1px solid ${C.borde}`,
      background: C.blanco,
      minWidth: 160,
      fontWeight: 900,
    },
    input: {
      padding: '12px 12px',
      borderRadius: 12,
      border: `1px solid ${C.borde}`,
      width: '100%',
      boxSizing: 'border-box',
      fontSize: 16,
    },
    hr: { border: 0, borderTop: `1px solid ${C.borde}`, margin: '14px 0' },
    small: { fontSize: 12, color: C.gris, fontWeight: 800 },
    list: { margin: 0, paddingLeft: 18 },
    li: { margin: '8px 0', lineHeight: 1.25 },
    msg: { marginTop: 10, fontWeight: 900, color: C.negro },

    btn: (variant = 'primary') => {
      const isPrimary = variant === 'primary';
      const isGhost = variant === 'ghost';
      const bg = isPrimary ? C.rojo : isGhost ? C.blanco : C.negro;
      const color = isPrimary ? C.blanco : isGhost ? C.negro : C.blanco;
      const border = isPrimary ? C.rojo : C.borde;

      return {
        height: 52,
        padding: '0 14px',
        borderRadius: 16,
        border: `1px solid ${border}`,
        background: bg,
        color,
        fontWeight: 900,
        cursor: 'pointer',
        boxShadow: isPrimary ? '0 10px 20px rgba(179,0,0,.18)' : 'none',
        fontSize: 15,
      };
    },
    btnDisabled: { opacity: 0.45, cursor: 'not-allowed', boxShadow: 'none' },

    bottomBar: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      padding: '12px 14px',
      paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
      background: 'rgba(246,247,251,.92)',
      backdropFilter: 'blur(10px)',
      borderTop: `1px solid ${C.borde}`,
    },
    bottomInner: {
      maxWidth: 480,
      margin: '0 auto',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 10,
    },
    bottomPrimary: {
      height: 56,
      borderRadius: 18,
      fontSize: 16,
      fontWeight: 900,
      border: `1px solid ${C.rojo}`,
      background: C.rojo,
      color: C.blanco,
      cursor: 'pointer',
      boxShadow: '0 10px 20px rgba(179,0,0,.18)',
    },
    bottomSecondary: {
      height: 56,
      borderRadius: 18,
      fontSize: 16,
      fontWeight: 900,
      border: `1px solid ${C.borde}`,
      background: C.blanco,
      color: C.negro,
      cursor: 'pointer',
    },

    loginBox: {
      marginTop: 12,
      background: C.blanco,
      border: `1px solid ${C.borde}`,
      borderRadius: 18,
      padding: 14,
    },

    linkBtn: {
      border: 'none',
      background: 'transparent',
      padding: 0,
      margin: 0,
      color: C.rojo,
      fontWeight: 900,
      cursor: 'pointer',
      textAlign: 'left',
    },

    employeePill: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 10px',
      borderRadius: 999,
      border: `1px solid ${C.borde}`,
      background: C.blanco,
      fontWeight: 900,
    },
  };

  const btnStyle = (disabled, variant) => ({
    ...s.btn(variant),
    ...(disabled ? s.btnDisabled : null),
  });

  /* =========================
     Botón principal automático
     ========================= */

  const autoLabel =
    !abiertoTrabajo && !abiertoPausa
      ? 'Iniciar jornada'
      : abiertoPausa
      ? 'Reanudar'
      : 'Iniciar pausa';

  const autoDisabled = !estoyViendoMiEmpleado || busy || loadingPeriodo;

  const autoAction = async () => {
    if (!abiertoTrabajo && !abiertoPausa) return entradaTrabajo();
    if (abiertoPausa) return terminarPausa();
    return iniciarPausa();
  };

  const finDisabled =
    !estoyViendoMiEmpleado ||
    busy ||
    loadingPeriodo ||
    !abiertoTrabajo ||
    !!abiertoPausa;

  /* =========================
     RENDER
     ========================= */

  return (
    <div style={s.page}>
      <div style={s.shell}>
        <div style={s.header}>
          <div style={s.headerTop}>
            <div style={s.brand}>
              <div style={s.brandName}>{EMPRESA_NOMBRE_UI}</div>
              <div style={s.brandSub}>Control horario</div>
            </div>
            <div style={s.datePill}>{`Hoy, ${fechaLarga}`}</div>
          </div>

          <div style={s.clock}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.9, fontWeight: 800 }}>
                Hora actual
              </div>
              <div style={s.clockBig}>{horaGrande}</div>
            </div>
            <div style={s.statusPill}>
              <div style={{ opacity: 0.9 }}>Estado</div>
              <div style={{ marginTop: 4 }}>{estadoTexto}</div>
            </div>
          </div>

          <div style={s.tabs}>
            <button
              style={s.tabBtn(tab === 'FICHAR')}
              onClick={() => setTab('FICHAR')}
              disabled={!session}
            >
              Inicio
            </button>
            <button
              style={s.tabBtn(tab === 'HISTORICO')}
              onClick={() => setTab('HISTORICO')}
              disabled={!session}
            >
              Histórico
            </button>
          </div>
        </div>

        {/* ======== LOGIN / RECOVERY ======== */}
        {!session ? (
          <div style={s.loginBox}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>
              {recoveryMode ? 'Nueva contraseña' : 'Acceso'}
            </div>

            {!recoveryMode ? (
              <div style={{ display: 'grid', gap: 10 }}>
                <input
                  style={s.input}
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <input
                  style={s.input}
                  placeholder="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button style={btnStyle(false, 'primary')} onClick={login}>
                  Entrar
                </button>

                {/* Opción 1: enlaces debajo */}
                <div style={{ display: 'grid', gap: 6 }}>
                  <button style={s.linkBtn} onClick={enviarReset}>
                    ¿Has olvidado la contraseña?
                  </button>
                  <button style={s.linkBtn} onClick={() => setShowPrivacidad(true)}>
                    Aviso de privacidad
                  </button>
                </div>

                <div style={s.small}>{msg}</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                <input
                  style={s.input}
                  placeholder="Nueva contraseña"
                  type="password"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                />
                <input
                  style={s.input}
                  placeholder="Repite la contraseña"
                  type="password"
                  value={newPass2}
                  onChange={(e) => setNewPass2(e.target.value)}
                />
                <button style={btnStyle(false, 'primary')} onClick={guardarNuevaPassword}>
                  Guardar contraseña
                </button>

                <button
                  style={btnStyle(false, 'ghost')}
                  onClick={() => {
                    setRecoveryMode(false);
                    setNewPass('');
                    setNewPass2('');
                    setMsg('');
                  }}
                >
                  Volver
                </button>

                <div style={s.small}>{msg}</div>
              </div>
            )}
          </div>
        ) : (
          <div style={s.card}>
            {/* Nombre del empleado + salir */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                alignItems: 'center',
              }}
            >
              <div style={s.employeePill}>
                <span role="img" aria-label="user">
                  👤
                </span>
                <span>{empleadoNombre || '(Sin nombre)'}</span>
              </div>

              <button
                style={btnStyle(busy || loadingPeriodo, 'ghost')}
                onClick={logout}
                disabled={busy || loadingPeriodo}
              >
                Cerrar sesión
              </button>
            </div>

            <div style={s.hr} />

            {profile?.es_admin && (
              <>
                <div style={{ ...s.row, justifyContent: 'space-between' }}>
                  <div style={s.row}>
                    <div style={s.label}>Empleado</div>
                    <select
                      style={s.select}
                      value={empleadoSel}
                      onChange={(e) => setEmpleadoSel(e.target.value)}
                      disabled={busy || loadingPeriodo}
                    >
                      {empleados.map((em) => (
                        <option key={em.id} value={em.id}>
                          {em.nombre}
                        </option>
                      ))}
                    </select>
                    <button
                      style={btnStyle(busy || loadingPeriodo, 'ghost')}
                      onClick={async () => {
                        await cargarEstadoDia();
                        await cargarPeriodo(modo, fechaSel);
                      }}
                      disabled={busy || loadingPeriodo}
                    >
                      Ver
                    </button>
                  </div>

                  {!estoyViendoMiEmpleado && (
                    <div style={{ ...s.small, fontWeight: 900 }}>
                      (Viendo otro empleado)
                    </div>
                  )}
                </div>

                <div style={s.hr} />
              </>
            )}

            {tab === 'FICHAR' ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <div style={s.label}>Nota</div>
                  <input
                    style={s.input}
                    placeholder="(Opcional) Se guardará en el próximo fichaje"
                    value={nota}
                    onChange={(e) => setNota(e.target.value)}
                    disabled={!estoyViendoMiEmpleado || busy || loadingPeriodo}
                  />
                  <div style={{ ...s.small, marginTop: 6 }}>
                    Ej.: motivo de ausencia, detalle del día, etc.
                  </div>
                </div>

                <div style={s.msg}>{msg}</div>

                <div style={s.hr} />

                <div>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>
                    Registro de hoy
                  </div>

                  {hoy.length === 0 ? (
                    <div style={s.small}>(Sin registros hoy)</div>
                  ) : (
                    <ul style={s.list}>
                      {hoy.map((r) => (
                        <li key={r.id} style={s.li}>
                          <b>{r.tipo}</b> — Entrada: <b>{r.entrada ?? '-'}</b> — Salida:{' '}
                          <b>{r.salida ?? '-'}</b>
                          {r.nota ? ` — Nota: ${r.nota}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div style={{ marginTop: 10, fontWeight: 900 }}>
                    Total neto de hoy:{' '}
                    <span style={{ color: C.rojo }}>{totalHoyHHMM}</span> h
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={s.row}>
                  <div style={s.label}>Periodo</div>
                  <button
                    style={btnStyle(modo === 'DIA' || loadingPeriodo, 'ghost')}
                    onClick={() => setModo('DIA')}
                    disabled={modo === 'DIA' || loadingPeriodo}
                  >
                    Día
                  </button>
                  <button
                    style={btnStyle(modo === 'SEMANA' || loadingPeriodo, 'ghost')}
                    onClick={() => setModo('SEMANA')}
                    disabled={modo === 'SEMANA' || loadingPeriodo}
                  >
                    Semana
                  </button>
                  <button
                    style={btnStyle(modo === 'MES' || loadingPeriodo, 'ghost')}
                    onClick={() => setModo('MES')}
                    disabled={modo === 'MES' || loadingPeriodo}
                  >
                    Mes
                  </button>
                </div>

                <div style={s.row}>
                  <div style={s.label}>Fecha</div>
                  <input
                    type="date"
                    value={fechaSel}
                    onChange={(e) => setFechaSel(e.target.value)}
                    disabled={loadingPeriodo}
                    style={{ ...s.input, maxWidth: 220 }}
                  />
                  <button
                    style={btnStyle(loadingPeriodo, 'ghost')}
                    onClick={() => setFechaSel(fechaLocalYYYYMMDD())}
                    disabled={loadingPeriodo}
                  >
                    Hoy
                  </button>

                  <button
                    style={btnStyle(loadingPeriodo, 'primary')}
                    onClick={() =>
                      exportarXLSX({
                        empresaNombre: EMPRESA_NOMBRE_EXCEL,
                        empleadoNombre: empleadoNombre,
                        modo,
                        fechaSel,
                        registrosPeriodo,
                        totalPeriodoHHMM,
                      })
                    }
                    disabled={loadingPeriodo}
                  >
                    Exportar Excel
                  </button>
                </div>

                <div style={s.small}>
                  <b>
                    Total{' '}
                    {modo === 'DIA'
                      ? 'del día'
                      : modo === 'SEMANA'
                      ? 'semanal'
                      : 'mensual'}{' '}
                    (neto):
                  </b>{' '}
                  {loadingPeriodo ? 'Cargando...' : `${totalPeriodoHHMM} horas`}
                </div>

                <div style={s.msg}>{msg}</div>

                <div style={s.hr} />

                {loadingPeriodo ? (
                  <div style={s.small}>Cargando...</div>
                ) : modo === 'DIA' ? (
                  registrosPeriodo.length === 0 ? (
                    <div style={s.small}>(Sin registros ese día)</div>
                  ) : (
                    <ul style={s.list}>
                      {registrosPeriodo.map((r) => (
                        <li key={r.id} style={s.li}>
                          <b>{formatearFechaDDMMYYYY(r.fecha)}</b> — <b>{r.tipo}</b> — Entrada:{' '}
                          <b>{r.entrada ?? '-'}</b> — Salida: <b>{r.salida ?? '-'}</b>
                          {r.nota ? ` — Nota: ${r.nota}` : ''}
                        </li>
                      ))}
                    </ul>
                  )
                ) : gruposPeriodo.length === 0 ? (
                  <div style={s.small}>(Sin registros en el periodo)</div>
                ) : (
                  <>
                    {gruposPeriodo.map((g) => (
                      <div key={g.fecha} style={{ marginBottom: 12 }}>
                        <div style={{ fontWeight: 900 }}>
                          {formatearFechaDDMMYYYY(g.fecha)} — Total neto:{' '}
                          <span style={{ color: C.rojo }}>
                            {minutesToHHMM(g.totalMin)}
                          </span>{' '}
                          h
                        </div>
                        <ul style={{ ...s.list, marginTop: 6 }}>
                          {g.items.map((r) => (
                            <li key={r.id} style={s.li}>
                              {r.tipo} — Entrada: <b>{r.entrada ?? '-'}</b> — Salida:{' '}
                              <b>{r.salida ?? '-'}</b>
                              {r.nota ? ` — Nota: ${r.nota}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Barra inferior sticky con botones grandes */}
      {session && tab === 'FICHAR' && (
        <div style={s.bottomBar}>
          <div style={s.bottomInner}>
            <button
              style={{
                ...s.bottomPrimary,
                ...(autoDisabled ? s.btnDisabled : null),
              }}
              disabled={autoDisabled}
              onClick={autoAction}
            >
              {autoLabel}
            </button>

            <button
              style={{
                ...s.bottomSecondary,
                ...(finDisabled ? s.btnDisabled : null),
              }}
              disabled={finDisabled}
              onClick={salidaTrabajo}
            >
              Finalizar jornada
            </button>
          </div>
        </div>
      )}

      {/* Modal privacidad */}
      {showPrivacidad && (
        <Modal title="Aviso de privacidad y aviso legal" onClose={() => setShowPrivacidad(false)}>
          {PRIVACIDAD_TEXTO}
        </Modal>
      )}
    </div>
  );
}
