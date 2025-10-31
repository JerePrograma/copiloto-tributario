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

// ---------- CLI ----------
function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const manifestPathArg = getArg("--manifest");
const outDirArg = getArg("--out");

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

function frontMatter(i: Item, contentType: "html" | "pdf", finalUrl: string) {
  const fetchedAt = new Date().toISOString();
  return [
    "---",
    `slug: ${JSON.stringify(i.slug)}`,
    `jurisdiccion: ${JSON.stringify(i.jurisdiccion)}`,
    `organismo: ${JSON.stringify(i.organismo)}`,
    `tipo: ${JSON.stringify(i.tipo)}`,
    `numero: ${JSON.stringify(i.numero)}`,
    `anio: ${i.anio}`,
    `publicacion: ${JSON.stringify(i.publicacion)}`,
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
    const finalUrl = normalizeUrl(i.fuente_url);
    try {
      const outPath = path.resolve(DOCS_ROOT, i.salida_relativa);
      ensureDir(outPath);

      const buf = await download(finalUrl);
      let md = "";
      if (i.archivo_tipo === "html") {
        md = await htmlToMarkdown(buf, finalUrl);
      } else if (i.archivo_tipo === "pdf") {
        md = await pdfToMarkdown(buf);
      } else {
        throw new Error(`archivo_tipo no soportado: ${i.archivo_tipo}`);
      }

      const fm = frontMatter(i, i.archivo_tipo, finalUrl);
      fs.writeFileSync(outPath, fm + md, "utf-8");
      console.log(`OK  -> ${i.slug} -> ${path.relative(DOCS_ROOT, outPath)}`);
      ok++;
    } catch (e: any) {
      console.error(`ERR -> ${i.slug}: ${e.message}`);
      fail++;
    }
  }

  console.log(`Resumen: ${ok} escritos, ${fail} errores`);
})();
