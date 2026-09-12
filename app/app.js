/* ============================================================
   COTIZADOR M&M MEDICAL — app de escritorio (Electron)
   Los datos de productos y clientes/asesores SOLO se actualizan
   desde el Excel (macro). La app los lee automáticamente de la
   carpeta donde está instalada. Las cotizaciones y su secuencia
   se guardan localmente (estado_app.json) y solo se abren desde
   aquí — no se genera ningún archivo editable en disco.
   ============================================================ */

let STATE = { datos: [], cyp: { clientes: [], asesores: [] }, cotizaciones: [], seq: {} };
let PATHS = { datosDir: "", pdfDir: "", editableDir: "" };
let DRAFT = null;

function persistState() { window.api.storeSet(STATE); }

const DB = {
  getDatos() { return STATE.datos || []; },
  getCYP() { return STATE.cyp || { clientes: [], asesores: [] }; },
  getCotizaciones() { return STATE.cotizaciones || []; },
  setCotizaciones(v) { STATE.cotizaciones = v; persistState(); },
  nextNumero() {
    const year = new Date().getFullYear();
    const seq = STATE.seq || {};
    const n = (seq[year] || 0) + 1;
    return { preview: `C-${year}-${n}`, commit: () => { seq[year] = n; STATE.seq = seq; persistState(); } };
  }
};

function toast(msg, isError) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 3000);
}
function fmtCOP(n) { n = Math.round(Number(n) || 0); return "$" + n.toLocaleString("es-CO"); }
function parseNum(v) { if (typeof v === "number") return v; if (!v) return 0; return Number(String(v).replace(/[^0-9.-]/g, "")) || 0; }

// escapa texto antes de insertarlo en HTML/atributos — muchas descripciones
// reales de productos traen comillas (ej. medidas en pulgadas: 5/8"), y sin
// esto rompían el HTML generado y causaban errores al abrir cotizaciones
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ============================================================
   ROUTER — conserva el borrador de "Nueva cotización" en memoria
   (y en disco, por si hay un corte de luz) mientras el usuario
   navega a otras pantallas sin guardar.
   ============================================================ */
const Router = {
  current: "home",
  go(view, opts) {
    try {
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      document.getElementById("view-" + view).classList.add("active");
      document.querySelector(".app-shell").classList.toggle("wide-nueva", view === "nueva");
      this.current = view;
      if (view === "nueva") Views.renderNueva(opts && opts.record);
      if (view === "guardadas") Views.renderGuardadas();
      if (view === "asesores") Views.renderAsesores();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      console.error(e);
      toast("Ocurrió un error abriendo esta pantalla: " + e.message, true);
    }
  }
};

// cualquier error inesperado se muestra como aviso
window.addEventListener("error", e => { console.error(e.error || e.message); toast("Error: " + (e.message || "algo falló"), true); });
window.addEventListener("unhandledrejection", e => { console.error(e.reason); toast("Error: " + (e.reason && e.reason.message || "algo falló"), true); });

/* ============================================================
   AUTOCOMPLETE genérico
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
   ARRANQUE — lee datos.json / cyp.json automáticamente
   ============================================================ */
const AppInit = {
  async loadDatos() {
    try {
      const d = await window.api.readText(PATHS.datosDir + "/datos.json");
      if (d.ok) STATE.datos = JSON.parse(d.content);
    } catch (e) { console.warn("Error leyendo datos.json", e); }
    try {
      const c = await window.api.readText(PATHS.datosDir + "/cyp.json");
      if (c.ok) STATE.cyp = JSON.parse(c.content);
    } catch (e) { console.warn("Error leyendo cyp.json", e); }
  },
  async boot() {
    PATHS = await window.api.getPaths();
    const saved = await window.api.storeGet();
    const defaults = { datos: [], cyp: { clientes: [], asesores: [] }, cotizaciones: [], seq: {} };
    STATE = (saved && typeof saved === "object" && saved.cotizaciones) ? { ...defaults, ...saved } : defaults;
    DRAFT = null;
    delete STATE.draft;
    if (!STATE.cotizaciones.length) await this.recoverFromBackups();
    await this.loadDatos();
  },

  // si no hay cotizaciones guardadas (ej. app recién reinstalada), se
  // recuperan desde los respaldos .json de la carpeta Editable
  async recoverFromBackups() {
    try {
      const list = await window.api.listDir(PATHS.editableDir);
      if (!list.ok || !list.files || !list.files.length) return;
      const jsonFiles = list.files.filter(f => f.toLowerCase().endsWith(".json"));
      const recovered = [];
      for (const f of jsonFiles) {
        const r = await window.api.readText(PATHS.editableDir + "/" + f);
        if (r.ok) { try { recovered.push(JSON.parse(r.content)); } catch (e) {} }
      }
      if (recovered.length) {
        STATE.cotizaciones = recovered;
        // recalcula la secuencia para no repetir números
        const seq = {};
        recovered.forEach(r => {
          // Admite los consecutivos anteriores (2026-0001) y el formato
          // vigente C-2026-1 para no reiniciar ni duplicar la numeración.
          const match = String(r.numero || "").match(/^(?:C-)?(\d{4})-(\d+)$/);
          if (match) {
            const [, year, n] = match;
            seq[year] = Math.max(seq[year] || 0, parseInt(n, 10));
          }
        });
        STATE.seq = seq;
        persistState();
        toast(`Se recuperaron ${recovered.length} cotizaciones desde el respaldo`);
      }
    } catch (e) { console.warn("No se pudo recuperar desde respaldos", e); }
  }
};
AppInit.boot();

/* ============================================================
   VISTAS
   ============================================================ */
const Views = {};

/* ---------- ASESORES + ACTUALIZACIÓN DE DATOS ---------- */
Views.renderAsesores = function () {
  const el = document.getElementById("view-asesores");
  el.innerHTML = `
    <div class="section-head">
      <h2>Asesores</h2>
      <span class="back" onclick="Router.go('home')">← Volver</span>
    </div>
    <div class="card">
      <div style="font-size:15px;font-weight:700;color:var(--azul-950);margin-bottom:12px">Administrar asesores</div>
      <div class="search-bar">
        <input id="asesorNombre" placeholder="Nombre del nuevo asesor..." maxlength="80" autocomplete="off">
        <button class="btn btn-accent" id="addAsesorBtn">+ Agregar</button>
      </div>
      <div id="asesorList"></div>
    </div>
    <div class="card">
      <div style="font-size:15px;font-weight:700;color:var(--azul-950);margin-bottom:7px">Actualizar datos de cotización</div>
      <div style="font-size:13px;color:var(--texto-suave);line-height:1.5;margin-bottom:14px">Lee <b>Resumen_de_existencias_UC.xls</b> y <b>Directorio.xls</b> de la carpeta <b>Cotizador</b>, genera <b>Datos.xlsx</b> y actualiza los productos y clientes disponibles para cotizar.</div>
      <button class="btn btn-accent" id="importDatosBtn">Actualizar Datos desde Excel</button>
      <div id="importDatosResult" style="font-size:12px;color:var(--texto-suave);margin-top:10px"></div>
    </div>
  `;

  let editingIndex = -1;
  let deletingIndex = -1;

  function getAsesoresList() {
    if (!STATE.cyp) STATE.cyp = { clientes: [], asesores: [] };
    if (!Array.isArray(STATE.cyp.asesores)) STATE.cyp.asesores = [];
    return STATE.cyp.asesores;
  }

  async function saveAsesores(asesores) {
    if (!STATE.cyp) STATE.cyp = { clientes: [], asesores: [] };
    STATE.cyp.asesores = Array.isArray(asesores) ? asesores : [];
    persistState();
    try {
      const res = await window.api.writeFile(PATHS.datosDir, "cyp.json", JSON.stringify(STATE.cyp, null, 2), false);
      if (!res || !res.ok) {
        console.warn("Advertencia al escribir cyp.json:", res && res.error);
      }
    } catch (e) {
      console.warn("Error guardando cyp.json:", e);
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

    // Focus input if editing
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

    // Event listeners
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
      if (asesoresActuales.some((a, j) => j !== i && a.toLowerCase() === nuevo.toLowerCase())) {
        return toast("Ya existe un asesor con ese nombre", true);
      }
      asesoresActuales[i] = nuevo;
      editingIndex = -1;
      await saveAsesores(asesoresActuales);
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
        const removed = asesoresActuales.splice(i, 1);
        deletingIndex = -1;
        editingIndex = -1;
        await saveAsesores(asesoresActuales);
        toast(`Asesor "${removed[0]}" eliminado`);
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
    addInput.value = "";
    editingIndex = -1;
    deletingIndex = -1;
    await saveAsesores(asesoresActuales);
    toast("Asesor agregado correctamente");
    paintAsesores();
    addInput.focus();
  }

  addBtn.addEventListener("click", handleAdd);
  addInput.addEventListener("keydown", e => { if (e.key === "Enter") handleAdd(); });

  document.getElementById("importDatosBtn").addEventListener("click", async () => {
    const btn = document.getElementById("importDatosBtn"), resultEl = document.getElementById("importDatosResult");
    btn.disabled = true; btn.textContent = "Actualizando…"; resultEl.textContent = "Leyendo los archivos de Excel…";
    const result = await window.api.importSourceWorkbooks(getAsesoresList());
    btn.disabled = false; btn.textContent = "Actualizar Datos desde Excel";
    if (!result.ok) { resultEl.textContent = ""; return toast("No se pudieron actualizar los datos: " + (result.error || "error desconocido"), true); }
    await AppInit.loadDatos();
    persistState();
    resultEl.textContent = `Actualizado: ${result.productos} productos y ${result.clientes} clientes.`;
    toast("Datos actualizados desde Excel");
  });

  paintAsesores();
};

/* ============================================================
   COTIZACIONES GUARDADAS
   ============================================================ */
Views.renderGuardadas = function () {
  const el = document.getElementById("view-guardadas");
  const cot = DB.getCotizaciones().slice().sort((a, b) => b.numero.localeCompare(a.numero, undefined, { numeric: true }));
  el.innerHTML = `
    <div class="section-head"><h2>Cotizaciones guardadas</h2><span class="back" onclick="Router.go('home')">← Volver</span></div>
    <div class="card">
      <div class="search-bar"><input id="cotSearch" placeholder="Buscar por número o cliente…"></div>
      <div class="list-row head"><span>N.°</span><span>Cliente</span><span>Fecha</span><span>Asesor</span><span>Total</span></div>
      <div id="cotList"></div>
    </div>
  `;
  const list = document.getElementById("cotList");
  function paint(q) {
    q = (q || "").toLowerCase();
    const rows = cot.filter(c => !q || c.numero.toLowerCase().includes(q) || (c.cliente || "").toLowerCase().includes(q));
    list.innerHTML = rows.length ? rows.map(c => `
      <div class="list-row" data-numero="${esc(c.numero)}">
        <span class="n">${esc(c.numero)}</span><span>${esc(c.cliente || "—")}</span><span>${esc(c.fecha)}</span><span>${esc(c.asesor || "—")}</span><span>${fmtCOP(c.total)}</span>
      </div>`).join("") : `<div class="empty"><div class="ic">🔍</div>Sin resultados</div>`;
    // clic manejado en JS, no como texto embebido en el HTML — evita que
    // caracteres especiales en los datos rompan el atributo onclick
    list.querySelectorAll(".list-row[data-numero]").forEach(row => {
      row.addEventListener("click", () => Router.go("nueva", { record: row.dataset.numero }));
    });
  }
  paint("");
  document.getElementById("cotSearch").addEventListener("input", e => paint(e.target.value));
  if (!cot.length) list.innerHTML = `<div class="empty"><div class="ic">🗂️</div>Aún no hay cotizaciones guardadas.</div>`;
};

/* ============================================================
   NUEVA / EDITAR COTIZACIÓN
   ============================================================ */
Views.renderNueva = function (numeroToLoad) {
  const el = document.getElementById("view-nueva");
  const existing = numeroToLoad ? DB.getCotizaciones().find(c => c.numero === numeroToLoad) : null;
  const isEdit = !!existing;
  const source = isEdit ? existing : null;
  const numeroDisplay = isEdit ? existing.numero : "Se asigna al guardar";
  const hoy = new Date().toISOString().slice(0, 10);

  // Modo edición conserva el número; nueva cotización inicia en limpio
  Cotizador._editingNumero = isEdit ? existing.numero : null;

  el.innerHTML = `
    <div class="section-head">
      <h2>${isEdit ? `Cotización ${esc(existing.numero)} <span style="font-size:12.5px;font-weight:700;color:var(--teal-700);background:#e6f6f8;padding:3px 10px;border-radius:12px;margin-left:8px;vertical-align:middle">Editando</span>` : "Nueva cotización"}</h2>
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
        <div><label>Contacto *</label><input id="f_contacto" value="${esc(source ? source.contacto || "" : "")}" placeholder="Persona de contacto"></div>
      </div>
      <div class="grid g3" style="margin-top:14px">
        <div><label>Tiempo de entrega *</label><input id="f_tiempo" list="opciones_tiempo" value="${esc(source ? source.tiempoEntrega || "Inmediata" : "Inmediata")}" placeholder="Selecciona o escribe"><datalist id="opciones_tiempo"><option value="Inmediata"><option value="De 3 a 5 días hábiles"><option value="De 8 a 15 días hábiles"></datalist></div>
        <div><label>Forma de pago *</label><input id="f_pago" list="opciones_pago" value="${esc(source ? source.formaPago || "Contado" : "Contado")}" placeholder="Selecciona o escribe"><datalist id="opciones_pago"><option value="Contado"><option value="Crédito 30 días"><option value="Crédito 60 días"></datalist></div>
        <div><label>Validez de la oferta *</label><input id="f_validez" value="${esc(source ? source.validez || "15 días" : "15 días")}"></div>
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
      <textarea id="f_obs">${esc(source ? source.observaciones || "" : "Favor consignar a: Bancolombia – Cuenta de Ahorros N.º 72600001670, a nombre de Representaciones M&M Medical SAS.\n\nNo somos grandes contribuyentes ni autorretenedores de renta.\nSomos grandes contribuyentes de ICA en Bucaramanga – Res. 1017 del 31/05/2021.\nFavor no practicar ReteICA en otros municipios.")}</textarea>
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="Cotizador.save(false)">${isEdit ? "Guardar cambios" : "Guardar cotización"}</button>
      <button class="btn btn-accent" onclick="Cotizador.save(true)">${isEdit ? "Guardar cambios y actualizar PDF" : "Guardar y generar PDF"}</button>
      ${isEdit ? `<button class="btn btn-danger" id="btnEliminar">Eliminar cotización</button>` : ""}
      <button class="btn btn-ghost" onclick="Router.go('guardadas')" style="margin-left:auto">Ver cotizaciones guardadas</button>
    </div>
  `;

  // Inicialización de productos: desde la cotización existente o una fila limpia
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

/* ---------- ITEMS UI: Productos y Autocomplete mejorado ---------- */
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
   GUARDAR / GENERAR PDF (Soporta creación y reescritura exacta)
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

  validate(data) {
    const required = { cliente: "Cliente", contacto: "Contacto", tiempoEntrega: "Tiempo de entrega", formaPago: "Forma de pago", validez: "Validez de la oferta", asesor: "Asesor" };
    const missing = [];
    document.querySelectorAll("#view-nueva .err").forEach(e => e.classList.remove("err"));
    const map = { cliente: "f_cliente", contacto: "f_contacto", tiempoEntrega: "f_tiempo", formaPago: "f_pago", validez: "f_validez", asesor: "f_asesor" };
    for (const key in required) {
      if (!data[key]) {
        missing.push(required[key]);
        const el = document.getElementById(map[key]);
        if (el) el.classList.add("err");
      }
    }
    return missing;
  },

  async save(withPdf) {
    const data = this.collect();
    const missing = this.validate(data);
    if (missing.length) {
      toast("Falta completar: " + missing.join(", "), true);
      return;
    }

    const items = ItemsUI.items.filter(it => (it.codigo && String(it.codigo).trim()) || (it.descripcion && String(it.descripcion).trim()));
    if (!items.length) {
      toast("Debes agregar al menos un producto a la cotización", true);
      return;
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
      seq.commit();
    }

    const record = { numero, ...data, items, subtotal, iva, total: subtotal + iva };

    // Si ya existía, se reescribe sobre el mismo registro; si es nueva, se agrega
    const all = [...DB.getCotizaciones()];
    const idx = all.findIndex(c => c.numero === numero);
    if (idx >= 0) {
      all[idx] = record;
    } else {
      all.push(record);
    }
    DB.setCotizaciones(all);

    this._editingNumero = null;
    DRAFT = null;
    delete STATE.draft;
    persistState();

    toast(
      isEdit
        ? (withPdf ? `Cotización ${numero} actualizada y PDF regenerado` : `Cotización ${numero} actualizada`)
        : (withPdf ? `Cotización ${numero} guardada y PDF generado` : `Cotización ${numero} guardada`)
    );

    // Guardado de respaldo en Editable/ y PDF en PDF/
    try {
      await this.writeBackup(record);
    } catch (e) {
      console.error(e);
      toast("No se pudo guardar el respaldo: " + e.message, true);
    }

    if (withPdf) {
      try {
        await this.writePdf(record);
      } catch (e) {
        console.error(e);
        toast("No se pudo generar el PDF: " + e.message, true);
      }
    }

    // Regresa a cotizaciones guardadas para ver el registro actualizado
    Router.go("guardadas");
  },

  remove(numero) {
    DB.setCotizaciones(DB.getCotizaciones().filter(c => c.numero !== numero));
    toast(`Cotización ${numero} eliminada`);
    Router.go('guardadas');
  },

  async writeBackup(record) {
    const filename = `Cotizacion ${record.numero}.json`;
    const res = await window.api.writeFile(PATHS.editableDir, filename, JSON.stringify(record, null, 2), false);
    if (!res.ok) throw new Error(res.error || "error desconocido");
  },

  async writePdf(record) {
    let blob;
    try {
      blob = PdfBuilder.build(record);
    } catch (e) {
      console.error(e);
      toast("No se pudo generar el PDF: " + e.message, true);
      return;
    }
    const filename = `Cotizacion ${record.numero}.pdf`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 500) { toast("El PDF salió vacío, no se guardó. Intenta de nuevo.", true); return; }
    const res = await window.api.writeFile(PATHS.pdfDir, filename, Array.from(bytes), true);
    if (res.ok) toast(`PDF de cotización ${record.numero} guardado`);
    else toast("No se pudo guardar el PDF: " + res.error, true);
  }
};

/* ============================================================
   GENERADOR DE PDF (jsPDF) — formato oficial de la empresa
   Replica exactamente el diseño de Cotizacion_MODELO.html
   ============================================================ */
const PdfBuilder = {
  build(r) {
    const { jsPDF } = window.jspdf;
    const pageW = 595.28; // Ancho A4 / Letter estándar en puntos

    // primera pasada (solo para medir): se dibuja en una página alta de
    // sobra y se ve dónde terminó el contenido real
    const probe = new jsPDF({ unit: "pt", format: [pageW, 3000], orientation: "p" });
    const finalY = this.renderContent(probe, r, pageW);

    // segunda pasada: se crea la página con altura vertical estándar (mínimo A4 841.89 pt),
    // adaptándose hacia abajo si la cotización tiene más ítems de los habituales.
    const minH = 841.89;
    const finalH = Math.max(finalY + 30, minH);
    const doc = new jsPDF({ unit: "pt", format: [pageW, finalH], orientation: "p" });
    this.renderContent(doc, r, pageW);

    return doc.output("blob");
  },

  renderContent(doc, r, pageW) {
    const M = 36;
    const contentW = pageW - 2 * M;

    // Colores corporativos basados en Cotizacion_MODELO.html
    const navy = [27, 58, 107];       // #1B3A6B
    const bgBadge = [238, 242, 247];   // #eef2f7
    const bgPanel = [250, 251, 252];   // #fafbfc
    const bgZebra = [247, 249, 251];   // #f7f9fb
    const border = [214, 222, 232];    // #d6dee8
    const borderSoft = [230, 234, 240];// #e6eaf0
    const textDark = [43, 43, 43];     // #2b2b2b
    const textMuted = [102, 102, 102]; // #666666
    const labelKey = [138, 148, 163];  // #8a94a3
    const footerColor = [154, 163, 177];// #9aa3b1

    let y = 28;

    // ============================================================
    //  1. ENCABEZADO: Logo + Datos Empresa + Badge Cotización
    // ============================================================
    const logoW = 120, logoH = 48;
    try {
      doc.addImage(LOGO_B64, "PNG", M, y + 2, logoW, logoH);
    } catch (e) {
      console.warn("Error agregando logo:", e.message);
    }

    // Datos de la empresa (junto al logo)
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

    // Badge Cotización (esquina derecha)
    const badgeW = 120;
    const badgeX = pageW - M - badgeW;
    const badgeY = y;

    // Header badge (Navy)
    doc.setFillColor(...navy);
    doc.roundedRect(badgeX, badgeY, badgeW, 20, 3, 3, "F");
    doc.rect(badgeX, badgeY + 16, badgeW, 4, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("COTIZACIÓN", badgeX + badgeW / 2, badgeY + 14, { align: "center" });

    // Número cotización
    doc.setFillColor(...bgBadge);
    doc.setDrawColor(...border);
    doc.setLineWidth(0.8);
    doc.rect(badgeX, badgeY + 20, badgeW, 20, "FD");
    doc.setTextColor(...navy);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text(String(r.numero || "C-2026-0001"), badgeX + badgeW / 2, badgeY + 34, { align: "center" });

    // Fecha
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...textMuted);
    doc.text("Fecha: " + (r.fecha || ""), badgeX + badgeW, badgeY + 52, { align: "right" });

    y += 66;

    // Línea divisoria azul gruesa del header
    doc.setDrawColor(...navy);
    doc.setLineWidth(2.2);
    doc.line(M, y, pageW - M, y);

    y += 8;

    // ============================================================
    //  2. TAGLINE BANNER
    // ============================================================
    doc.setFillColor(...bgBadge);
    doc.roundedRect(M, y, contentW, 18, 3, 3, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...navy);
    doc.text(
      "EQUIPOS MÉDICOS · INSTRUMENTAL QUIRÚRGICO · INSUMOS HOSPITALARIOS · PAPELES TÉRMICOS",
      pageW / 2,
      y + 12,
      { align: "center" }
    );

    y += 26;

    // ============================================================
    //  3. CLIENT INFO PANEL (4 columnas)
    // ============================================================
    const clientCells = [
      { label: "CLIENTE", value: r.cliente || "—", w: contentW * 0.38 },
      { label: "NIT", value: r.nit || "—", w: contentW * 0.20 },
      { label: "CIUDAD", value: r.ciudad || "—", w: contentW * 0.20 },
      { label: "CONTACTO", value: r.contacto || "—", w: contentW * 0.22 }
    ];
    y = this.renderPanel(doc, clientCells, M, y, contentW, bgPanel, border, labelKey, textDark);

    y += 8;

    // ============================================================
    //  4. COMMERCIAL TERMS PANEL (3 columnas)
    // ============================================================
    const termsCells = [
      { label: "TIEMPO DE ENTREGA", value: r.tiempoEntrega || "Inmediata", w: contentW * 0.34 },
      { label: "FORMA DE PAGO", value: r.formaPago || "Contado", w: contentW * 0.33 },
      { label: "VALIDEZ DE LA OFERTA", value: r.validez || "30 días", w: contentW * 0.33 }
    ];
    y = this.renderPanel(doc, termsCells, M, y, contentW, bgPanel, border, labelKey, textDark);

    y += 14;

    // ============================================================
    //  5. TABLA DE PRODUCTOS
    // ============================================================
    const cols = [
      { key: "codigo", label: "CÓDIGO", w: 60, align: "center" },
      { key: "descripcion", label: "DESCRIPCIÓN", w: contentW - 60 - 38 - 72 - 42 - 76, align: "left" },
      { key: "cantidad", label: "CANT.", w: 38, align: "center" },
      { key: "vrUnitario", label: "VR. UNITARIO", w: 72, align: "right" },
      { key: "ivaPct", label: "IVA %", w: 42, align: "center" },
      { key: "valorTotal", label: "VR. TOTAL", w: 76, align: "right" }
    ];

    // Encabezado de la tabla (Navy)
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

    // Filas de productos
    const items = Array.isArray(r.items) ? r.items : [];
    doc.setLineWidth(0.6);

    items.forEach((it, idx) => {
      const vt = it.cantidad * it.vrUnitario;
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

      // Código
      doc.text(String(it.codigo || ""), curX + cols[0].w / 2, y + 12, { align: "center" });
      curX += cols[0].w;

      // Descripción
      doc.text(descLines, curX + 6, y + 12);
      curX += cols[1].w;

      // Cantidad
      doc.text(String(it.cantidad || 0), curX + cols[2].w / 2, y + 12, { align: "center" });
      curX += cols[2].w;

      // Vr. Unitario
      doc.text(fmtCOP(it.vrUnitario), curX + cols[3].w - 6, y + 12, { align: "right" });
      curX += cols[3].w;

      // IVA %
      const ivaStr = Math.round((Number(it.ivaPct) || 0) * 100) + "%";
      doc.text(ivaStr, curX + cols[4].w / 2, y + 12, { align: "center" });
      curX += cols[4].w;

      // Vr. Total
      doc.text(fmtCOP(vt), curX + cols[5].w - 6, y + 12, { align: "right" });

      y += rowH;
    });

    y += 8;

    // ============================================================
    //  6. TOTALES (Caja alineada a la derecha)
    // ============================================================
    const totW = 195;
    const totX = pageW - M - totW;

    // Subtotal
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...textDark);
    doc.text("Subtotal:", totX + 10, y + 12);
    doc.text(fmtCOP(r.subtotal), totX + totW - 10, y + 12, { align: "right" });
    y += 16;

    // IVA
    doc.text("IVA:", totX + 10, y + 12);
    doc.text(fmtCOP(r.iva), totX + totW - 10, y + 12, { align: "right" });
    y += 16;

    // Línea separadora antes del Total
    doc.setDrawColor(...border);
    doc.setLineWidth(0.8);
    doc.line(totX, y, totX + totW, y);
    y += 3;

    // Total final (Navy banner)
    doc.setFillColor(...navy);
    doc.roundedRect(totX, y, totW, 22, 3, 3, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text("TOTAL:", totX + 12, y + 15);
    doc.text(fmtCOP(r.total), totX + totW - 12, y + 15, { align: "right" });

    y += 34;

    // ============================================================
    //  7. OBSERVACIONES (Izq) + FIRMA (Der)
    // ============================================================
    const obsW = contentW * 0.58;
    const firW = contentW - obsW - 12;
    const boxTop = y;

    const defaultObs =
      "Favor consignar a: Bancolombia – Cuenta de Ahorros N.º 72600001670, a nombre de Representaciones M&M Medical SAS.\n" +
      "No somos grandes contribuyentes ni autorretenedores de renta.\n" +
      "Somos grandes contribuyentes de ICA en Bucaramanga – Res. 1017 del 31/05/2021.\n" +
      "Favor no practicar ReteICA en otros municipios.";

    const obsText = (r.observaciones && r.observaciones.trim()) || defaultObs;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.8);
    const obsLines = doc.splitTextToSize(obsText, obsW - 20);
    const obsH = Math.max(90, 26 + obsLines.length * 10.5);

    // Caja Observaciones
    doc.setFillColor(...bgPanel);
    doc.setDrawColor(...border);
    doc.setLineWidth(0.8);
    doc.roundedRect(M, boxTop, obsW, obsH, 4, 4, "FD");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...navy);
    doc.text("OBSERVACIONES Y CONDICIONES", M + 10, boxTop + 14);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.8);
    doc.setTextColor(...textDark);
    doc.text(obsLines, M + 10, boxTop + 26);

    // Caja Firma
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

    // ============================================================
    //  8. FOOTER NOTE
    // ============================================================
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
    const wrapped = cells.map(c => doc.splitTextToSize(String(c.value || "—"), c.w - 14));
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
      doc.text(c.label, curX + 7, y0 + 11);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.8);
      doc.setTextColor(...valColor);
      doc.text(wrapped[idx], curX + 7, y0 + 23);

      curX += c.w;
    });

    return y0 + h;
  }
};