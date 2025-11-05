#!/usr/bin/env node
// ESM, Node 22+
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { NodeHtmlMarkdown } from "node-html-markdown";
import * as cheerio from "cheerio";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);

type Item = {
  slug: string;
  jurisdiccion: string;
  organismo: string;
  tipo: string;
  numero: string;
  anio: number;
  publicacion: string;
  fuente_url: string; // puede venir “limpia” o como [texto](url)
  archivo_tipo: "html" | "pdf";
  salida_relativa: string; // p.ej. "provincial/ar-ba-codigo-fiscal-10397.md"
};

type Mode = "mock" | "real";

// ---------- CLI ----------
function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const manifestPathArg = getArg("--manifest");
const outDirArg = getArg("--out");
const modeArg = (getArg("--mode") ?? process.env.SOURCES_MODE ?? "mock")
  .toString()
  .toLowerCase();
const mode: Mode = modeArg === "real" ? "real" : "mock";

const DOCS_ROOT = path.resolve(
  process.cwd(),
  outDirArg ?? process.env.DOCS_ROOT ?? "../data"
);

if (!manifestPathArg) {
  console.error("Falta --manifest <path a JSON>");
  process.exit(2);
}
const manifestPath = path.resolve(process.cwd(), manifestPathArg);
if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest no existe: ${manifestPath}`);
  process.exit(2);
}
const raw = fs.readFileSync(manifestPath, "utf-8");
const items = JSON.parse(raw) as Item[];

console.log(`Modo de generación = ${mode}`);

// ---------- Utils ----------
function ensureDir(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function cleanWhitespace(s: string) {
  return s
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeUrl(s: string): string {
  // Si vino en formato markdown [texto](https://url), extrae la URL
  const m = s.match(/\((https?:\/\/[^)]+)\)/i);
  if (m) return m[1];
  // Limpieza mínima de restos
  return s.replace(/^\[|\]$|\(|\)/g, "");
}

function absolutizeLinks($: cheerio.CheerioAPI, base: string) {
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      $(el).attr("href", new URL(href, base).toString());
    } catch {}
  });
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    try {
      $(el).attr("src", new URL(src, base).toString());
    } catch {}
  });
}

function decodeMaybeLatin1(value: string): string {
  if (!/[ÃÂâ]/.test(value)) return value;
  let current = value
    .replace(/ÃƒÂ/g, "Ã")
    .replace(/Ã‚Â/g, "")
    .replace(/Ã¢â€/g, "â")
    .replace(/Ãƒâ€š/g, "Ã")
    .replace(/Ãƒâ€ž/g, "Ä")
    .replace(/Ãƒâ€¡/g, "Ç");
  try {
    current = Buffer.from(current, "latin1").toString("utf8");
  } catch {
    return value;
  }
  return current
    .replace(/â€™/g, "’")
    .replace(/â€œ/g, "“")
    .replace(/â€�/g, "”")
    .replace(/â€“/g, "–")
    .replace(/â€”/g, "—")
    .replace(/â€¢/g, "•")
    .replace(/â€˜/g, "‘")
    .replace(/â€º/g, "›")
    .replace(/â€¹/g, "‹")
    .replace(/â€¦/g, "…");
}

function sanitizeScalar(value: string): string {
  return decodeMaybeLatin1(value).replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return decodeMaybeLatin1(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type JurisdictionProfile = {
  nombre: string;
  descripcion: string;
  foco2025: string[];
  cumplimiento: string[];
  servicios: { nombre: string; url: string; descripcion: string }[];
  casos: { titulo: string; detalle: string }[];
  recordatorios?: string[];
};

const JURISDICTION_PROFILES: Record<string, JurisdictionProfile> = {
  "AR-BA": {
    nombre: "Provincia de Buenos Aires",
    descripcion:
      "La Provincia de Buenos Aires concentra gran parte de la actividad industrial y de servicios de Argentina. La recaudación está a cargo de ARBA, con foco en Ingresos Brutos, Inmobiliario Urbano y el Impuesto a los Sellos.",
    foco2025: [
      "Actualización de alícuotas de Ingresos Brutos con tramos diferenciados para comercio minorista, industria y servicios digitales.",
      "Nuevos parámetros para el régimen simplificado (Monotributo Unificado ARBA) con tope anual de facturación simulado en ARS 22.4 millones.",
      "Esquema piloto de créditos fiscales automáticos para PyMEs industriales con certificación de proveedores locales.",
    ],
    cumplimiento: [
      "Declaración Jurada mensual de Ingresos Brutos (RG 1/2025 simulada) vence el día 20 según terminación de CUIT.",
      "Agentes de recaudación deben remitir percepciones y retenciones a través de SIRCAR con calendario escalonado del 10 al 15 de cada mes.",
      "Sellos digitales: obligación de generar matrículas electrónicas antes de firmar contratos de locación y leasing provinciales.",
    ],
    servicios: [
      {
        nombre: "ARBA Autogestión",
        url: "https://www.arba.gov.ar/",
        descripcion:
          "Portal principal para DDJJ, boletas y seguimiento de planes de pago provinciales.",
      },
      {
        nombre: "SIRCAR",
        url: "https://www.ca.gob.ar/sistemas/sircar",
        descripcion:
          "Sistema unificado para agentes de recaudación de Ingresos Brutos Convenio Multilateral.",
      },
      {
        nombre: "Mesa de ayuda PyME",
        url: "https://www.arba.gov.ar/pymes",
        descripcion:
          "Canal experimental con turnos virtuales para asesoramiento de PyMEs industriales del corredor norte.",
      },
    ],
    casos: [
      {
        titulo: "Fabricante industrial mediano",
        detalle:
          "Debe recalcular alícuotas de Ingresos Brutos del 2,5% al 2,3% para ventas intraprovinciales y validar certificados de exención para proveedores bonaerenses.",
      },
      {
        titulo: "Marketplace de servicios profesionales",
        detalle:
          "Aplica una alícuota diferenciada del 5,5% y queda alcanzado por el padrón de retenciones bancarias desde abril de 2025.",
      },
      {
        titulo: "Desarrolladora inmobiliaria",
        detalle:
          "Debe autoliquidar Sellos digitales con la nueva base imponible mínima de ARS 2,8 millones por boleto de compraventa.",
      },
    ],
    recordatorios: [
      "Controlar mensualmente el padrón de ARBA para evitar retenciones incrementadas (alto riesgo).",
      "Simulación indica que los planes de pago especiales 2024 continúan vigentes hasta junio de 2025 con tasa nominal del 3,2% mensual.",
    ],
  },
  "AR-CBA": {
    nombre: "Provincia de Córdoba",
    descripcion:
      "Córdoba mantiene un esquema tributario provincial centrado en Ingresos Brutos, Sellos y el Impuesto Inmobiliario. La Dirección General de Rentas (DGR) impulsa fuerte digitalización de trámites.",
    foco2025: [
      "Reducción simulada de 0,25 puntos en la alícuota de Ingresos Brutos para servicios de software exportables.",
      "Régimen simplificado cordobés con nuevas categorías basadas en consumo eléctrico anual y tope de ARS 18,9 millones.",
      "Beneficio promocional para inversiones en parques industriales con crédito fiscal provincial del 50% sobre Ingresos Brutos.",
    ],
    cumplimiento: [
      "DDJJ mensual del régimen general vence el día 15, con recargos automáticos a partir del día siguiente.",
      "Agentes de retención bancarios informan operaciones vía SIRCREB provincial el último día hábil del mes.",
      "Sellos: obligatoriedad de timbrado digital en contratos de fletes interjurisdiccionales firmados en la provincia.",
    ],
    servicios: [
      {
        nombre: "Rentas Córdoba",
        url: "https://www.rentascordoba.gob.ar/",
        descripcion:
          "Portal integral con domicilio fiscal electrónico obligatorio y panel de planes de pago.",
      },
      {
        nombre: "Ciudadano Digital (CiDi)",
        url: "https://cidi.cba.gov.ar/",
        descripcion:
          "Plataforma transversal para notificaciones y autenticación en trámites tributarios cordobeses.",
      },
      {
        nombre: "Mesa sectorial industrial",
        url: "https://www.rentascordoba.gob.ar/industria",
        descripcion:
          "Agenda colaborativa para seguimiento de beneficios y certificaciones de parques industriales.",
      },
    ],
    casos: [
      {
        titulo: "Empresa de software exportador",
        detalle:
          "Puede aplicar la alícuota reducida del 3,75% si acredita más del 70% de facturación al exterior y nómina técnica en la provincia.",
      },
      {
        titulo: "Cadena de retail regional",
        detalle:
          "Debe conciliar percepciones bancarias cordobesas con ventas en otras jurisdicciones para evitar saldos a favor estructurales.",
      },
      {
        titulo: "Transporte de cargas",
        detalle:
          "Queda alcanzado por el régimen excepcional de pagos 2025 con opción de financiar deuda vencida en 48 cuotas.",
      },
    ],
    recordatorios: [
      "Simulación sugiere revisar padrón de contribuyentes de riesgo para evitar recategorizaciones automáticas.",
      "La DGR amplió controles de cumplimiento electrónico sobre facturación en tiempo real (pilotaje 2025).",
    ],
  },
  "AR-CABA": {
    nombre: "Ciudad Autónoma de Buenos Aires",
    descripcion:
      "La Ciudad Autónoma de Buenos Aires (CABA) administra tributos locales a través de AGIP, con fuerte adopción de servicios digitales y fiscalización sectorial en economía del conocimiento.",
    foco2025: [
      "Actualización de la Ley Tarifaria con escalas diferenciadas para Ingresos Brutos de servicios profesionales y economía creativa.",
      "Plan de incentivos para pymes culturales con reducción del 30% en Ingresos Brutos durante 24 meses.",
      "Homologación del padrón de Sellos digitales para contratos inmobiliarios sobre viviendas usadas hasta 120 m².",
    ],
    cumplimiento: [
      "Declaraciones mensuales de Ingresos Brutos vencen según terminación de CUIT entre los días 10 y 15.",
      "Régimen de retención de tarjetas (SIRCREB) aplica coeficientes reforzados para comercio electrónico domiciliado en CABA.",
      "Obligación de domicilio fiscal electrónico en la plataforma AGIP y aceptación de notificaciones en 48 horas hábiles.",
    ],
    servicios: [
      {
        nombre: "AGIP",
        url: "https://www.agip.gob.ar/",
        descripcion:
          "Gestión integral de tributos porteños, con notificaciones y presentaciones online 24/7.",
      },
      {
        nombre: "Sistema Simplificado CABA",
        url: "https://www.agip.gob.ar/simplificado",
        descripcion:
          "Panel para pequeños contribuyentes locales con vencimientos trimestrales automatizados.",
      },
      {
        nombre: "Oficina Virtual AGIP",
        url: "https://oficinavirtual.agip.gob.ar/",
        descripcion:
          "Mesa de entradas digital con seguimiento de expedientes y trámites especiales (exenciones, planes).",
      },
    ],
    casos: [
      {
        titulo: "Estudio creativo independiente",
        detalle:
          "Accede a reducción del 30% en Ingresos Brutos y debe informar nómina cultural para sostener el beneficio.",
      },
      {
        titulo: "Consultora tecnológica",
        detalle:
          "Queda alcanzada por alícuota del 5% y retenciones bancarias reforzadas cuando opera plataformas globales.",
      },
      {
        titulo: "Broker inmobiliario",
        detalle:
          "Debe liquidar Sellos con alícuota preferencial para viviendas usadas hasta 120 m² y reportar contratos mediante RUI.",
      },
    ],
    recordatorios: [
      "AGIP realiza cruces mensuales con AFIP para detectar omisiones en Regímenes de Recaudación (SIRCREB y SIRTAC).",
      "Seguimiento especial a billeteras virtuales domiciliadas en la Ciudad con obligación de reportar retenciones semanales.",
    ],
  },
};

const DEFAULT_PROFILE: JurisdictionProfile = {
  nombre: "Jurisdicción sin perfil",
  descripcion:
    "Perfil genérico para documentación sintética. Los datos son simulados y sirven únicamente para pruebas de ingestión.",
  foco2025: [
    "Actualización ficticia de alícuotas y escalas tributarias para el ejercicio 2025.",
    "Implementación de controles digitales simulados sobre declaraciones juradas mensuales.",
  ],
  cumplimiento: [
    "Vencimientos simulados ubicados en la segunda quincena de cada mes calendario.",
  ],
  servicios: [
    {
      nombre: "Portal Tributario Simulado",
      url: "https://tributos.example.com/",
      descripcion:
        "Sitio ficticio para trámites y presentaciones electrónicas durante pruebas técnicas.",
    },
  ],
  casos: [
    {
      titulo: "Contribuyente genérico",
      detalle:
        "Debe cumplir con las declaraciones simuladas y validar retenciones dentro del entorno de prueba.",
    },
  ],
};

const TYPE_SUMMARY: Record<string, string> = {
  "codigo fiscal":
    "El código fiscal fija definiciones, sujetos alcanzados y el procedimiento tributario aplicable a los tributos locales.",
  "codigo tributario":
    "El código tributario ordena competencias, obligaciones formales y facultades de fiscalización de la administración provincial.",
  "ley impositiva":
    "La ley impositiva anual define alícuotas, mínimos y beneficios vigentes para el ejercicio fiscal.",
  "ley tarifaria":
    "La ley tarifaria establece escalas, topes y categorías para los tributos locales durante el período corriente.",
  anexo:
    "El anexo complementa la norma principal con cuadros tarifarios y convertidores aplicables a actividades específicas.",
  decreto:
    "El decreto reglamenta aspectos puntuales y aclara criterios administrativos para aplicar la norma madre.",
  "decreto reglamentario":
    "El decreto reglamentario precisa operativas, plazos y autoridades de aplicación de la norma legal principal.",
  "resolucion normativa":
    "La resolución normativa detalla mecanismos de cumplimiento, regímenes especiales y cronogramas de presentación.",
  "resolucion general":
    "La resolución general introduce pautas operativas para agentes y contribuyentes, con énfasis en controles sistémicos.",
  "convenio multilateral":
    "El convenio multilateral fija reglas de distribución de ingresos brutos entre jurisdicciones para actividades interjurisdiccionales.",
  default:
    "La normativa establece lineamientos tributarios vigentes y actualizados para la jurisdicción involucrada.",
};

const TYPE_NOTES: Record<string, string[]> = {
  "codigo fiscal": [
    "Verificar capítulos de procedimientos para sustanciación de determinaciones de oficio simuladas.",
    "Revisar facultades de fiscalización referidas a requerimientos electrónicos y plazos de respuesta.",
  ],
  "codigo tributario": [
    "Controlar la clasificación de infracciones y sanciones para asesorar sobre moratorias vigentes.",
    "Alinear reglamentación provincial con regímenes simplificados activos en 2025.",
  ],
  "ley impositiva": [
    "Comparar alícuotas 2024 vs. 2025 para detectar variaciones relevantes según actividad.",
    "Confirmar beneficios sectoriales vigentes antes de proyectar anticipos.",
  ],
  "ley tarifaria": [
    "Actualizar tablas en sistemas de gestión antes del primer anticipo del año.",
    "Cruzar escalas simuladas con categorías de contribuyentes simplificados locales.",
  ],
  anexo: [
    "Incorporar los nuevos convertidores en planillas de cálculo y liquidadores automáticos.",
    "Validar referencias cruzadas con la ley principal para evitar interpretaciones inconsistentes.",
  ],
  decreto: [
    "Documentar los cambios procedimentales comunicados por la autoridad tributaria local.",
  ],
  "decreto reglamentario": [
    "Identificar artículos que impactan en la forma de presentación digital de DDJJ.",
  ],
  "resolucion normativa": [
    "Monitorear cronogramas y regímenes especiales que requieren adhesión previa.",
    "Difundir en clientes los nuevos esquemas de percepción o retención automáticos.",
  ],
  "resolucion general": [
    "Configurar sistemas de agentes de retención según las pautas operativas simuladas.",
  ],
  "convenio multilateral": [
    "Revisar coeficientes unificados y circuitos SIRCAR/SIRTAC para contribuyentes multijurisdiccionales.",
  ],
  default: [
    "Registrar los cambios simulados en manuales internos de liquidación tributaria.",
  ],
};

const FIELD_OVERRIDES: Record<
  string,
  Partial<Record<"organismo" | "tipo" | "numero" | "publicacion", string>>
> = {
  "ar-caba-anexo-convertidor-ley-tarifaria-2025": {
    numero: "Anexo IV (convertidor CF 2024-2025)",
  },
};

function resolveField(
  item: Item,
  field: "organismo" | "tipo" | "numero" | "publicacion"
): string {
  const override = FIELD_OVERRIDES[item.slug]?.[field];
  if (override) return override;
  const raw = (item as any)[field];
  return sanitizeScalar(typeof raw === "string" ? raw : String(raw ?? ""));
}

function generateMockContent(item: Item): string {
  const profile = JURISDICTION_PROFILES[item.jurisdiccion] ?? DEFAULT_PROFILE;
  const tipo = resolveField(item, "tipo");
  const numero = resolveField(item, "numero");
  const organismo = resolveField(item, "organismo");
  const publicacion = resolveField(item, "publicacion");
  const key = normalizeKey(item.tipo);
  const summary = TYPE_SUMMARY[key] ?? TYPE_SUMMARY.default;
  const notes = TYPE_NOTES[key] ?? TYPE_NOTES.default;

  const lines: string[] = [];
  lines.push(`# ${profile.nombre} — ${tipo} ${numero} (${item.anio})`);
  lines.push("");
  lines.push(
    `> Nota: contenido sintético para entornos de prueba. Simula disposiciones habituales publicadas por ${organismo}.`
  );
  lines.push("");
  lines.push("## Resumen ejecutivo");
  lines.push(profile.descripcion);
  lines.push("");
  lines.push(
    `${summary} Publicado originalmente por ${publicacion} en ${item.anio}, se considera vigente para ejercicios 2025 en este entorno controlado.`
  );

  if (profile.foco2025.length) {
    lines.push("");
    lines.push("## Puntos destacados 2025");
    for (const punto of profile.foco2025) {
      lines.push(`- ${punto}`);
    }
  }

  if (profile.cumplimiento.length) {
    lines.push("");
    lines.push("## Calendario y cumplimiento");
    for (const item of profile.cumplimiento) {
      lines.push(`- ${item}`);
    }
  }

  if (profile.casos.length) {
    lines.push("");
    lines.push("## Casos prácticos");
    for (const caso of profile.casos) {
      lines.push(`- **${caso.titulo}:** ${caso.detalle}`);
    }
  }

  if (profile.servicios.length) {
    lines.push("");
    lines.push("## Recursos oficiales y canales digitales");
    for (const servicio of profile.servicios) {
      lines.push(
        `- [${servicio.nombre}](${servicio.url}): ${servicio.descripcion}`
      );
    }
  }

  const notaExtra = [...notes, ...(profile.recordatorios ?? [])];
  if (notaExtra.length) {
    lines.push("");
    lines.push("## Notas operativas para asesores");
    for (const nota of notaExtra) {
      lines.push(`- ${nota}`);
    }
  }

  return cleanWhitespace(lines.join("\n")) + "\n";
}

function frontMatter(
  i: Item,
  contentType: "html" | "pdf" | "mock",
  finalUrl: string
) {
  const fetchedAt = new Date().toISOString();
  return [
    "---",
    `slug: ${JSON.stringify(sanitizeScalar(i.slug))}`,
    `jurisdiccion: ${JSON.stringify(sanitizeScalar(i.jurisdiccion))}`,
    `organismo: ${JSON.stringify(resolveField(i, "organismo"))}`,
    `tipo: ${JSON.stringify(resolveField(i, "tipo"))}`,
    `numero: ${JSON.stringify(resolveField(i, "numero"))}`,
    `anio: ${i.anio}`,
    `publicacion: ${JSON.stringify(resolveField(i, "publicacion"))}`,
    `fuente_url: ${JSON.stringify(finalUrl)}`,
    `fetched_at: ${JSON.stringify(fetchedAt)}`,
    `source_content_type: ${JSON.stringify(contentType)}`,
    "---",
    "",
  ].join("\n");
}

function pkgDir(pkg: string) {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return path.dirname(pkgJson);
}

// ---------- Converters ----------
async function htmlToMarkdown(buf: ArrayBuffer, baseUrl: string) {
  const html = new TextDecoder("utf-8").decode(new Uint8Array(buf));
  const $ = cheerio.load(html);
  const inner = $("main").length
    ? $("main").html() ?? ""
    : $("body").html() ?? html;
  absolutizeLinks($, baseUrl);

  // NHM: pasar un único string (la config se pasa en el constructor)
  const nhm = new NodeHtmlMarkdown({ useLinkReferenceDefinitions: false });
  const md = nhm.translate(inner || html);
  return cleanWhitespace(md);
}

async function pdfToMarkdown(buf: ArrayBuffer) {
  const data = new Uint8Array(buf);
  const standardFontDataUrl = path.join(
    pkgDir("pdfjs-dist"),
    "standard_fonts/"
  );
  const pdf = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl, // evita los warnings de fuentes
  }).promise;

  let out: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((it: any) => ("str" in it ? it.str : ""))
      .join(" ");
    out.push(`\n\n<!-- Page ${p} -->\n\n${text}`);
  }
  return cleanWhitespace(out.join("\n"));
}

// ---------- Networking ----------
async function download(url: string, timeoutMs = 30000, tries = 3) {
  let lastErr: any;
  const u = new URL(url);
  for (let t = 1; t <= tries; t++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
          "Accept-Language": "es-AR,es;q=0.9,en;q=0.6",
          Referer: "https://www.google.com/",
          Origin: u.origin,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * t)); // backoff lineal
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

// ---------- Main ----------
(async function main() {
  console.log(`DOCS_ROOT = ${DOCS_ROOT}`);
  let ok = 0,
    fail = 0;

  for (const i of items) {
    const finalUrl =
      mode === "mock" ? `mock://${sanitizeScalar(i.slug)}` : normalizeUrl(i.fuente_url);
    try {
      const outPath = path.resolve(DOCS_ROOT, i.salida_relativa);
      ensureDir(outPath);
      let md = "";
      let contentType: "html" | "pdf" | "mock" = "mock";

      if (mode === "mock") {
        md = generateMockContent(i);
        contentType = "mock";
      } else {
        const buf = await download(finalUrl);
        if (i.archivo_tipo === "html") {
          md = await htmlToMarkdown(buf, finalUrl);
          contentType = "html";
        } else if (i.archivo_tipo === "pdf") {
          md = await pdfToMarkdown(buf);
          contentType = "pdf";
        } else {
          throw new Error(`archivo_tipo no soportado: ${i.archivo_tipo}`);
        }
      }

      const fm = frontMatter(i, contentType, finalUrl);
      fs.writeFileSync(outPath, fm + md, "utf-8");
      const tag = mode === "mock" ? "MOCK" : "OK";
      console.log(`${tag} -> ${i.slug} -> ${path.relative(DOCS_ROOT, outPath)}`);
      ok++;
    } catch (e: any) {
      console.error(`ERR -> ${i.slug}: ${e.message}`);
      fail++;
    }
  }

  console.log(`Resumen: ${ok} escritos, ${fail} errores`);
})();
