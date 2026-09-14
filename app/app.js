/* ============================================================
   COTIZADOR M&M MEDICAL — Versión Cloud (GitHub + Supabase + Vercel)
   ============================================================ */

const SUPABASE_URL = "https://stljwvpwozeagnbzqkeh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN0bGp3dnB3b3plYWduYnpxa2VoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzNzMyNDIsImV4cCI6MjEwNDk0OTI0Mn0.sxDOIrsFbfKlUS3Sz5pLDgOAP7trVLL4OzKiXqgpNxI";

var sbClient = null;
function getSb() {
  if (!sbClient && window.supabase && window.supabase.createClient) {
    try {
      sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (e) {
      console.warn("Error inicializando cliente de Supabase:", e);
    }
  }
  return sbClient;
}

/* ============================================================
   FOLDER SAVER — Guarda PDFs en carpeta local via File System Access API
   - Primera vez: muestra selector de carpeta
   - Siguientes veces: guarda directo sin preguntar
   - Fallback: descarga normal si el navegador no soporta la API
   ============================================================ */
const FolderSaver = {
  DB_NAME: "CotizadorFS",
  DB_STORE: "handles",
  DB_KEY: "pdfFolder",

  // Abre (o crea) la base IndexedDB donde guardamos el handle de la carpeta
  _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(this.DB_STORE);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  },

  async _getHandle() {
    try {
      const db = await this._openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.DB_STORE, "readonly");
        const req = tx.objectStore(this.DB_STORE).get(this.DB_KEY);
        req.onsuccess = e => resolve(e.target.result || null);
        req.onerror = e => reject(e.target.error);
      });
    } catch { return null; }
  },

  async _saveHandle(handle) {
    try {
      const db = await this._openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.DB_STORE, "readwrite");
        const req = tx.objectStore(this.DB_STORE).put(handle, this.DB_KEY);
        req.onsuccess = () => resolve();
        req.onerror = e => reject(e.target.error);
      });
    } catch { /* silencioso */ }
  },

  // Verifica que el permiso sigue vigente; si no, lo re-solicita
  async _verifyPermission(handle) {
    const opts = { writable: true };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  },

  // API pública: guarda el blob en la carpeta elegida
  // Retorna true si guardó en carpeta, false si usó descarga normal
  async saveBlob(blob, filename) {
    // Si el navegador no soporta la API → descarga normal
    if (!("showDirectoryPicker" in window)) {
      this._fallbackDownload(blob, filename);
      return false;
    }

    let dirHandle = await this._getHandle();

    // Si no hay carpeta guardada o el permiso venció → pedir carpeta
    if (!dirHandle || !(await this._verifyPermission(dirHandle))) {
      try {
        dirHandle = await window.showDirectoryPicker({
          id: "cotizaciones-pdf",
          mode: "readwrite",
          startIn: "documents"
        });
        await this._saveHandle(dirHandle);
      } catch (err) {
        // Usuario canceló el selector → descarga normal
        this._fallbackDownload(blob, filename);
        return false;
      }
    }

    // Escribir el archivo en la carpeta
    try {
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      console.warn("Error escribiendo en carpeta:", e);
      this._fallbackDownload(blob, filename);
      return false;
    }
  },

  _fallbackDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  // Permite al usuario cambiar la carpeta guardada
  async changeFolder() {
    if (!("showDirectoryPicker" in window)) {
      return toast("Tu navegador no soporta esta función. Usa Chrome o Edge.", true);
    }
    try {
      const dirHandle = await window.showDirectoryPicker({
        id: "cotizaciones-pdf",
        mode: "readwrite",
        startIn: "documents"
      });
      await this._saveHandle(dirHandle);
      toast(`✅ Carpeta configurada: ${dirHandle.name}`);
    } catch { /* cancelado */ }
  }
};
window.FolderSaver = FolderSaver;


let STATE = {
  datos: [],
  cyp: { clientes: [], asesores: [] },
  cotizaciones: [],
  seq: {},
  lastUpdate: null
};

let DRAFT = null;

function persistStateLocal() {
  try {
    localStorage.setItem("cotizador_state_cache", JSON.stringify(STATE));
  } catch (e) {}
}

function loadStateLocal() {
  try {
    const raw = localStorage.getItem("cotizador_state_cache");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") STATE = { ...STATE, ...parsed };
    }
  } catch (e) {}
}

const DB = {
  getDatos() { return STATE.datos || []; },
  getCYP() { return STATE.cyp || { clientes: [], asesores: [] }; },
  getCotizaciones() { return STATE.cotizaciones || []; },
  setCotizaciones(v) { STATE.cotizaciones = v; persistStateLocal(); },
  nextNumero() {
    const year = new Date().getFullYear();
    const cots = STATE.cotizaciones || [];
    let maxN = 0;
    cots.forEach(c => {
      const m = String(c.numero || "").match(/^(?:C-)?(\d{4})-(\d+)$/);
      if (m && Number(m[1]) === year) {
        maxN = Math.max(maxN, parseInt(m[2], 10));
      }
    });
    const nextVal = maxN + 1;
    return {
      preview: `C-${year}-${nextVal}`,
      commit: () => {}
    };
  }
};

function toast(msg, isError) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 3500);
}

function fmtCOP(n) {
  n = Math.round(Number(n) || 0);
  return "$" + n.toLocaleString("es-CO");
}

function parseNum(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;
  return Number(String(v).replace(/[^0-9.-]/g, "")) || 0;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatFechaHora(isoStr) {
  if (!isoStr) return "Sin registros previos";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return "Sin registros previos";
    return d.toLocaleString("es-CO", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  } catch (e) {
    return "Sin registros previos";
  }
}

/* ============================================================
   ROUTER
   ============================================================ */
const Router = {
  current: "home",
  go(view, opts) {
    try {
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      const target = document.getElementById("view-" + view);
      if (target) target.classList.add("active");
      const shell = document.querySelector(".app-shell");
      if (shell) shell.classList.toggle("wide-nueva", view === "nueva");
      this.current = view;
      if (view === "nueva") Views.renderNueva(opts && opts.record);
      if (view === "guardadas") Views.renderGuardadas();
      if (view === "asesores") Views.renderAsesores();
      if (view === "actualizar-excel") Views.renderActualizarExcel();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      console.error(e);
      toast("Error al abrir pantalla: " + e.message, true);
    }
  }
};

window.addEventListener("error", e => { console.error(e.error || e.message); });
window.addEventListener("unhandledrejection", e => { console.error(e.reason); });

/* ============================================================
   AUTOCOMPLETE
   ============================================================ */
function attachAutocomplete(inputEl, listEl, getItems, renderItem, onPick, itemClass = "ac-item") {
  if (!inputEl || !listEl) return;
  let hi = -1, items = [];
  function close() { listEl.classList.remove("show"); listEl.innerHTML = ""; hi = -1; }

  inputEl.addEventListener("input", () => {
    const q = inputEl.value.trim().toLowerCase();
    items = q ? getItems(q).slice(0, 40) : [];
    if (!items.length) return close();
    listEl.innerHTML = items.map((it, i) => `<div class="${itemClass}" data-i="${i}">${renderItem(it)}</div>`).join("");
    listEl.classList.add("show");
    hi = -1;
  });

  listEl.addEventListener("mousedown", e => {
    const row = e.target.closest(`.${itemClass.split(" ")[0]}`) || e.target.closest(".ac-item");
    if (!row) return;
    e.preventDefault();
    onPick(items[+row.dataset.i]);
    close();
  });

  inputEl.addEventListener("keydown", e => {
    const rows = [...listEl.querySelectorAll(`.${itemClass.split(" ")[0]}`)];
    if (!rows.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hi + 1, rows.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(hi - 1, 0); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (hi >= 0 && items[hi]) { onPick(items[hi]); close(); }
      return;
    } else if (e.key === "Escape") {
      close();
      return;
    } else return;
    rows.forEach((r, i) => r.classList.toggle("hi", i === hi));
    rows[hi] && rows[hi].scrollIntoView({ block: "nearest" });
  });

  inputEl.addEventListener("blur", () => setTimeout(close, 200));
}

/* ============================================================
   INICIALIZACIÓN Y CARGA DE SUPABASE
   ============================================================ */
const AppInit = {
  async boot() {
    loadStateLocal();
    const sb = getSb();
    if (!sb) {
      console.warn("Supabase no está disponible en este momento, usando caché local.");
      return;
    }

    try {
      // 1. Asesores
      const { data: dbAsesores } = await sb.from("asesores").select("nombre").order("nombre");
      STATE.cyp.asesores = (dbAsesores && Array.isArray(dbAsesores)) ? dbAsesores.map(a => a.nombre) : [];

      // 2. Clientes (paginado para cargar todos los miles de registros)
      let allClientes = [];
      let fromC = 0;
      const stepC = 1000;
      let hasMoreC = true;
      while (hasMoreC) {
        const { data: chunkC, error: errC } = await sb.from("clientes")
          .select("nombre, ciudad, nit")
          .order("nombre")
          .range(fromC, fromC + stepC - 1);
        if (errC || !chunkC || !chunkC.length) {
          hasMoreC = false;
        } else {
          allClientes.push(...chunkC);
          if (chunkC.length < stepC) hasMoreC = false;
          else fromC += stepC;
        }
      }
      STATE.cyp.clientes = allClientes.map(c => ({ cliente: c.nombre, ciudad: c.ciudad, nit: c.nit }));

      // 3. Cotizaciones (paginado)
      let allCotizaciones = [];
      let fromCot = 0;
      const stepCot = 1000;
      let hasMoreCot = true;
      while (hasMoreCot) {
        const { data: chunkCot, error: errCot } = await sb.from("cotizaciones")
          .select("*")
          .order("created_at", { ascending: false })
          .range(fromCot, fromCot + stepCot - 1);
        if (errCot || !chunkCot || !chunkCot.length) {
          hasMoreCot = false;
        } else {
          allCotizaciones.push(...chunkCot);
          if (chunkCot.length < stepCot) hasMoreCot = false;
          else fromCot += stepCot;
        }
      }
      STATE.cotizaciones = allCotizaciones.map(c => ({
        numero: c.numero,
        fecha: c.fecha,
        cliente: c.cliente_nombre,
        nit: c.cliente_nit,
        ciudad: c.cliente_ciudad,
        contacto: c.contacto || "",
        asesor: c.asesor_nombre,
        tiempoEntrega: c.tiempo_entrega,
        formaPago: c.forma_pago,
        validez: c.validez,
        observaciones: c.observaciones,
        subtotal: Number(c.subtotal) || 0,
        iva: Number(c.iva) || 0,
        total: Number(c.total) || 0,
        items: c.items || []
      }));

      // 4. Productos
      let allProducts = [];
      let from = 0;
      const step = 1000;
      let hasMore = true;
      let latestUpdated = null;

      while (hasMore) {
        const { data: dbProd, error } = await sb.from("productos").select("codigo, descripcion, iva_pct, existencia, costo, proveedor, updated_at").range(from, from + step - 1);
        if (error || !dbProd || !dbProd.length) {
          hasMore = false;
        } else {
          allProducts.push(...dbProd);
          if (!latestUpdated && dbProd[0] && dbProd[0].updated_at) {
            latestUpdated = dbProd[0].updated_at;
          }
          if (dbProd.length < step) hasMore = false;
          else from += step;
        }
      }

      STATE.datos = allProducts.map(p => [
        p.codigo,
        p.descripcion,
        Number(p.iva_pct) || 0,
        Number(p.existencia) || 0,
        Number(p.costo) || 0,
        p.proveedor || ""
      ]);

      if (latestUpdated) {
        STATE.lastUpdate = latestUpdated;
      } else if (allProducts.length === 0) {
        STATE.lastUpdate = null;
      }

      persistStateLocal();
      console.log(`✅ Conectado a Supabase: ${STATE.datos.length} productos, ${STATE.cyp.clientes.length} clientes, ${STATE.cyp.asesores.length} asesores, ${STATE.cotizaciones.length} cotizaciones.`);
    } catch (e) {
      console.error("Error sincronizando con Supabase:", e);
    }
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => AppInit.boot());
} else {
  AppInit.boot();
}

/* ============================================================
   VISTAS
   ============================================================ */
const Views = {};

/* ---------- 📊 ACTUALIZAR DATOS (RESUMEN EXCLUSIVO) ---------- */
Views.renderActualizarExcel = function () {
  const el = document.getElementById("view-actualizar-excel");
  const totalProd = (STATE.datos || []).length;
  const totalClie = ((STATE.cyp && STATE.cyp.clientes) || []).length;
  const fechaStr = formatFechaHora(STATE.lastUpdate);

  el.innerHTML = `
    <div class="section-head">
      <h2>Estado de la Base de Datos</h2>
      <span class="back" onclick="Router.go('home')">← Volver al inicio</span>
    </div>

    <div class="card">
      <div style="font-size:14.5px;font-weight:700;color:var(--azul-950);margin-bottom:4px">
        Resumen de Datos Disponibles
      </div>
      <div style="font-size:13px;color:var(--texto-suave);line-height:1.45;margin-bottom:16px">
        Información actual sincronizada en la nube (Supabase):
      </div>

      <div class="data-summary-box">
        <div class="data-metric">
          <div class="data-metric-val" id="metricProd">${totalProd.toLocaleString("es-CO")}</div>
          <div class="data-metric-lbl">📦 Productos</div>
        </div>
        <div class="data-metric">
          <div class="data-metric-val" id="metricClie">${totalClie.toLocaleString("es-CO")}</div>
          <div class="data-metric-lbl">👥 Clientes</div>
        </div>
        <div class="data-metric" style="grid-column: span 1;">
          <div class="data-metric-val" id="metricFecha" style="font-size:14.5px;font-weight:700;margin-top:4px;color:var(--teal-700)">${fechaStr}</div>
          <div class="data-metric-lbl" style="margin-top:4px">🕒 Última Actualización</div>
        </div>
      </div>

      <div style="margin-top:20px;padding:14px 16px;background:#f8fafc;border-radius:8px;border:1px solid var(--linea);font-size:13px;color:var(--texto);line-height:1.5">
        ℹ️ <b>¿Cómo actualizar la base de datos?</b><br>
        Descarga los archivos <b>Resumen_de_existencias_UC.xls</b> y <b>Directorio.xls</b> en la carpeta <code>Cotizacion nueva</code> de tu computador y haz doble clic en el archivo <b><code>actualizar.bat</code></b>.
      </div>

      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-accent" id="btnReloadSupabase">🔄 Recargar datos desde Supabase</button>
      </div>
    </div>
  `;

  document.getElementById("btnReloadSupabase").addEventListener("click", async () => {
    const btn = document.getElementById("btnReloadSupabase");
    btn.disabled = true;
    btn.textContent = "Recargando...";
    try {
      await AppInit.boot();
      const pCount = (STATE.datos || []).length;
      const cCount = ((STATE.cyp && STATE.cyp.clientes) || []).length;
      document.getElementById("metricProd").textContent = pCount.toLocaleString("es-CO");
      document.getElementById("metricClie").textContent = cCount.toLocaleString("es-CO");
      document.getElementById("metricFecha").textContent = formatFechaHora(STATE.lastUpdate);
      toast(`Datos recargados: ${pCount} productos y ${cCount} clientes.`);
    } catch (e) {
      toast("Error al conectar con la nube: " + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "🔄 Recargar datos desde Supabase";
    }
  });
};

/* ---------- 👤 ASESORES ---------- */
Views.renderAsesores = function () {
  const el = document.getElementById("view-asesores");
  el.innerHTML = `
    <div class="section-head">
      <h2>Asesores</h2>
      <span class="back" onclick="Router.go('home')">← Volver al inicio</span>
    </div>
    <div class="card">
      <div class="search-bar">
        <input id="asesorNombre" placeholder="Nombre del nuevo asesor..." maxlength="80" autocomplete="off">
        <button class="btn btn-accent" id="addAsesorBtn">+ Agregar</button>
      </div>
      <div id="asesorList"></div>
    </div>
  `;

  let editingIndex = -1;
  let deletingIndex = -1;

  function getAsesoresList() {
    if (!STATE.cyp) STATE.cyp = { clientes: [], asesores: [] };
    if (!Array.isArray(STATE.cyp.asesores)) STATE.cyp.asesores = [];
    return STATE.cyp.asesores;
  }

  async function syncAsesoresToSupabase(nuevoNombre, accion, nombreAntiguo) {
    const sb = getSb();
    if (!sb) return;
    try {
      if (accion === "add") {
        await sb.from("asesores").insert([{ nombre: nuevoNombre }]);
      } else if (accion === "edit") {
        await sb.from("asesores").update({ nombre: nuevoNombre }).eq("nombre", nombreAntiguo);
      } else if (accion === "delete") {
        await sb.from("asesores").delete().eq("nombre", nuevoNombre);
      }
    } catch (e) {
      console.warn("Error sincronizando asesor con Supabase:", e);
    }
  }

  function paintAsesores() {
    const list = document.getElementById("asesorList");
    if (!list) return;
    const asesores = getAsesoresList();

    if (!asesores.length) {
      list.innerHTML = `<div class="empty" style="padding:24px 0">No hay asesores registrados. Agrega uno arriba.</div>`;
      return;
    }

    list.innerHTML = asesores.map((a, i) => {
      if (editingIndex === i) {
        return `
          <div class="list-row" style="grid-template-columns:1fr auto auto;gap:8px;background:#f0f9fa;padding:8px 12px;cursor:default">
            <input id="editAsesorInput_${i}" value="${esc(a)}" maxlength="80" style="padding:6px 10px;font-size:13.5px;font-weight:600" />
            <button class="btn btn-accent" data-save-edit="${i}" style="padding:6px 12px">Guardar</button>
            <button class="btn btn-ghost" data-cancel-edit="${i}" style="padding:6px 12px">Cancelar</button>
          </div>
        `;
      }
      if (deletingIndex === i) {
        return `
          <div class="list-row" style="grid-template-columns:1fr auto auto;gap:8px;background:#fbeae6;padding:8px 12px;cursor:default">
            <span style="color:#c0442c;font-size:13px;font-weight:600">¿Eliminar a "${esc(a)}"?</span>
            <button class="btn btn-danger" data-confirm-del="${i}" style="background:#c0442c;color:#fff;padding:6px 12px">Sí, eliminar</button>
            <button class="btn btn-ghost" data-cancel-del="${i}" style="padding:6px 12px">Cancelar</button>
          </div>
        `;
      }
      return `
        <div class="list-row" style="grid-template-columns:1fr auto auto;gap:8px;cursor:default">
          <span style="font-weight:600;color:var(--azul-950);font-size:14px">${esc(a)}</span>
          <button class="btn btn-ghost" data-edit="${i}" style="padding:6px 14px">Editar</button>
          <button class="btn btn-danger" data-delete="${i}" style="padding:6px 14px">Eliminar</button>
        </div>
      `;
    }).join("");

    if (editingIndex >= 0) {
      const editInp = document.getElementById(`editAsesorInput_${editingIndex}`);
      if (editInp) {
        editInp.focus();
        editInp.select();
        editInp.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            const btn = list.querySelector(`[data-save-edit="${editingIndex}"]`);
            if (btn) btn.click();
          } else if (e.key === "Escape") {
            editingIndex = -1;
            paintAsesores();
          }
        });
      }
    }

    list.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => {
      editingIndex = Number(btn.dataset.edit);
      deletingIndex = -1;
      paintAsesores();
    }));

    list.querySelectorAll("[data-save-edit]").forEach(btn => btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.saveEdit);
      const input = document.getElementById(`editAsesorInput_${i}`);
      const nuevo = input ? input.value.trim() : "";
      if (!nuevo) return toast("El nombre no puede quedar vacío", true);
      const asesoresActuales = [...getAsesoresList()];
      const antiguo = asesoresActuales[i];
      if (asesoresActuales.some((a, j) => j !== i && a.toLowerCase() === nuevo.toLowerCase())) {
        return toast("Ya existe un asesor con ese nombre", true);
      }
      asesoresActuales[i] = nuevo;
      STATE.cyp.asesores = asesoresActuales;
      persistStateLocal();
      editingIndex = -1;
      await syncAsesoresToSupabase(nuevo, "edit", antiguo);
      toast("Asesor actualizado con éxito");
      paintAsesores();
    }));

    list.querySelectorAll("[data-cancel-edit]").forEach(btn => btn.addEventListener("click", () => {
      editingIndex = -1;
      paintAsesores();
    }));

    list.querySelectorAll("[data-delete]").forEach(btn => btn.addEventListener("click", () => {
      deletingIndex = Number(btn.dataset.delete);
      editingIndex = -1;
      paintAsesores();
    }));

    list.querySelectorAll("[data-confirm-del]").forEach(btn => btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.confirmDel);
      const asesoresActuales = [...getAsesoresList()];
      if (i >= 0 && i < asesoresActuales.length) {
        const removed = asesoresActuales.splice(i, 1)[0];
        deletingIndex = -1;
        editingIndex = -1;
        STATE.cyp.asesores = asesoresActuales;
        persistStateLocal();
        await syncAsesoresToSupabase(removed, "delete");
        toast(`Asesor "${removed}" eliminado`);
        paintAsesores();
      }
    }));

    list.querySelectorAll("[data-cancel-del]").forEach(btn => btn.addEventListener("click", () => {
      deletingIndex = -1;
      paintAsesores();
    }));
  }

  const addBtn = document.getElementById("addAsesorBtn");
  const addInput = document.getElementById("asesorNombre");

  async function handleAdd() {
    const nombre = addInput.value.trim();
    if (!nombre) return toast("Escribe el nombre del asesor", true);
    const asesoresActuales = [...getAsesoresList()];
    if (asesoresActuales.some(a => a.toLowerCase() === nombre.toLowerCase())) {
      return toast("Ese asesor ya existe", true);
    }
    asesoresActuales.push(nombre);
    STATE.cyp.asesores = asesoresActuales;
    persistStateLocal();
    addInput.value = "";
    editingIndex = -1;
    deletingIndex = -1;
    await syncAsesoresToSupabase(nombre, "add");
    toast("Asesor agregado correctamente");
    paintAsesores();
    addInput.focus();
  }

  addBtn.addEventListener("click", handleAdd);
  addInput.addEventListener("keydown", e => { if (e.key === "Enter") handleAdd(); });

  paintAsesores();
};

/* ---------- 📁 COTIZACIONES GUARDADAS (BÚSQUEDA Y FILTRO INTERACTIVO) ---------- */
Views.renderGuardadas = function () {
  const el = document.getElementById("view-guardadas");

  el.innerHTML = `
    <div class="section-head">
      <h2>Cotizaciones guardadas</h2>
      <span class="back" onclick="Router.go('home')">← Volver al inicio</span>
    </div>
    <div class="card">
      <div class="search-bar">
        <input id="cotSearch" placeholder="Buscar por N.°, cliente o asesor..." autocomplete="off">
      </div>
      <div class="list-row head" id="cotHeaderRow">
        <span data-sort="numero">N.° <b class="sort-ic"></b></span>
        <span data-sort="cliente">Cliente <b class="sort-ic"></b></span>
        <span data-sort="fecha">Fecha <b class="sort-ic"></b></span>
        <span data-sort="asesor">Asesor <b class="sort-ic"></b></span>
        <span data-sort="total" style="text-align:right">Total <b class="sort-ic"></b></span>
      </div>
      <div id="cotList"></div>
    </div>
  `;

  let sortCol = "numero";
  let sortAsc = false;
  let currentSearch = "";

  function paint() {
    const list = document.getElementById("cotList");
    if (!list) return;

    let cots = DB.getCotizaciones().slice();
    const q = currentSearch.trim().toLowerCase();

    // Filtro por N.°, Cliente o Asesor
    if (q) {
      cots = cots.filter(c =>
        (c.numero || "").toLowerCase().includes(q) ||
        (c.cliente || "").toLowerCase().includes(q) ||
        (c.asesor || "").toLowerCase().includes(q)
      );
    }

    // Ordenamiento por columna
    cots.sort((a, b) => {
      let res = 0;
      if (sortCol === "numero") {
        res = String(a.numero || "").localeCompare(String(b.numero || ""), undefined, { numeric: true });
      } else if (sortCol === "cliente") {
        res = String(a.cliente || "").localeCompare(String(b.cliente || ""));
      } else if (sortCol === "fecha") {
        res = String(a.fecha || "").localeCompare(String(b.fecha || ""));
      } else if (sortCol === "asesor") {
        res = String(a.asesor || "").localeCompare(String(b.asesor || ""));
      } else if (sortCol === "total") {
        res = (Number(a.total) || 0) - (Number(b.total) || 0);
      }
      return sortAsc ? res : -res;
    });

    // Actualizar iconos de cabecera
    document.querySelectorAll("#cotHeaderRow span[data-sort]").forEach(sp => {
      const col = sp.dataset.sort;
      const ic = sp.querySelector(".sort-ic");
      if (col === sortCol) {
        sp.classList.add("sorted");
        if (ic) ic.textContent = sortAsc ? " ▲" : " ▼";
      } else {
        sp.classList.remove("sorted");
        if (ic) ic.textContent = "";
      }
    });

    if (!cots.length) {
      list.innerHTML = `<div class="empty"><div class="ic">🔍</div>Sin resultados</div>`;
      return;
    }

    list.innerHTML = cots.map(c => `
      <div class="list-row" data-numero="${esc(c.numero)}">
        <span class="n">${esc(c.numero)}</span>
        <span>${esc(c.cliente || "—")}</span>
        <span>${esc(c.fecha || "")}</span>
        <span>${esc(c.asesor || "—")}</span>
        <span style="font-family:var(--mono);font-weight:700;color:var(--azul-950);text-align:right">${fmtCOP(c.total)}</span>
      </div>
    `).join("");

    list.querySelectorAll(".list-row[data-numero]").forEach(row => {
      row.addEventListener("click", () => Router.go("nueva", { record: row.dataset.numero }));
    });
  }

  // Eventos de ordenamiento en cabeceras
  document.querySelectorAll("#cotHeaderRow span[data-sort]").forEach(sp => {
    sp.addEventListener("click", () => {
      const col = sp.dataset.sort;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = true;
      }
      paint();
    });
  });

  const searchInput = document.getElementById("cotSearch");
  searchInput.addEventListener("input", e => {
    currentSearch = e.target.value;
    paint();
  });

  paint();
};

/* ---------- 📝 NUEVA / EDITAR COTIZACIÓN ---------- */
Views.renderNueva = function (numeroToLoad) {
  const el = document.getElementById("view-nueva");
  const existing = numeroToLoad ? DB.getCotizaciones().find(c => c.numero === numeroToLoad) : null;
  const isEdit = !!existing;
  const source = isEdit ? existing : null;
  const numeroDisplay = isEdit ? existing.numero : "Se asigna al guardar";
  const hoy = new Date().toISOString().slice(0, 10);

  Cotizador._editingNumero = isEdit ? existing.numero : null;

  const defaultObs =
    "Favor consignar a: Bancolombia – Cuenta de Ahorros N.º 72600001670, a nombre de Representaciones M&M Medical SAS.\n\n" +
    "No somos grandes contribuyentes ni autorretenedores de renta.\n\n" +
    "Somos grandes contribuyentes de ICA en Bucaramanga – Res. 1017 del 31/05/2021. Favor no practicar ReteICA en otros municipios.";

  el.innerHTML = `
    <div class="section-head">
      <h2>${isEdit ? `Cotización ${esc(existing.numero)} <span style="font-size:12px;font-weight:700;color:var(--teal-700);background:#e6f6f8;padding:3px 10px;border-radius:12px;margin-left:8px;vertical-align:middle">Editando</span>` : "Nueva cotización"}</h2>
      <span class="back" onclick="Router.go('home')">← Volver al inicio</span>
    </div>

    <div class="card">
      <div class="grid g4">
        <div><label>N.°</label><input value="${numeroDisplay}" disabled style="font-family:var(--mono);background:#f3f4f3;font-weight:700;color:var(--azul-950)"></div>
        <div><label>Fecha</label><input id="f_fecha" type="date" value="${source ? source.fecha : hoy}"></div>
        <div class="field">
          <label>Cliente *</label>
          <input id="f_cliente" autocomplete="off" value="${esc(source ? source.cliente || "" : "")}" placeholder="Buscar o escribir cliente...">
          <div class="ac-list" id="ac_cliente"></div>
        </div>
        <div><label>Asesor *</label>
          <select id="f_asesor">
            <option value="">Selecciona asesor…</option>
            ${DB.getCYP().asesores.map(a => `<option value="${esc(a)}" ${source && source.asesor === a ? "selected" : ""}>${esc(a)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="grid g3" style="margin-top:14px">
        <div><label>NIT</label><input id="f_nit" value="${esc(source ? source.nit || "" : "")}" placeholder="Automático o escribir"></div>
        <div><label>Ciudad</label><input id="f_ciudad" value="${esc(source ? source.ciudad || "" : "")}" placeholder="Automático o escribir"></div>
        <div><label>Contacto</label><input id="f_contacto" value="${esc(source ? source.contacto || "" : "")}" placeholder="Persona de contacto"></div>
      </div>
      <div class="grid g3" style="margin-top:14px">
        <div>
          <label>Tiempo de entrega</label>
          <input id="f_tiempo" list="opciones_tiempo" value="${esc(source ? source.tiempoEntrega || "Inmediata" : "Inmediata")}" autocomplete="new-password" placeholder="Selecciona o escribe...">
          <datalist id="opciones_tiempo">
            <option value="Inmediata">
            <option value="De 3 a 5 días hábiles">
            <option value="De 8 a 15 días hábiles">
            <option value="De 15 a 20 días hábiles">
            <option value="De 20 a 30 días hábiles">
          </datalist>
        </div>
        <div>
          <label>Forma de pago</label>
          <input id="f_pago" list="opciones_pago" value="${esc(source ? source.formaPago || "Contado" : "Contado")}" autocomplete="new-password" placeholder="Selecciona o escribe...">
          <datalist id="opciones_pago">
            <option value="Contado">
            <option value="Crédito 15 días">
            <option value="Crédito 30 días">
            <option value="Crédito 60 días">
            <option value="50% Anticipo, 50% Contraentrega">
          </datalist>
        </div>
        <div><label>Validez de la oferta</label><input id="f_validez" value="${esc(source ? source.validez || "15 días" : "15 días")}"></div>
      </div>
    </div>

    <div class="card">
      <div class="section-head" style="margin-bottom:12px"><h3 style="margin:0;font-size:15px;color:var(--azul-950)">Productos</h3>
        <button class="btn btn-accent" onclick="ItemsUI.add()">+ Agregar producto</button></div>
      <div class="items-table-wrap"><table class="items-table">
        <thead><tr>
          <th class="col-cod">Código</th>
          <th class="col-desc">Descripción</th>
          <th class="col-cant">Cant.</th>
          <th class="col-vu">Vr. unit.</th>
          <th class="col-iva">IVA %</th>
          <th class="col-vi">Valor IVA</th>
          <th class="col-vt">Valor total</th>
          <th class="col-util">% Util.</th>
          <th class="col-costo">Costo</th>
          <th class="col-prov">Proveedor</th>
          <th class="col-rm"></th>
        </tr></thead>
        <tbody id="itemsBody"></tbody>
      </table></div>
      <div class="totals">
        <table>
          <tr><td>Subtotal</td><td id="t_subtotal">$0</td></tr>
          <tr><td>IVA</td><td id="t_iva">$0</td></tr>
          <tr class="total"><td>TOTAL</td><td id="t_total">$0</td></tr>
        </table>
      </div>
    </div>

    <div class="card">
      <label>Observaciones</label>
      <textarea id="f_obs">${esc(source ? source.observaciones || defaultObs : defaultObs)}</textarea>
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="Cotizador.save(false)">${isEdit ? "Guardar cambios" : "Guardar cotización"}</button>
      <button class="btn btn-accent" onclick="Cotizador.save(true)">${isEdit ? "Guardar cambios y descargar PDF" : "Guardar y generar PDF"}</button>
      ${isEdit ? `<button class="btn btn-danger" id="btnEliminar">Eliminar cotización</button>` : ""}
      <button class="btn btn-ghost" onclick="Router.go('guardadas')" style="margin-left:auto">Ver cotizaciones guardadas</button>
    </div>
  `;

  if (isEdit && source && source.items && source.items.length) {
    ItemsUI.items = JSON.parse(JSON.stringify(source.items));
  } else {
    ItemsUI.items = [{ codigo: "", descripcion: "", cantidad: 1, vrUnitario: 0, ivaPct: 0.19, costo: 0, porcentaje: 0.25 }];
  }
  ItemsUI.paint();

  const btnEliminar = document.getElementById("btnEliminar");
  if (btnEliminar && isEdit) {
    btnEliminar.addEventListener("click", () => Cotizador.remove(existing.numero));
  }

  attachAutocomplete(
    document.getElementById("f_cliente"), document.getElementById("ac_cliente"),
    q => DB.getCYP().clientes.filter(c => (c.cliente && c.cliente.toLowerCase().includes(q)) || (c.nit && c.nit.toLowerCase().includes(q))),
    c => `<div class="c1">${esc(c.cliente)}</div><div class="c2">${esc(c.nit || "")} · ${esc(c.ciudad || "")}</div>`,
    c => {
      document.getElementById("f_cliente").value = c.cliente;
      document.getElementById("f_nit").value = c.nit || "";
      document.getElementById("f_ciudad").value = c.ciudad || "";
    }
  );
};

/* ---------- ITEMS UI ---------- */
const ItemsUI = { items: [] };
ItemsUI.add = function () {
  this.items.push({ codigo: "", descripcion: "", cantidad: 1, vrUnitario: 0, ivaPct: 0.19, costo: 0, porcentaje: 0.25 });
  this.paint();
};
ItemsUI.remove = function (i) {
  this.items.splice(i, 1);
  if (!this.items.length) {
    this.items.push({ codigo: "", descripcion: "", cantidad: 1, vrUnitario: 0, ivaPct: 0.19, costo: 0, porcentaje: 0.25 });
  }
  this.paint();
};
ItemsUI.paint = function () {
  const body = document.getElementById("itemsBody");
  if (!body) return;

  body.innerHTML = this.items.map((it, i) => `
    <tr>
      <td>
        <input class="it-codigo" data-i="${i}" value="${esc(it.codigo)}" placeholder="Código..." autocomplete="off">
        <div class="ac-list ac-products" id="ac_item_cod_${i}"></div>
      </td>
      <td>
        <input class="it-desc" data-i="${i}" value="${esc(it.descripcion)}" placeholder="Descripción del producto..." autocomplete="off">
        <div class="ac-list ac-products" id="ac_item_desc_${i}"></div>
      </td>
      <td><input class="it-cant num" data-i="${i}" type="number" min="1" step="1" value="${it.cantidad != null ? it.cantidad : 1}"></td>
      <td><input class="it-vu num" data-i="${i}" type="number" min="0" step="1" value="${Math.round(it.vrUnitario || 0)}"></td>
      <td><input class="it-iva num" data-i="${i}" type="number" min="0" step="1" value="${Math.round((it.ivaPct || 0) * 100)}"></td>
      <td class="num" id="it-vi-${i}">${fmtCOP(0)}</td>
      <td class="num" id="it-vt-${i}">${fmtCOP(0)}</td>
      <td><input class="it-util num" data-i="${i}" type="number" min="0" step="1" value="${Math.round((it.porcentaje != null ? it.porcentaje : 0.25) * 100)}"></td>
      <td><input class="it-costo num" data-i="${i}" type="number" min="0" step="1" value="${Math.round(it.costo || 0)}"></td>
      <td><input class="it-prov" data-i="${i}" value="${esc(it.proveedor || "")}" placeholder="Proveedor"></td>
      <td style="text-align:center"><button class="rm" onclick="ItemsUI.remove(${i})" title="Eliminar fila">✕</button></td>
    </tr>
  `).join("");

  this.items.forEach((it, i) => {
    const codInput = body.querySelector(`.it-codigo[data-i="${i}"]`);
    const descInput = body.querySelector(`.it-desc[data-i="${i}"]`);
    const acCodList = document.getElementById(`ac_item_cod_${i}`);
    const acDescList = document.getElementById(`ac_item_desc_${i}`);

    const onPickProduct = d => {
      const util = this.items[i].porcentaje != null ? this.items[i].porcentaje : 0.25;
      let ivaPct = Number(d[2]) || 0;
      if (ivaPct > 1) ivaPct = ivaPct / 100;
      this.items[i].codigo = d[0] || "";
      this.items[i].descripcion = d[1] || "";
      this.items[i].ivaPct = ivaPct;
      this.items[i].costo = Number(d[4]) || 0;
      this.items[i].proveedor = d[5] || "";
      this.items[i].porcentaje = util;
      this.items[i].vrUnitario = Math.round((Number(d[4]) || 0) * (1 + util));
      this.paint();
    };

    const renderProductItem = d => `
      <div class="ac-prod-top">
        <span class="ac-badge-code">${esc(d[0])}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="ac-badge-iva">IVA ${Math.round(((Number(d[2]) > 1 ? Number(d[2]) : Number(d[2]) * 100)) || 0)}%</span>
          ${d[4] ? `<span class="ac-badge-costo">Costo: ${fmtCOP(d[4])}</span>` : ""}
        </div>
      </div>
      <div class="ac-prod-name">${esc(d[1])}</div>
      ${d[5] ? `<div class="ac-prod-prov">Proveedor: <b>${esc(d[5])}</b></div>` : ""}
    `;

    const getProducts = q => {
      const datos = DB.getDatos();
      return datos.filter(d => (d[0] && String(d[0]).toLowerCase().includes(q)) || (d[1] && String(d[1]).toLowerCase().includes(q)));
    };

    if (codInput && acCodList) attachAutocomplete(codInput, acCodList, getProducts, renderProductItem, onPickProduct, "ac-prod-card");
    if (descInput && acDescList) attachAutocomplete(descInput, acDescList, getProducts, renderProductItem, onPickProduct, "ac-prod-card");

    body.querySelector(`.it-desc[data-i="${i}"]`).addEventListener("input", e => { this.items[i].descripcion = e.target.value; });
    body.querySelector(`.it-codigo[data-i="${i}"]`).addEventListener("input", e => { this.items[i].codigo = e.target.value; });
    body.querySelector(`.it-cant[data-i="${i}"]`).addEventListener("input", e => { this.items[i].cantidad = parseNum(e.target.value); this.recalc(); });
    body.querySelector(`.it-vu[data-i="${i}"]`).addEventListener("input", e => { this.items[i].vrUnitario = parseNum(e.target.value); this.recalc(); });
    body.querySelector(`.it-iva[data-i="${i}"]`).addEventListener("input", e => { this.items[i].ivaPct = parseNum(e.target.value) / 100; this.recalc(); });
    body.querySelector(`.it-costo[data-i="${i}"]`).addEventListener("input", e => {
      this.items[i].costo = parseNum(e.target.value);
      const util = this.items[i].porcentaje != null ? this.items[i].porcentaje : 0.25;
      this.items[i].vrUnitario = Math.round(this.items[i].costo * (1 + util));
      const vuInput = body.querySelector(`.it-vu[data-i="${i}"]`);
      if (vuInput) vuInput.value = this.items[i].vrUnitario;
      this.recalc();
    });
    body.querySelector(`.it-prov[data-i="${i}"]`).addEventListener("input", e => { this.items[i].proveedor = e.target.value; });
    body.querySelector(`.it-util[data-i="${i}"]`).addEventListener("input", e => {
      this.items[i].porcentaje = parseNum(e.target.value) / 100;
      if (this.items[i].costo) {
        this.items[i].vrUnitario = Math.round(this.items[i].costo * (1 + this.items[i].porcentaje));
        const vuInput = body.querySelector(`.it-vu[data-i="${i}"]`);
        if (vuInput) vuInput.value = Math.round(this.items[i].vrUnitario);
      }
      this.recalc();
    });
  });
  this.recalc();
};

ItemsUI.recalc = function () {
  let subtotal = 0, iva = 0;
  this.items.forEach((it, i) => {
    const cant = Number(it.cantidad) || 0;
    const vu = Number(it.vrUnitario) || 0;
    const ivaPct = Number(it.ivaPct) || 0;
    const vt = cant * vu;
    const vi = vt * ivaPct;
    subtotal += vt;
    iva += vi;
    const eVi = document.getElementById(`it-vi-${i}`);
    const eVt = document.getElementById(`it-vt-${i}`);
    if (eVi) eVi.textContent = fmtCOP(vi);
    if (eVt) eVt.textContent = fmtCOP(vt);
  });
  const eSub = document.getElementById("t_subtotal");
  const eIva = document.getElementById("t_iva");
  const eTot = document.getElementById("t_total");
  if (eSub) eSub.textContent = fmtCOP(subtotal);
  if (eIva) eIva.textContent = fmtCOP(iva);
  if (eTot) eTot.textContent = fmtCOP(subtotal + iva);
};

/* ============================================================
   COTIZADOR — GUARDAR EN SUPABASE & GENERAR PDF
   ============================================================ */
const Cotizador = {
  _editingNumero: null,

  collect() {
    return {
      cliente: (document.getElementById("f_cliente") ? document.getElementById("f_cliente").value : "").trim(),
      nit: (document.getElementById("f_nit") ? document.getElementById("f_nit").value : "").trim(),
      ciudad: (document.getElementById("f_ciudad") ? document.getElementById("f_ciudad").value : "").trim(),
      contacto: (document.getElementById("f_contacto") ? document.getElementById("f_contacto").value : "").trim(),
      tiempoEntrega: (document.getElementById("f_tiempo") ? document.getElementById("f_tiempo").value : "").trim(),
      formaPago: (document.getElementById("f_pago") ? document.getElementById("f_pago").value : "").trim(),
      validez: (document.getElementById("f_validez") ? document.getElementById("f_validez").value : "").trim(),
      asesor: (document.getElementById("f_asesor") ? document.getElementById("f_asesor").value : "").trim(),
      fecha: (document.getElementById("f_fecha") ? document.getElementById("f_fecha").value : "").trim(),
      observaciones: document.getElementById("f_obs") ? document.getElementById("f_obs").value : ""
    };
  },

  validate(data, withPdf) {
    document.querySelectorAll("#view-nueva .err").forEach(e => e.classList.remove("err"));

    if (!withPdf) {
      // Para guardar borrador/cotización: SOLO Cliente y Asesor son obligatorios
      const missing = [];
      if (!data.cliente) {
        missing.push("Cliente");
        const el = document.getElementById("f_cliente");
        if (el) el.classList.add("err");
      }
      if (!data.asesor) {
        missing.push("Asesor");
        const el = document.getElementById("f_asesor");
        if (el) el.classList.add("err");
      }
      return missing;
    } else {
      // Para generar PDF: TODOS los campos son obligatorios
      const required = {
        cliente: "Cliente",
        contacto: "Contacto",
        tiempoEntrega: "Tiempo de entrega",
        formaPago: "Forma de pago",
        validez: "Validez de la oferta",
        asesor: "Asesor"
      };
      const map = {
        cliente: "f_cliente",
        contacto: "f_contacto",
        tiempoEntrega: "f_tiempo",
        formaPago: "f_pago",
        validez: "f_validez",
        asesor: "f_asesor"
      };
      const missing = [];
      for (const key in required) {
        if (!data[key]) {
          missing.push(required[key]);
          const el = document.getElementById(map[key]);
          if (el) el.classList.add("err");
        }
      }
      return missing;
    }
  },

  async save(withPdf) {
    const data = this.collect();
    const missing = this.validate(data, withPdf);

    if (missing.length) {
      if (withPdf) {
        return toast("Para generar el PDF debes completar: " + missing.join(", "), true);
      } else {
        return toast("Falta completar: " + missing.join(", "), true);
      }
    }

    const items = ItemsUI.items.filter(it => (it.codigo && String(it.codigo).trim()) || (it.descripcion && String(it.descripcion).trim()));
    if (withPdf && !items.length) {
      return toast("Para generar el PDF debes agregar al menos un producto a la cotización", true);
    }

    let subtotal = 0, iva = 0;
    items.forEach(it => {
      const cant = Number(it.cantidad) || 0;
      const vu = Number(it.vrUnitario) || 0;
      const ivaP = Number(it.ivaPct) || 0;
      const vt = cant * vu;
      subtotal += vt;
      iva += vt * ivaP;
    });

    const isEdit = !!this._editingNumero;
    let numero = this._editingNumero;
    if (!numero) {
      const seq = DB.nextNumero();
      numero = seq.preview;
    }

    const record = { numero, ...data, items, subtotal, iva, total: subtotal + iva };

    const all = [...DB.getCotizaciones()];
    const idx = all.findIndex(c => c.numero === numero);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    DB.setCotizaciones(all);

    this._editingNumero = null;
    DRAFT = null;
    persistStateLocal();

    const sb = getSb();
    if (sb) {
      try {
        const { error } = await sb.from("cotizaciones").upsert({
          numero: record.numero,
          fecha: record.fecha,
          cliente_nombre: record.cliente,
          cliente_nit: record.nit,
          cliente_ciudad: record.ciudad,
          asesor_nombre: record.asesor,
          tiempo_entrega: record.tiempoEntrega,
          forma_pago: record.formaPago,
          validez: record.validez,
          observaciones: record.observaciones,
          subtotal: record.subtotal,
          iva: record.iva,
          total: record.total,
          items: record.items,
          updated_at: new Date().toISOString()
        }, { onConflict: "numero" });
        if (error) console.warn("Advertencia al guardar en Supabase:", error);
      } catch (e) {
        console.warn("Error guardando en Supabase:", e);
      }
    }

    toast(isEdit ? `Cotización ${numero} actualizada` : `Cotización ${numero} guardada`);

    if (withPdf) {
      await this.writePdf(record);
    }

    Router.go("guardadas");
  },

  async remove(numero) {
    DB.setCotizaciones(DB.getCotizaciones().filter(c => c.numero !== numero));
    const sb = getSb();
    if (sb) {
      try {
        await sb.from("cotizaciones").delete().eq("numero", numero);
      } catch (e) {
        console.warn("Error eliminando en Supabase:", e);
      }
    }
    toast(`Cotización ${numero} eliminada`);
    Router.go("guardadas");
  },

  async writePdf(record) {
    let blob;
    try {
      blob = PdfBuilder.build(record);
    } catch (e) {
      console.error(e);
      return toast("No se pudo generar el PDF: " + e.message, true);
    }

    const filename = `Cotizacion_${record.numero}.pdf`;

    // Subir a Supabase Storage (acceso compartido todos los usuarios)
    const sb = getSb();
    if (sb) {
      try {
        await sb.storage.from("cotizaciones-pdf").upload(filename, blob, { upsert: true });
      } catch (e) {
        console.warn("Error subiendo PDF a Supabase Storage:", e);
      }
    }

    // Guardar en carpeta local (File System Access API) o descarga normal
    const savedToFolder = await FolderSaver.saveBlob(blob, filename);
    if (savedToFolder) {
      toast(`✅ PDF guardado en tu carpeta configurada`);
    } else {
      toast(`PDF de cotización ${record.numero} descargado`);
    }
  }
};

/* ============================================================
   GENERADOR DE PDF (jsPDF) — diseño profesional y limpio
   ============================================================ */
const PdfBuilder = {
  build(r) {
    const { jsPDF } = window.jspdf;
    const pageW = 595.28;
    const probe = new jsPDF({ unit: "pt", format: [pageW, 3000], orientation: "p" });
    const finalY = this.renderContent(probe, r, pageW);
    const minH = 841.89;
    const finalH = Math.max(finalY + 30, minH);
    const doc = new jsPDF({ unit: "pt", format: [pageW, finalH], orientation: "p" });
    this.renderContent(doc, r, pageW);
    return doc.output("blob");
  },

  renderContent(doc, r, pageW) {
    const M = 36;
    const contentW = pageW - 2 * M;
    const navy = [27, 58, 107];
    const bgBadge = [238, 242, 247];
    const bgPanel = [250, 251, 252];
    const bgZebra = [247, 249, 251];
    const border = [214, 222, 232];
    const borderSoft = [230, 234, 240];
    const textDark = [43, 43, 43];
    const textMuted = [102, 102, 102];
    const labelKey = [138, 148, 163];
    const footerColor = [154, 163, 177];

    let y = 28;

    // 1. ENCABEZADO: Logo + Información de la empresa
    const logoW = 120, logoH = 48;
    try {
      if (typeof LOGO_B64 !== "undefined") {
        doc.addImage(LOGO_B64, "PNG", M, y + 2, logoW, logoH);
      }
    } catch (e) {}

    const infoX = M + logoW + 12;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...navy);
    doc.text("REPRESENTACIONES M&M MEDICAL SAS", infoX, y + 10);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...textMuted);
    const compLines = [
      "NIT: 901265748-6",
      "Calle 32 # 29 - 17 Barrio La Aurora, Bucaramanga - Santander",
      "Tel: 3153761841 - 3045393418 - 3162230465",
      "ventas.representacionesmym@gmail.com",
      "www.representacionesmymmedical.com"
    ];
    compLines.forEach((line, idx) => {
      doc.text(line, infoX, y + 21 + idx * 9.5);
    });

    // Badge Cotización
    const badgeW = 120;
    const badgeX = pageW - M - badgeW;
    const badgeY = y;

    doc.setFillColor(...navy);
    doc.roundedRect(badgeX, badgeY, badgeW, 20, 3, 3, "F");
    doc.rect(badgeX, badgeY + 16, badgeW, 4, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("COTIZACIÓN", badgeX + badgeW / 2, badgeY + 14, { align: "center" });

    doc.setFillColor(...bgBadge);
    doc.setDrawColor(...border);
    doc.setLineWidth(0.8);
    doc.rect(badgeX, badgeY + 20, badgeW, 20, "FD");
    doc.setTextColor(...navy);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text(String(r.numero || "C-2026-1"), badgeX + badgeW / 2, badgeY + 34, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...textMuted);
    doc.text("Fecha: " + (r.fecha || ""), badgeX + badgeW, badgeY + 52, { align: "right" });

    y += 66;

    // Línea divisoria azul
    doc.setDrawColor(...navy);
    doc.setLineWidth(2);
    doc.line(M, y, pageW - M, y);
    y += 12;

    // 2. PANEL DE INFORMACIÓN DEL CLIENTE (Anchos optimizados para evitar textos cortados)
    const clientCells = [
      { label: "CLIENTE", value: r.cliente || "—", w: contentW * 0.34 },
      { label: "NIT", value: r.nit || "—", w: contentW * 0.18 },
      { label: "CIUDAD", value: r.ciudad || "—", w: contentW * 0.26 },
      { label: "CONTACTO", value: r.contacto || "—", w: contentW * 0.22 }
    ];
    y = this.renderPanel(doc, clientCells, M, y, contentW, bgPanel, border, labelKey, textDark);
    y += 8;

    // 3. CONDICIONES COMERCIALES
    const termsCells = [
      { label: "TIEMPO DE ENTREGA", value: r.tiempoEntrega || "Inmediata", w: contentW * 0.34 },
      { label: "FORMA DE PAGO", value: r.formaPago || "Contado", w: contentW * 0.33 },
      { label: "VALIDEZ DE LA OFERTA", value: r.validez || "30 días", w: contentW * 0.33 }
    ];
    y = this.renderPanel(doc, termsCells, M, y, contentW, bgPanel, border, labelKey, textDark);
    y += 14;

    // 4. TABLA DE PRODUCTOS
    const cols = [
      { key: "codigo", label: "CÓDIGO", w: 58, align: "center" },
      { key: "descripcion", label: "DESCRIPCIÓN", w: contentW - 58 - 36 - 72 - 42 - 76, align: "left" },
      { key: "cantidad", label: "CANT.", w: 36, align: "center" },
      { key: "vrUnitario", label: "VR. UNITARIO", w: 72, align: "right" },
      { key: "ivaPct", label: "IVA %", w: 42, align: "center" },
      { key: "valorTotal", label: "VR. TOTAL", w: 76, align: "right" }
    ];

    doc.setFillColor(...navy);
    doc.roundedRect(M, y, contentW, 20, 3, 3, "F");
    doc.rect(M, y + 15, contentW, 5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);

    let curX = M;
    cols.forEach(c => {
      let tx = curX + 6;
      if (c.align === "center") tx = curX + c.w / 2;
      else if (c.align === "right") tx = curX + c.w - 6;
      doc.text(c.label, tx, y + 13, { align: c.align });
      curX += c.w;
    });
    y += 20;

    const items = Array.isArray(r.items) ? r.items : [];
    doc.setLineWidth(0.6);

    items.forEach((it, idx) => {
      const vt = (Number(it.cantidad) || 0) * (Number(it.vrUnitario) || 0);
      const isEven = idx % 2 === 1;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      const descLines = doc.splitTextToSize(String(it.descripcion || ""), cols[1].w - 12);
      const rowH = Math.max(18, 8 + descLines.length * 10);

      if (isEven) {
        doc.setFillColor(...bgZebra);
        doc.rect(M, y, contentW, rowH, "F");
      }

      doc.setDrawColor(...borderSoft);
      doc.line(M, y + rowH, pageW - M, y + rowH);

      curX = M;
      doc.setTextColor(...textDark);

      doc.text(String(it.codigo || ""), curX + cols[0].w / 2, y + 12, { align: "center" });
      curX += cols[0].w;

      doc.text(descLines, curX + 6, y + 12);
      curX += cols[1].w;

      doc.text(String(it.cantidad || 0), curX + cols[2].w / 2, y + 12, { align: "center" });
      curX += cols[2].w;

      doc.text(fmtCOP(it.vrUnitario), curX + cols[3].w - 6, y + 12, { align: "right" });
      curX += cols[3].w;

      const ivaStr = Math.round((Number(it.ivaPct) || 0) * 100) + "%";
      doc.text(ivaStr, curX + cols[4].w / 2, y + 12, { align: "center" });
      curX += cols[4].w;

      doc.text(fmtCOP(vt), curX + cols[5].w - 6, y + 12, { align: "right" });

      y += rowH;
    });

    y += 8;

    // 5. TOTALES
    const totW = 195;
    const totX = pageW - M - totW;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...textDark);
    doc.text("Subtotal:", totX + 10, y + 12);
    doc.text(fmtCOP(r.subtotal), totX + totW - 10, y + 12, { align: "right" });
    y += 16;

    doc.text("IVA:", totX + 10, y + 12);
    doc.text(fmtCOP(r.iva), totX + totW - 10, y + 12, { align: "right" });
    y += 16;

    doc.setDrawColor(...border);
    doc.setLineWidth(0.8);
    doc.line(totX, y, totX + totW, y);
    y += 3;

    doc.setFillColor(...navy);
    doc.roundedRect(totX, y, totW, 22, 3, 3, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text("TOTAL:", totX + 12, y + 15);
    doc.text(fmtCOP(r.total), totX + totW - 12, y + 15, { align: "right" });
    y += 34;

    // 6. OBSERVACIONES + FIRMA
    const obsW = contentW * 0.58;
    const firW = contentW - obsW - 12;
    const boxTop = y;

    const defaultObs =
      "Favor consignar a: Bancolombia – Cuenta de Ahorros N.º 72600001670, a nombre de Representaciones M&M Medical SAS.\n\n" +
      "No somos grandes contribuyentes ni autorretenedores de renta.\n\n" +
      "Somos grandes contribuyentes de ICA en Bucaramanga – Res. 1017 del 31/05/2021. Favor no practicar ReteICA en otros municipios.";

    const obsText = (r.observaciones && r.observaciones.trim()) || defaultObs;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.6);
    const obsLines = doc.splitTextToSize(obsText, obsW - 20);
    const obsH = Math.max(92, 24 + obsLines.length * 10);

    doc.setFillColor(...bgPanel);
    doc.setDrawColor(...border);
    doc.setLineWidth(0.8);
    doc.roundedRect(M, boxTop, obsW, obsH, 4, 4, "FD");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...navy);
    doc.text("OBSERVACIONES Y CONDICIONES", M + 10, boxTop + 14);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.6);
    doc.setTextColor(...textDark);
    doc.text(obsLines, M + 10, boxTop + 26);

    const firX = M + obsW + 12;
    doc.setFillColor(...bgPanel);
    doc.setDrawColor(...border);
    doc.setLineWidth(0.8);
    doc.roundedRect(firX, boxTop, firW, obsH, 4, 4, "FD");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...textMuted);
    doc.text("Cordialmente,", firX + 12, boxTop + 24);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...navy);
    doc.text(String(r.asesor || "Equipo de Ventas"), firX + 12, boxTop + 52);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...textMuted);
    doc.text("Representaciones M&M Medical SAS", firX + 12, boxTop + 65);

    y = boxTop + obsH + 16;

    // 7. PIE DE PÁGINA
    doc.setDrawColor(...borderSoft);
    doc.setLineWidth(0.6);
    doc.line(M, y, pageW - M, y);

    y += 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...footerColor);
    doc.text(
      "Representaciones M&M Medical SAS · Bucaramanga, Colombia · Documento generado electrónicamente",
      pageW / 2,
      y,
      { align: "center" }
    );

    return y + 10;
  },

  renderPanel(doc, cells, x0, y0, totalW, bgColor, borderColor, labelColor, valColor) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const wrapped = cells.map(c => doc.splitTextToSize(String(c.value || "—"), c.w - 12));
    const maxLines = Math.max(1, ...wrapped.map(l => l.length));
    const h = 18 + maxLines * 11;

    doc.setFillColor(...bgColor);
    doc.setDrawColor(...borderColor);
    doc.setLineWidth(0.8);
    doc.roundedRect(x0, y0, totalW, h, 4, 4, "FD");

    let curX = x0;
    cells.forEach((c, idx) => {
      if (idx > 0) {
        doc.setDrawColor(...borderColor);
        doc.line(curX, y0, curX, y0 + h);
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.2);
      doc.setTextColor(...labelColor);
      doc.text(c.label, curX + 6, y0 + 11);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.8);
      doc.setTextColor(...valColor);
      doc.text(wrapped[idx], curX + 6, y0 + 23);

      curX += c.w;
    });

    return y0 + h;
  }
};

window.Router = Router;
window.Cotizador = Cotizador;
window.ItemsUI = ItemsUI;
window.Views = Views;
window.DB = DB;
window.AppInit = AppInit;