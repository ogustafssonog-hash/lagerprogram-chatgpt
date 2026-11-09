import { Router } from "express";
import { requireAdmin } from "../app";
import {
  db,
  lagerPosterTable,
  lagerOmradenTable,
  lagerFackTable,
  lagerInventeringarTable,
  lagerInventeringForvantadeTable,
  lagerInventeringSkanningarTable,
  lagerInventeringSkanningRaderTable,
  lagerInventeringPriserTable,
  lagerInventeringsomgangarTable,
  lagerInventeringsomgangFackTable,
  lagerInventeringsomgangGlobalSnapshotTable,
  lagerInventeringsomgangKorrigeringarTable,
  lagerInventeringsomgangSaknatBeslutTable,
  lagerHistorikTable,
  specPaketTable,
  specifikationerTable,
} from "@workspace/db";
import { and, eq, inArray, desc, ne, lt, lte, sql, isNull, isNotNull } from "drizzle-orm";
import { iLagerConditions, hamtaAktuellaPaketRader, buildLagerSearchConditions } from "../lib/lagerFilters";
import { applyLagerPatch } from "./lager";

// Task #13 — Inventering av lagerfack.
//
// Verksamhetsregel (delad med Task #18): ett pktNr är ETT fysiskt paket,
// även när det ligger som flera lager_poster-rader (en per längd).
// Inventering sker därför alltid på paketnivå — en skanning täcker
// samtliga aktuella rader med samma pktNr, aldrig en enskild rad.
//
// Klassificering av en skanning (görs mot sessionens omrade_id+fack_id):
//  - forvantad_hittad : alla aktuella rader ligger i sessionens fack
//  - felplacerad      : rader finns i lager, men i ett annat fack/omrade
//                        (eller helt utan fack)
//  - okand            : inga aktuella rader hittades för pktNr:et alls
//  - otydlig_match    : systerraderna är oense om omrade_id/fack_id sinsemellan
//                        — löses ALDRIG automatiskt.

const router = Router();

type Klassificering = "forvantad_hittad" | "felplacerad" | "okand" | "otydlig_match";
export type InventeringTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lasInventeringsomgangForMutation(tx: InventeringTx, omgangId: number) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventeringsomgang:${omgangId}`}, 0))`);
  const [omgang] = await tx
    .select()
    .from(lagerInventeringsomgangarTable)
    .where(eq(lagerInventeringsomgangarTable.id, omgangId))
    .for("update");
  return omgang ?? null;
}

type LastSessionsmutationResultat<T> =
  | { ok: true; value: T }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Serialiserar alla mutationer som tillhör en inventeringsomgång mot samma
 * omgångsrad. Om avslutet vann låset först nekas mutationen; om mutationen
 * vann väntar avslutet tills hela mutationen har committats.
 */
async function medLastOmgångForSessionsmutation<T>(
  id: number,
  mutation: (tx: InventeringTx, session: typeof lagerInventeringarTable.$inferSelect) => Promise<T>,
): Promise<LastSessionsmutationResultat<T>> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(lagerInventeringarTable).where(eq(lagerInventeringarTable.id, id));
    if (!session) return { ok: false as const, status: 404 as const, error: "Sessionen hittades inte" };

    if (session.omgangId !== null) {
      const omgang = await lasInventeringsomgangForMutation(tx, session.omgangId);
      if (!omgang || omgang.status !== "pagaende") {
        return {
          ok: false as const,
          status: 409 as const,
          error: "Inventeringsomgången är avslutad och kan inte längre ändras",
        };
      }
    }

    return { ok: true as const, value: await mutation(tx, session) };
  });
}

export function toNumber(val: unknown): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function klassificeraRader(
  rows: (typeof lagerPosterTable.$inferSelect)[],
  sessionOmradeId: number,
  sessionFackId: number,
): Klassificering {
  if (rows.length === 0) return "okand";
  const omradeIds = new Set(rows.map((r) => r.omradeId ?? null));
  const fackIds = new Set(rows.map((r) => r.fackId ?? null));
  if (omradeIds.size > 1 || fackIds.size > 1) return "otydlig_match";
  const [omradeId] = omradeIds;
  const [fackId] = fackIds;
  if (omradeId === sessionOmradeId && fackId === sessionFackId) return "forvantad_hittad";
  return "felplacerad";
}

// --- Avrapporterade paket funna vid inventering ------------------------
//
// Typiskt fall: en hyvelorder (spec) bekräftas med paket A → A får datumUt
// och lämnar "aktuellt lager". I verkligheten plockas ett annat paket B
// (A står längst in) utan att ordern ändras. Vid inventeringen hittas då A
// fysiskt (avrapporterat i systemet) medan B saknas (finns kvar i systemet).
// Ett avrapporterat paket (datumUt satt, ej mjukraderat) får därför inte
// längre klassas som "okänt" — användaren ska få veta vilken order det
// sitter på och kunna rätta ordern (byta A mot B) eller återinföra A.
type LagerRad = typeof lagerPosterTable.$inferSelect;

async function hamtaAvrapporteradeRader(tx: InventeringTx | typeof db, pktNr: string): Promise<LagerRad[]> {
  return tx
    .select()
    .from(lagerPosterTable)
    .where(
      and(
        eq(lagerPosterTable.pktNr, pktNr),
        isNull(lagerPosterTable.raderadAt),
        isNotNull(lagerPosterTable.datumUt),
        sql`(${lagerPosterTable.avrappTyp} IS NULL OR ${lagerPosterTable.avrappTyp} <> 'spec_import')`,
      ),
    );
}

const SPEC_TYP_LABEL: Record<string, string> = {
  hyvling: "Hyvelorder",
  leverans: "Leveransspec",
  impregnering: "Behandlingsorder",
};

type SpecKoppling = {
  id: number;
  typ: string;
  etikett: string; // t.ex. "Hyvelorder 123"
  nr: number | null;
  kund: string | null;
  orderNr: string | null;
  bekraftadAt: string | null;
};

// Vilken bekräftad spec/order som innehåller (någon av) lagerraderna.
async function hamtaSpecKoppling(tx: InventeringTx | typeof db, lagerIds: number[]) {
  if (lagerIds.length === 0) return { spec: null as SpecKoppling | null, specPaket: [] as (typeof specPaketTable.$inferSelect)[] };
  const specPaket = await tx.select().from(specPaketTable).where(inArray(specPaketTable.lagerPostId, lagerIds));
  if (specPaket.length === 0) return { spec: null, specPaket: [] };
  const specs = await tx
    .select()
    .from(specifikationerTable)
    .where(inArray(specifikationerTable.id, Array.from(new Set(specPaket.map((sp) => sp.specId)))));
  const bekraftade = specs.filter((sp) => sp.status === "bekraftad").sort((a, b) => b.id - a.id);
  const valdSpec = bekraftade[0];
  if (!valdSpec) return { spec: null, specPaket: [] };
  const nr = valdSpec.typ === "hyvling" ? valdSpec.hyvlingNr : valdSpec.specNr;
  return {
    spec: {
      id: valdSpec.id,
      typ: valdSpec.typ,
      etikett: `${SPEC_TYP_LABEL[valdSpec.typ] ?? "Order"} ${nr ?? valdSpec.id}`,
      nr: nr ?? null,
      kund: valdSpec.kund ?? null,
      orderNr: valdSpec.orderNr ?? null,
      bekraftadAt: valdSpec.bekraftadAt ? valdSpec.bekraftadAt.toISOString() : null,
    } satisfies SpecKoppling,
    specPaket: specPaket.filter((sp) => sp.specId === valdSpec.id),
  };
}

async function beskrivAvrapportering(tx: InventeringTx | typeof db, rader: LagerRad[]) {
  const { spec } = await hamtaSpecKoppling(tx, rader.map((r) => r.id));
  const datumUt = rader.map((r) => r.datumUt).filter((d): d is string => !!d).sort().pop() ?? null;
  return {
    datumUt,
    avrappTyp: rader[0]?.avrappTyp ?? null,
    spec,
    // Utan koppling till en bekräftad order finns inget att "byta" — då kan
    // paketet bara återinföras i lager.
    kanByta: spec !== null,
    kanAterinforas: spec === null,
  };
}

// Skriver en skanning (+ frysta rader) för ett pktNr. Delas av vanlig
// skanning och av "byt paket"/"återinför" som skannar in paketet i samma
// transaktion som lagerrättelsen.
async function registreraSkanning(
  tx: InventeringTx,
  session: typeof lagerInventeringarTable.$inferSelect,
  pktNr: string,
  metod: string,
  userId: string,
  rader: LagerRad[],
) {
  const klassificering = klassificeraRader(rader, session.omradeId, session.fackId);
  const [skanning] = await tx
    .insert(lagerInventeringSkanningarTable)
    .values({
      inventeringId: session.id,
      pktNrSkannat: pktNr,
      klassificering,
      metod,
      skannadAv: userId,
      frystUtanRader: rader.length === 0,
    })
    .returning();

  if (rader.length > 0) {
    await tx.insert(lagerInventeringSkanningRaderTable).values(
      rader.map((r) => ({
        skanningId: skanning.id,
        lagerId: r.id,
        omradeIdVidSkanning: r.omradeId,
        fackIdVidSkanning: r.fackId,
        traslagVidSkanning: r.traslag,
        profilVidSkanning: r.profil,
        kvalitetVidSkanning: r.kvalitet,
        nomTjocklekVidSkanning: r.nomTjocklek,
        nomBreddVidSkanning: r.nomBredd,
        actTjocklekVidSkanning: r.actTjocklek,
        actBreddVidSkanning: r.actBredd,
        langdDmVidSkanning: r.langdDm,
        antalVidSkanning: r.antal,
        nomM3VidSkanning: r.m3,
      })),
    );
  }
  return { skanning, klassificering };
}

export async function hamtaSession(id: number) {
  const [session] = await db.select().from(lagerInventeringarTable).where(eq(lagerInventeringarTable.id, id));
  return session ?? null;
}

// --- Värdering (utökning av Task #13) --------------------------------
//
// Värdering sker alltid på FYSISK PAKETNIVÅ (pktNr) och uteslutande på
// NOM m³ — aldrig ACT m³ (se lager_poster.m3, som redan är "alltid
// nominell m³", jfr lib/lagerFilters.ts / routes/lager.ts). Om ett pktNr
// består av flera lager_poster-rader (en per längd) summeras deras m3
// till paketets totala NOM m³ innan priset räknas.
//
// Pris (kr/NOM m³) och den beräknade NOM m³-summan SNAPSHOTAS till
// `lager_inventering_priser` i samma stund paketet prissätts, så att en
// senare ändring av lagerdata eller priser aldrig kan ändra en redan
// sparad historisk inventeringsvärdering. Prissättning är helt frivillig
// och separat från själva skanningen — den rör aldrig lager_poster och
// ändrar aldrig klassificering eller placering.

// Längdnedbrytning: hur många styck som finns per unik längd inom ett
// pktNr (Task: felplacerade-UX). Ett pktNr kan ha flera lager_poster-rader
// — en per längd — och listan "Felplacerade paket" ska visa dem samlat som
// ETT kort/rad men med längderna specificerade var för sig, t.ex.
// "2,4 m × 12 st · 2,7 m × 39 st".
export type LangdBrytning = { langdDm: number; styck: number };

function brytNedPerLangd<T>(rader: T[], langdDm: (r: T) => number, styck: (r: T) => number): LangdBrytning[] {
  const perLangd = new Map<number, number>();
  for (const r of rader) {
    const l = langdDm(r);
    perLangd.set(l, (perLangd.get(l) ?? 0) + styck(r));
  }
  return Array.from(perLangd.entries())
    .map(([langdDm, styck]) => ({ langdDm, styck }))
    .sort((a, b) => a.langdDm - b.langdDm);
}

export type PaketDetaljer = {
  traslag: string | null;
  profil: string | null;
  kvalitet: string | null;
  nomTjocklek: string | null;
  nomBredd: string | null;
  // Faktiska (ACT) mått — enbart för visning/identifiering, aldrig för
  // volymberäkning (den är alltid NOM, se nomM3 nedan).
  actTjocklek: string | null;
  actBredd: string | null;
  langder: number[];
  langdBrytning: LangdBrytning[];
  styck: number;
  nomM3: number;
  omradeId: number | null;
  fackId: number | null;
  blandadPlacering: boolean;
};

export function sammanstallPaketDetaljer(rader: (typeof lagerPosterTable.$inferSelect)[]): PaketDetaljer {
  const forsta = rader[0];
  const omradeIds = new Set(rader.map((r) => r.omradeId ?? null));
  const fackIds = new Set(rader.map((r) => r.fackId ?? null));
  const blandadPlacering = omradeIds.size > 1 || fackIds.size > 1;
  return {
    traslag: forsta?.traslag ?? null,
    profil: forsta?.profil ?? null,
    kvalitet: forsta?.kvalitet ?? null,
    nomTjocklek: forsta?.nomTjocklek ?? null,
    nomBredd: forsta?.nomBredd ?? null,
    actTjocklek: forsta?.actTjocklek ?? null,
    actBredd: forsta?.actBredd ?? null,
    langder: Array.from(new Set(rader.map((r) => toNumber(r.langdDm)))).sort((a, b) => a - b),
    langdBrytning: brytNedPerLangd(rader, (r) => toNumber(r.langdDm), (r) => r.antal ?? 0),
    styck: rader.reduce((sum, r) => sum + (r.antal ?? 0), 0),
    nomM3: rader.reduce((sum, r) => sum + toNumber(r.m3), 0),
    omradeId: blandadPlacering ? null : Array.from(omradeIds)[0] ?? null,
    fackId: blandadPlacering ? null : Array.from(fackIds)[0] ?? null,
    blandadPlacering,
  };
}

// Avgör om en skannings underliggande rader har fullständig fryst
// produkt-/mängddata (dvs. skannades EFTER att frysningen infördes).
// Rader från en och samma skanning skrivs alltid i en enda batch, så de
// har antingen alla frysta fält eller inga — ett per-skanning-avgörande
// räcker och undviker en delvis frusen/live-blandning per rad.
export function arSkanningFryst(skanningRader: (typeof lagerInventeringSkanningRaderTable.$inferSelect)[]): boolean {
  return skanningRader.length > 0 && skanningRader.every((r) => r.nomM3VidSkanning !== null && r.nomM3VidSkanning !== undefined);
}

const NOLL_PAKETDETALJER: PaketDetaljer = {
  traslag: null,
  profil: null,
  kvalitet: null,
  nomTjocklek: null,
  nomBredd: null,
  actTjocklek: null,
  actBredd: null,
  langder: [],
  langdBrytning: [],
  styck: 0,
  nomM3: 0,
  omradeId: null,
  fackId: null,
  blandadPlacering: false,
};

// Bygger paketdetaljer från den FRYSTA skanningshistoriken — detta är vad
// som gör en avslutad inventering till en oföränderlig historisk
// ögonblicksbild.
//
// `frystUtanRader` (från lager_inventering_skanningar.fryst_utan_rader)
// avgör vad ETT TOMT radresultat betyder:
//  - true  : skanningen bekräftades sakna aktuella lagerposter ("okänd")
//            och frystes MEDVETET som en nollpunkt — returnerar noll-
//            detaljer, ALDRIG ett live-uppslag (annars skulle en senare,
//            helt orelaterad lagerpost som råkar återanvända samma pktNr
//            kunna ge en redan avslutad inventering påhittat NOM m³ år
//            senare).
//  - null/false (skanning från innan denna flagga infördes): oförändrat
//            beteende — returnerar null så anroparen faller tillbaka på
//            ett live-uppslag, precis som tidigare.
// Om skanningen HAR rader räknas frysningen som vanligt, oavsett flaggan.
export function paketDetaljerFranFrystHistorik(
  skanningRader: (typeof lagerInventeringSkanningRaderTable.$inferSelect)[],
  frystUtanRader?: boolean | null,
): PaketDetaljer | null {
  if (skanningRader.length === 0) {
    return frystUtanRader === true ? NOLL_PAKETDETALJER : null;
  }
  if (!arSkanningFryst(skanningRader)) return null;
  const forsta = skanningRader[0];
  const omradeIds = new Set(skanningRader.map((r) => r.omradeIdVidSkanning ?? null));
  const fackIds = new Set(skanningRader.map((r) => r.fackIdVidSkanning ?? null));
  const blandadPlacering = omradeIds.size > 1 || fackIds.size > 1;
  return {
    traslag: forsta.traslagVidSkanning,
    profil: forsta.profilVidSkanning,
    kvalitet: forsta.kvalitetVidSkanning,
    nomTjocklek: forsta.nomTjocklekVidSkanning,
    nomBredd: forsta.nomBreddVidSkanning,
    // Nullable även för skanningar från EFTER frysningen av ACT-mått
    // infördes fallerar aldrig till live-data — se schema-kommentaren.
    actTjocklek: forsta.actTjocklekVidSkanning ?? null,
    actBredd: forsta.actBreddVidSkanning ?? null,
    langder: Array.from(new Set(skanningRader.map((r) => toNumber(r.langdDmVidSkanning)))).sort((a, b) => a - b),
    langdBrytning: brytNedPerLangd(skanningRader, (r) => toNumber(r.langdDmVidSkanning), (r) => r.antalVidSkanning ?? 0),
    styck: skanningRader.reduce((sum, r) => sum + (r.antalVidSkanning ?? 0), 0),
    nomM3: skanningRader.reduce((sum, r) => sum + toNumber(r.nomM3VidSkanning), 0),
    omradeId: blandadPlacering ? null : Array.from(omradeIds)[0] ?? null,
    fackId: blandadPlacering ? null : Array.from(fackIds)[0] ?? null,
    blandadPlacering,
  };
}

// --- Frysning av FÖRVÄNTADE/SAKNADE paket (Task #20) -------------------
//
// Samma mönster som för skannade paket ovan, men källan är
// lager_inventering_forvantade och tidpunkten är INVENTERINGSSTART istället
// för skanningstillfället. En rad grupp av forvantade-rader (samma pktNr)
// har antingen alla eller inga frysta fält, eftersom hela snapshoten
// skrivs i en enda batch när sessionen startas.
function arForvantadGruppFryst(rader: (typeof lagerInventeringForvantadeTable.$inferSelect)[]): boolean {
  return rader.length > 0 && rader.every((r) => r.nomM3VidStart !== null && r.nomM3VidStart !== undefined);
}

export function paketDetaljerFranFrystStart(rader: (typeof lagerInventeringForvantadeTable.$inferSelect)[]): PaketDetaljer | null {
  if (!arForvantadGruppFryst(rader)) return null;
  const forsta = rader[0];
  const omradeIds = new Set(rader.map((r) => r.omradeIdVidStart ?? null));
  const fackIds = new Set(rader.map((r) => r.fackIdVidStart ?? null));
  const blandadPlacering = omradeIds.size > 1 || fackIds.size > 1;
  return {
    traslag: forsta.traslagVidStart,
    profil: forsta.profilVidStart,
    kvalitet: forsta.kvalitetVidStart,
    nomTjocklek: forsta.nomTjocklekVidStart,
    nomBredd: forsta.nomBreddVidStart,
    // lager_inventering_forvantade fryser inga ACT-mått (endast NOM) — se
    // schema-kommentaren för den tabellen.
    actTjocklek: null,
    actBredd: null,
    langder: Array.from(new Set(rader.map((r) => toNumber(r.langdDmVidStart)))).sort((a, b) => a - b),
    langdBrytning: brytNedPerLangd(rader, (r) => toNumber(r.langdDmVidStart), (r) => r.antalVidStart ?? 0),
    styck: rader.reduce((sum, r) => sum + (r.antalVidStart ?? 0), 0),
    nomM3: rader.reduce((sum, r) => sum + toNumber(r.nomM3VidStart), 0),
    omradeId: blandadPlacering ? null : (Array.from(omradeIds)[0] ?? null),
    fackId: blandadPlacering ? null : (Array.from(fackIds)[0] ?? null),
    blandadPlacering,
  };
}

// Bygger paketdetaljer från den GLOBALA startsnapshoten för en hel lager-/
// årsinventering (se lagerInventeringsomgangGlobalSnapshotTable). Samma
// mönster som paketDetaljerFranFrystStart, men källan är omgångens EGEN
// globala snapshot (ett pktNr oavsett vilket eller om något fack det låg
// i) istället för en enskild sessions fack-scopade förväntade-lista — och
// ACT-mått fryses också här (den tabellen har dem, till skillnad från
// lager_inventering_forvantade, se schema-kommentaren).
export function paketDetaljerFranGlobalSnapshot(
  rader: (typeof lagerInventeringsomgangGlobalSnapshotTable.$inferSelect)[],
): PaketDetaljer {
  const forsta = rader[0];
  const omradeIds = new Set(rader.map((r) => r.omradeIdVidStart ?? null));
  const fackIds = new Set(rader.map((r) => r.fackIdVidStart ?? null));
  const blandadPlacering = omradeIds.size > 1 || fackIds.size > 1;
  return {
    traslag: forsta.traslagVidStart,
    profil: forsta.profilVidStart,
    kvalitet: forsta.kvalitetVidStart,
    nomTjocklek: forsta.nomTjocklekVidStart,
    nomBredd: forsta.nomBreddVidStart,
    actTjocklek: forsta.actTjocklekVidStart,
    actBredd: forsta.actBreddVidStart,
    langder: Array.from(new Set(rader.map((r) => toNumber(r.langdDmVidStart)))).sort((a, b) => a - b),
    langdBrytning: brytNedPerLangd(rader, (r) => toNumber(r.langdDmVidStart), (r) => r.antalVidStart ?? 0),
    styck: rader.reduce((sum, r) => sum + (r.antalVidStart ?? 0), 0),
    nomM3: rader.reduce((sum, r) => sum + toNumber(r.nomM3VidStart), 0),
    omradeId: blandadPlacering ? null : (Array.from(omradeIds)[0] ?? null),
    fackId: blandadPlacering ? null : (Array.from(fackIds)[0] ?? null),
    blandadPlacering,
  };
}

// Sammanfattar värderingsläget för en session: total NOM m³ (över samtliga
// SKANNADE pktNr — dvs allt som fysiskt bekräftats finnas, oavsett
// klassificering), hur mycket av detta som är prissatt (fryst
// snapshot-summa), samt totalt lagervärde. "Ej prissatt" räknas alltid ut
// som totalt minus prissatt, aldrig lagrat, så den alltid stämmer även om
// nya paket skannas efter att andra redan prissatts.
export async function beraknaVardeSummering(sessionId: number) {
  const skanningar = await db
    .select({
      id: lagerInventeringSkanningarTable.id,
      pktNr: lagerInventeringSkanningarTable.pktNrSkannat,
      frystUtanRader: lagerInventeringSkanningarTable.frystUtanRader,
    })
    .from(lagerInventeringSkanningarTable)
    .where(eq(lagerInventeringSkanningarTable.inventeringId, sessionId));

  const priser = await db
    .select()
    .from(lagerInventeringPriserTable)
    .where(eq(lagerInventeringPriserTable.inventeringId, sessionId));
  const prisMap = new Map(priser.map((p) => [p.pktNr, p]));

  // NOM m³ för OPRISSATTA paket ska ändå vara den FRYSTA
  // skanningshistoriken (`nom_m3_vid_skanning`) — även en inventering utan
  // en enda prissättning ska kunna jämföras årsvis oberoende av dagens
  // lagerdata. Endast skanningar från innan denna frysning infördes
  // saknar den och faller tillbaka på ett live-uppslag.
  const skanningIds = skanningar.map((s) => s.id);
  const raderPerSkanning = new Map<number, (typeof lagerInventeringSkanningRaderTable.$inferSelect)[]>();
  if (skanningIds.length > 0) {
    const allaRader = await db
      .select()
      .from(lagerInventeringSkanningRaderTable)
      .where(inArray(lagerInventeringSkanningRaderTable.skanningId, skanningIds));
    for (const rad of allaRader) {
      const arr = raderPerSkanning.get(rad.skanningId) ?? [];
      arr.push(rad);
      raderPerSkanning.set(rad.skanningId, arr);
    }
  }

  let totaltNomM3 = 0;
  let prissattNomM3 = 0;
  let totaltLagervarde = 0;
  for (const s of skanningar) {
    const pris = prisMap.get(s.pktNr);
    if (pris) {
      // Fryst snapshot — påverkas aldrig av senare ändringar i lagret.
      totaltNomM3 += toNumber(pris.nomM3);
      prissattNomM3 += toNumber(pris.nomM3);
      totaltLagervarde += toNumber(pris.lagervarde);
    } else {
      const rader = raderPerSkanning.get(s.id) ?? [];
      const detaljer = paketDetaljerFranFrystHistorik(rader, s.frystUtanRader);
      if (detaljer) {
        totaltNomM3 += detaljer.nomM3;
      } else {
        const liveRader = await hamtaAktuellaPaketRader(s.pktNr);
        totaltNomM3 += liveRader.reduce((sum, r) => sum + toNumber(r.m3), 0);
      }
    }
  }

  return {
    antalSkannadePaket: skanningar.length,
    antalPrissattaPaket: priser.length,
    totaltNomM3: round2(totaltNomM3),
    prissattNomM3: round2(prissattNomM3),
    ejPrissattNomM3: round2(totaltNomM3 - prissattNomM3),
    totaltLagervarde: round2(totaltLagervarde),
  };
}

// Bygger en fullständig, alltid-återskapningsbar sammanställning av en
// session: förväntade paket (från snapshoten), samtliga skanningar med
// paketdetaljer, samt räknare. Används av GET /:id, POST /:id/skanna,
// POST /:id/avsluta och avvikelseöversikten — så att alla vyer alltid
// visar exakt samma tal.
export async function byggSessionsoversikt(session: typeof lagerInventeringarTable.$inferSelect) {
  const [omrade] = await db.select().from(lagerOmradenTable).where(eq(lagerOmradenTable.id, session.omradeId));
  const [fack] = await db.select().from(lagerFackTable).where(eq(lagerFackTable.id, session.fackId));
  const omgang = session.omgangId
    ? (await db.select().from(lagerInventeringsomgangarTable).where(eq(lagerInventeringsomgangarTable.id, session.omgangId)))[0]
    : undefined;

  const forvantade = await db
    .select()
    .from(lagerInventeringForvantadeTable)
    .where(eq(lagerInventeringForvantadeTable.inventeringId, session.id));

  // Fallback för äldre rader från innan frysningen vid inventeringsstart
  // infördes (se paketDetaljerFranFrystStart) — behövs bara om minst en
  // grupp saknar frysta fält.
  const forvantadeLagerIds = forvantade.map((f) => f.lagerId);
  const forvantadeRaderMap = new Map<number, typeof lagerPosterTable.$inferSelect>();
  if (forvantadeLagerIds.length > 0) {
    const rows = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, forvantadeLagerIds));
    for (const r of rows) forvantadeRaderMap.set(r.id, r);
  }

  type ForvantatPaket = {
    pktNr: string;
    antalRader: number;
    totalAntal: number;
    totalM3: number;
    traslag: string | null;
    profil: string | null;
    kvalitet: string | null;
    nomTjocklek: string | null;
    nomBredd: string | null;
    langder: number[];
    omradeNamn: string | null;
    fackKod: string | null;
  };
  const forvantadeGrupper = new Map<string, (typeof lagerInventeringForvantadeTable.$inferSelect)[]>();
  for (const f of forvantade) {
    const arr = forvantadeGrupper.get(f.pktNr) ?? [];
    arr.push(f);
    forvantadeGrupper.set(f.pktNr, arr);
  }
  const forvantadePaket: ForvantatPaket[] = Array.from(forvantadeGrupper.entries()).map(([pktNr, rader]) => {
    // Fryst snapshot vid inventeringsstart — påverkas aldrig av senare
    // ändringar i lagret (flytt, delning, uttag). Endast rader från innan
    // denna frysning infördes faller tillbaka på ett live-uppslag.
    const frusenDetalj = paketDetaljerFranFrystStart(rader);
    if (frusenDetalj) {
      return {
        pktNr,
        antalRader: rader.length,
        totalAntal: frusenDetalj.styck,
        totalM3: frusenDetalj.nomM3,
        traslag: frusenDetalj.traslag,
        profil: frusenDetalj.profil,
        kvalitet: frusenDetalj.kvalitet,
        nomTjocklek: frusenDetalj.nomTjocklek,
        nomBredd: frusenDetalj.nomBredd,
        langder: frusenDetalj.langder,
        omradeNamn: omrade?.namn ?? null,
        fackKod: fack?.kod ?? null,
      };
    }
    let totalAntal = 0;
    let totalM3 = 0;
    for (const f of rader) {
      const rad = forvantadeRaderMap.get(f.lagerId);
      totalAntal += rad?.antal ?? 0;
      totalM3 += toNumber(rad?.m3);
    }
    return {
      pktNr,
      antalRader: rader.length,
      totalAntal,
      totalM3,
      traslag: null,
      profil: null,
      kvalitet: null,
      nomTjocklek: null,
      nomBredd: null,
      langder: [],
      omradeNamn: null,
      fackKod: null,
    };
  });

  const skanningar = await db
    .select()
    .from(lagerInventeringSkanningarTable)
    .where(eq(lagerInventeringSkanningarTable.inventeringId, session.id))
    .orderBy(desc(lagerInventeringSkanningarTable.skannadAt));

  const skanningIds = skanningar.map((s) => s.id);
  const raderPerSkanning = new Map<number, (typeof lagerInventeringSkanningRaderTable.$inferSelect)[]>();
  const allaSkanningRader =
    skanningIds.length > 0
      ? await db
          .select()
          .from(lagerInventeringSkanningRaderTable)
          .where(inArray(lagerInventeringSkanningRaderTable.skanningId, skanningIds))
      : [];
  for (const rad of allaSkanningRader) {
    const arr = raderPerSkanning.get(rad.skanningId) ?? [];
    arr.push(rad);
    raderPerSkanning.set(rad.skanningId, arr);
  }
  const alliaLagerIds = Array.from(new Set(allaSkanningRader.map((r) => r.lagerId)));
  const lagerRaderMap = new Map<number, typeof lagerPosterTable.$inferSelect>();
  if (alliaLagerIds.length > 0) {
    const rows = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, alliaLagerIds));
    for (const r of rows) lagerRaderMap.set(r.id, r);
  }

  // Live-omklassificering: hämtar AKTUELLT läge för samtliga skannade
  // pktNr i en enda batch-fråga, så att en ev. korrigering (eller annan
  // flytt) som skett EFTER skanningen reflekteras direkt — en gammal
  // "felplacerad"-skanning ska inte visas som olöst avvikelse för evigt
  // om paketet redan flyttats till rätt plats sedan dess.
  const skannadePktNrLista = Array.from(new Set(skanningar.map((s) => s.pktNrSkannat)));
  const aktuellaRaderPerPkt = new Map<string, (typeof lagerPosterTable.$inferSelect)[]>();
  if (skannadePktNrLista.length > 0) {
    const rows = await db
      .select()
      .from(lagerPosterTable)
      .where(and(inArray(lagerPosterTable.pktNr, skannadePktNrLista), ...iLagerConditions()));
    for (const r of rows) {
      const key = r.pktNr ?? "";
      const arr = aktuellaRaderPerPkt.get(key) ?? [];
      arr.push(r);
      aktuellaRaderPerPkt.set(key, arr);
    }
  }

  const skannadeDetaljer = skanningar.map((s) => {
    const rader = raderPerSkanning.get(s.id) ?? [];
    // Historiska mängder (styck/NOM m³) läses från den FRYSTA
    // skanningshistoriken när den finns — annars (skanningar från innan
    // frysningen infördes) faller de tillbaka på ett live-uppslag, precis
    // som tidigare.
    const frusenDetalj = paketDetaljerFranFrystHistorik(rader, s.frystUtanRader);
    let detalj: PaketDetaljer;
    if (frusenDetalj) {
      detalj = frusenDetalj;
    } else {
      // Skanningar från innan frysningen infördes: faller tillbaka på ett
      // live-uppslag av samma underliggande lager_poster-rader, precis som
      // tidigare (men via sammanstallPaketDetaljer så att produktdata/
      // längdnedbrytning byggs på samma sätt som för frysta rader).
      const lpRader = rader
        .map((rad) => lagerRaderMap.get(rad.lagerId))
        .filter((r): r is typeof lagerPosterTable.$inferSelect => !!r);
      detalj = lpRader.length > 0 ? sammanstallPaketDetaljer(lpRader) : NOLL_PAKETDETALJER;
    }
    const aktuellKlassificering = klassificeraRader(
      aktuellaRaderPerPkt.get(s.pktNrSkannat) ?? [],
      session.omradeId,
      session.fackId,
    );
    return {
      id: s.id,
      pktNr: s.pktNrSkannat,
      klassificeringVidSkanning: s.klassificering as Klassificering,
      klassificering: aktuellKlassificering,
      metod: s.metod,
      skannadAv: s.skannadAv,
      skannadAt: s.skannadAt.toISOString(),
      antalRader: rader.length,
      totalAntal: detalj.styck,
      totalM3: detalj.nomM3,
      // Produktdata för "Felplacerade paket"-listan (Task: felplacerade-UX).
      // Kommer i första hand från den frysta skanningshistoriken — se
      // paketDetaljerFranFrystHistorik.
      traslag: detalj.traslag,
      profil: detalj.profil,
      kvalitet: detalj.kvalitet,
      nomTjocklek: detalj.nomTjocklek,
      nomBredd: detalj.nomBredd,
      actTjocklek: detalj.actTjocklek,
      actBredd: detalj.actBredd,
      langdBrytning: detalj.langdBrytning,
      fortfarandeAvvikande: aktuellKlassificering !== "forvantad_hittad",
    };
  });

  const skannadePktNrSet = new Set(skanningar.map((s) => s.pktNrSkannat));
  const saknadePaket = forvantadePaket.filter((p) => !skannadePktNrSet.has(p.pktNr));

  const raknare = {
    forvantadeAntalPaket: forvantadePaket.length,
    hittade: skannadeDetaljer.filter((s) => s.klassificering === "forvantad_hittad").length,
    felplacerade: skannadeDetaljer.filter((s) => s.klassificering === "felplacerad").length,
    okanda: skannadeDetaljer.filter((s) => s.klassificering === "okand").length,
    otydliga: skannadeDetaljer.filter((s) => s.klassificering === "otydlig_match").length,
    saknade: saknadePaket.length,
  };

  return {
    id: session.id,
    status: session.status,
    omradeId: session.omradeId,
    omradeNamn: omrade?.namn ?? null,
    fackId: session.fackId,
    fackKod: fack?.kod ?? null,
    omgangId: session.omgangId,
    omgangNamn: omgang?.namn ?? null,
    startadAv: session.startadAv,
    startadAt: session.startadAt.toISOString(),
    avslutadAv: session.avslutadAv,
    avslutadAt: session.avslutadAt ? session.avslutadAt.toISOString() : null,
    forvantadePaket,
    skanningar: skannadeDetaljer,
    saknadePaket,
    raknare,
  };
}

// --- Fryst omgångsräkning (Task #20) ------------------------------------
//
// Motsvarigheten till byggSessionsoversikt/beraknaVardeSummering, men
// UTESLUTANDE byggd på frysta källor — används för att beräkna en
// inventeringsomgångs permanenta totalsammanställning vid avslut.
//
// Till skillnad från en enkel summering per session (vilket var den
// ursprungliga implementationen) görs detta GLOBALT över samtliga
// sessioner i omgången på en gång: varje fysiskt pktNr slås ihop över ALLA
// sessioner INNAN det räknas, så att
//  - samma pktNr skannat i flera fack-sessioner under omgången, eller
//  - ett pktNr som var "saknat" i en session men hittades i en annan,
// aldrig dubbelräknas i omgångens totaler. Ett sådant pktNr väljer en
// ENDA auktoritativ session (senaste skanningen vinner alltid över
// "saknad") och loggas som en konflikt (se lagerInventeringsomgangKonflikterTable)
// — men respektive fack-sessions EGEN historik (byggSessionsoversikt)
// ändras aldrig av detta.
//
// Klassificeringen (felplacerad/okänd/otydlig) som räknas är alltid den
// VID SKANNINGSTILLFÄLLET (lager_inventering_skanningar.klassificering),
// inte sessionsvyns live-omklassificering — en frusen omgångstotal får
// aldrig kunna ändras av att någon flyttar ett paket efter avslut.
export type OmgangRaknare = {
  antalInventeradePaket: number;
  antalLagerRader: number;
  styck: number;
  styckSaknat: number;
  totaltNomM3: number;
  nomM3Saknat: number;
  prissattNomM3: number;
  ejPrissattNomM3: number;
  totaltLagervarde: number;
  antalSaknade: number;
  antalFelplacerade: number;
  antalOkanda: number;
  antalOtydliga: number;
  antalHittade: number;
  antalKonflikter: number;
};

export type OmgangKonflikt = {
  pktNr: string;
  typ: "dubbelskannad" | "saknad_sedan_hittad" | "saknad_flera_sessioner";
  sessionIdAnvand: number;
  ovrigaSessionIder: number[];
  beskrivning: string;
  // Fryst klassificering av om DENNA konflikttyp krävde ett manuellt beslut
  // innan omgången fick avslutas (idag endast 'dubbelskannad' — se
  // schemakommentaren på lagerInventeringsomgangKonflikterTable).
  blockerarAvslut: boolean;
  losningSessionId: number | null;
  hanteradAv: string | null;
  hanteradAt: Date | null;
};

// En registrerad, ANVÄNDARBEKRÄFTAD lösning för ett dubbelskannat pktNr
// (se lagerInventeringsomgangKonfliktlosningarTable). Endast giltig om
// sessionerVidLosning fortfarande exakt matchar de sessioner som FAKTISKT
// har skannat pktNr:et just nu — annars räknas den som förlegad.
export type OmgangKonfliktlosning = {
  sessionerVidLosning: number[];
  valdSessionId: number | null;
  hanteradAv: string;
  hanteradAt: Date;
};

// En kandidat (en av flera fack-sessioner som skannade samma pktNr) för
// visning i konflikthanterings-UI:t — se GET /:id/dubbelskanningar.
export type OmgangDubbelskanningKandidat = {
  sessionId: number;
  fackId: number;
  skannadAt: Date;
  styck: number;
  nomM3: number;
  klassificering: Klassificering;
};

export type OmgangDubbelskanning = {
  pktNr: string;
  kandidater: OmgangDubbelskanningKandidat[];
  // Är den nuvarande kandidatuppsättningen olöst (ingen giltig lösning,
  // eller en förlegad lösning vars sessioner inte längre matchar)?
  olost: boolean;
  losning: OmgangKonfliktlosning | null;
};

function arraysEqualSorted(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort((x, y) => x - y);
  const bs = [...b].sort((x, y) => x - y);
  return as.every((v, i) => v === bs[i]);
}

function nollOmgangRaknare(): OmgangRaknare {
  return {
    antalInventeradePaket: 0,
    antalLagerRader: 0,
    styck: 0,
    styckSaknat: 0,
    totaltNomM3: 0,
    nomM3Saknat: 0,
    prissattNomM3: 0,
    ejPrissattNomM3: 0,
    totaltLagervarde: 0,
    antalSaknade: 0,
    antalFelplacerade: 0,
    antalOkanda: 0,
    antalOtydliga: 0,
    antalHittade: 0,
    antalKonflikter: 0,
  };
}

export async function beraknaFrystRaknareForOmgang(
  sessioner: (typeof lagerInventeringarTable.$inferSelect)[],
  fackTillOmrade: Map<number, number>,
  // Registrerade konfliktlösningar för DUBBELSKANNADE pktNr, nyckel = pktNr
  // (se lagerInventeringsomgangKonfliktlosningarTable). Systemet får ALDRIG
  // automatiskt anta "senaste skanningen vinner" som slutgiltig sanning för
  // ett sådant pktNr — saknas en giltig lösning hamnar pktNr:et i
  // olostaBlockerandeKonflikter, vilket avslutsvägen (POST :id/avsluta)
  // använder för att vägra avsluta omgången.
  konfliktlosningar: Map<string, OmgangKonfliktlosning> = new Map(),
  query: Pick<typeof db, "select"> = db,
): Promise<{
  totalt: OmgangRaknare;
  perOmrade: Map<number, OmgangRaknare>;
  konflikter: OmgangKonflikt[];
  olostaBlockerandeKonflikter: string[];
  dubbelskanningar: OmgangDubbelskanning[];
}> {
  const totalt = nollOmgangRaknare();
  const perOmrade = new Map<number, OmgangRaknare>();
  const konflikter: OmgangKonflikt[] = [];
  const olostaBlockerandeKonflikter: string[] = [];
  const dubbelskanningar: OmgangDubbelskanning[] = [];
  if (sessioner.length === 0) return { totalt, perOmrade, konflikter, olostaBlockerandeKonflikter, dubbelskanningar };

  const sessionIds = sessioner.map((s) => s.id);
  const sessionMap = new Map(sessioner.map((s) => [s.id, s]));

  // Kör sekventiellt: vid omgångsavslut är `query` en och samma
  // transaktionsanslutning, och node-postgres tillåter inte parallella
  // queries på en klient.
  const allaSkanningar = await query
    .select()
    .from(lagerInventeringSkanningarTable)
    .where(inArray(lagerInventeringSkanningarTable.inventeringId, sessionIds));
  const allaForvantade = await query
    .select()
    .from(lagerInventeringForvantadeTable)
    .where(inArray(lagerInventeringForvantadeTable.inventeringId, sessionIds));
  const allaPriser = await query
    .select()
    .from(lagerInventeringPriserTable)
    .where(inArray(lagerInventeringPriserTable.inventeringId, sessionIds));

  const skanningIds = allaSkanningar.map((s) => s.id);
  const raderPerSkanning = new Map<number, (typeof lagerInventeringSkanningRaderTable.$inferSelect)[]>();
  if (skanningIds.length > 0) {
    const allaRader = await query
      .select()
      .from(lagerInventeringSkanningRaderTable)
      .where(inArray(lagerInventeringSkanningRaderTable.skanningId, skanningIds));
    for (const rad of allaRader) {
      const arr = raderPerSkanning.get(rad.skanningId) ?? [];
      arr.push(rad);
      raderPerSkanning.set(rad.skanningId, arr);
    }
  }

  // Pris är per (session, pktNr) — bygg en snabb uppslagsnyckel.
  const prisMap = new Map<string, (typeof lagerInventeringPriserTable.$inferSelect)>();
  for (const p of allaPriser) prisMap.set(`${p.inventeringId}:${p.pktNr}`, p);

  type SkannadHandelse = {
    sessionId: number;
    fackId: number;
    skannadAt: Date;
    klassificering: Klassificering;
    styck: number;
    antalLagerRader: number;
    nomM3: number;
    prissatt: boolean;
    lagervarde: number;
  };
  type SaknadHandelse = {
    sessionId: number;
    fackId: number;
    sessionStartadAt: Date;
    styck: number;
    antalLagerRader: number;
    nomM3: number;
  };

  const skannadeGrupper = new Map<string, SkannadHandelse[]>();
  const skannadePktNrPerSession = new Map<number, Set<string>>();

  for (const s of allaSkanningar) {
    const session = sessionMap.get(s.inventeringId);
    if (!session) continue;
    const rader = raderPerSkanning.get(s.id) ?? [];
    const frusen = paketDetaljerFranFrystHistorik(rader, s.frystUtanRader);
    let styck: number;
    let nomM3Frusen: number;
    if (frusen) {
      styck = frusen.styck;
      nomM3Frusen = frusen.nomM3;
    } else {
      // Skanning från innan frysningen infördes — fall tillbaka på ett
      // live-uppslag, precis som övriga rapportvyer.
      const liveRader = await hamtaAktuellaPaketRader(s.pktNrSkannat);
      styck = liveRader.reduce((sum, r) => sum + (r.antal ?? 0), 0);
      nomM3Frusen = liveRader.reduce((sum, r) => sum + toNumber(r.m3), 0);
    }
    const pris = prisMap.get(`${s.inventeringId}:${s.pktNrSkannat}`);

    const handelse: SkannadHandelse = {
      sessionId: s.inventeringId,
      fackId: session.fackId,
      skannadAt: s.skannadAt,
      klassificering: s.klassificering as Klassificering,
      styck,
      antalLagerRader: rader.length,
      nomM3: pris ? toNumber(pris.nomM3) : nomM3Frusen,
      prissatt: !!pris,
      lagervarde: pris ? toNumber(pris.lagervarde) : 0,
    };
    const arr = skannadeGrupper.get(s.pktNrSkannat) ?? [];
    arr.push(handelse);
    skannadeGrupper.set(s.pktNrSkannat, arr);

    const setForSession = skannadePktNrPerSession.get(s.inventeringId) ?? new Set<string>();
    setForSession.add(s.pktNrSkannat);
    skannadePktNrPerSession.set(s.inventeringId, setForSession);
  }

  // Förväntade/saknade grupperas per (session, pktNr), exklusive pktNr som
  // skannades i SAMMA session (samma filter som den tidigare per-sessions-
  // logiken) — cross-session-dedupen sker i huvudloopen nedan istället.
  const forvantadeGrupperPerSession = new Map<
    number,
    Map<string, (typeof lagerInventeringForvantadeTable.$inferSelect)[]>
  >();
  for (const f of allaForvantade) {
    if (skannadePktNrPerSession.get(f.inventeringId)?.has(f.pktNr)) continue;
    const perSession = forvantadeGrupperPerSession.get(f.inventeringId) ?? new Map();
    const arr = perSession.get(f.pktNr) ?? [];
    arr.push(f);
    perSession.set(f.pktNr, arr);
    forvantadeGrupperPerSession.set(f.inventeringId, perSession);
  }

  const saknadeGrupper = new Map<string, SaknadHandelse[]>();
  for (const [sessionId, perPkt] of forvantadeGrupperPerSession) {
    const session = sessionMap.get(sessionId);
    if (!session) continue;
    for (const [pktNr, rader] of perPkt) {
      const frusen = paketDetaljerFranFrystStart(rader);
      let styck: number;
      let nomM3: number;
      if (frusen) {
        styck = frusen.styck;
        nomM3 = frusen.nomM3;
      } else {
        const rows = await db
          .select()
          .from(lagerPosterTable)
          .where(inArray(lagerPosterTable.id, rader.map((r) => r.lagerId)));
        styck = rows.reduce((sum, r) => sum + (r.antal ?? 0), 0);
        nomM3 = rows.reduce((sum, r) => sum + toNumber(r.m3), 0);
      }
      const handelse: SaknadHandelse = {
        sessionId,
        fackId: session.fackId,
        sessionStartadAt: session.startadAt,
        styck,
        antalLagerRader: rader.length,
        nomM3,
      };
      const arr = saknadeGrupper.get(pktNr) ?? [];
      arr.push(handelse);
      saknadeGrupper.set(pktNr, arr);
    }
  }

  function ackFor(omradeId: number): OmgangRaknare {
    let acc = perOmrade.get(omradeId);
    if (!acc) {
      acc = nollOmgangRaknare();
      perOmrade.set(omradeId, acc);
    }
    return acc;
  }

  const allaPktNr = new Set<string>([...skannadeGrupper.keys(), ...saknadeGrupper.keys()]);

  for (const pktNr of allaPktNr) {
    const skannade = skannadeGrupper.get(pktNr) ?? [];
    const saknade = saknadeGrupper.get(pktNr) ?? [];
    let omradeId: number | undefined;
    let harKonflikt = false;

    if (skannade.length > 0) {
      // En fysisk träff finns — den vinner ALLTID över "saknad" (kravet:
      // "omgångens slutresultat ska förstå att paketet finns"). Om
      // pktNr:et skannades i FLERA sessioner ("dubbelskannad") får
      // systemet INTE automatiskt anta att den senaste skanningen är den
      // slutgiltiga sanningen om VAR paketet ligger — det kräver ett
      // medvetet, mänskligt beslut (se konfliktlosningar ovan). Fram
      // tills dess används "senaste skanningen" bara som en PROVISORISK
      // punkt för total-räkning (paketet ska aldrig dubbelräknas eller
      // helt utebli), och pktNr:et markeras som blockerande i
      // olostaBlockerandeKonflikter.
      const kandidatSessionIder = Array.from(new Set(skannade.map((h) => h.sessionId))).sort((a, b) => a - b);
      const arDubbelskannad = kandidatSessionIder.length > 1;
      const losning = konfliktlosningar.get(pktNr);
      const losningGiltig = !!losning && arraysEqualSorted(losning.sessionerVidLosning, kandidatSessionIder);

      let auktoritativ: SkannadHandelse;
      if (arDubbelskannad && losningGiltig && losning!.valdSessionId !== null) {
        auktoritativ =
          skannade.find((h) => h.sessionId === losning!.valdSessionId) ??
          skannade.reduce((a, b) => (b.skannadAt > a.skannadAt ? b : a));
      } else {
        auktoritativ = skannade.reduce((a, b) => (b.skannadAt > a.skannadAt ? b : a));
      }
      const ovrigaSkannade = skannade.filter((h) => h !== auktoritativ);
      harKonflikt = ovrigaSkannade.length > 0 || saknade.length > 0;

      if (arDubbelskannad) {
        dubbelskanningar.push({
          pktNr,
          kandidater: skannade.map((h) => ({
            sessionId: h.sessionId,
            fackId: h.fackId,
            skannadAt: h.skannadAt,
            styck: h.styck,
            nomM3: h.nomM3,
            klassificering: h.klassificering,
          })),
          olost: !losningGiltig,
          losning: losningGiltig ? losning! : null,
        });
      }

      if (ovrigaSkannade.length > 0) {
        const sessionIderTxt = kandidatSessionIder.join(", ");
        if (!losningGiltig) olostaBlockerandeKonflikter.push(pktNr);
        konflikter.push({
          pktNr,
          typ: "dubbelskannad",
          sessionIdAnvand: auktoritativ.sessionId,
          ovrigaSessionIder: Array.from(new Set(ovrigaSkannade.map((h) => h.sessionId))),
          beskrivning: losningGiltig
            ? `Paket ${pktNr} skannades i flera fack-sessioner under omgången (session ${sessionIderTxt}). Manuellt bekräftat av ${losning!.hanteradAv}: räknas mot session ${auktoritativ.sessionId}${
                losning!.valdSessionId === null ? " (senaste skanningen, bekräftad utan specifikt val)" : ""
              }.`
            : `Paket ${pktNr} skannades i flera fack-sessioner under omgången (session ${sessionIderTxt}). Kräver manuell hantering innan omgången kan avslutas.`,
          blockerarAvslut: true,
          losningSessionId: losningGiltig ? losning!.valdSessionId : null,
          hanteradAv: losningGiltig ? losning!.hanteradAv : null,
          hanteradAt: losningGiltig ? losning!.hanteradAt : null,
        });
      }
      if (saknade.length > 0) {
        const saknadeSessionerTxt = Array.from(new Set(saknade.map((h) => h.sessionId))).join(", ");
        konflikter.push({
          pktNr,
          typ: "saknad_sedan_hittad",
          sessionIdAnvand: auktoritativ.sessionId,
          ovrigaSessionIder: Array.from(new Set(saknade.map((h) => h.sessionId))),
          beskrivning: `Paket ${pktNr} saknades i fack-session ${saknadeSessionerTxt} men hittades senare i session ${auktoritativ.sessionId} under samma omgång. Räknas som fysiskt funnet i omgångens totaler — sessionens egen avvikelsehistorik ändras inte.`,
          blockerarAvslut: false,
          losningSessionId: null,
          hanteradAv: null,
          hanteradAt: null,
        });
      }

      omradeId = fackTillOmrade.get(auktoritativ.fackId);
      const targets = omradeId !== undefined ? [totalt, ackFor(omradeId)] : [totalt];
      for (const t of targets) {
        t.antalInventeradePaket += 1;
        t.antalLagerRader += auktoritativ.antalLagerRader;
        t.styck += auktoritativ.styck;
        t.totaltNomM3 += auktoritativ.nomM3;
        if (auktoritativ.prissatt) {
          t.prissattNomM3 += auktoritativ.nomM3;
          t.totaltLagervarde += auktoritativ.lagervarde;
        } else {
          t.ejPrissattNomM3 += auktoritativ.nomM3;
        }
        if (auktoritativ.klassificering === "forvantad_hittad") t.antalHittade += 1;
        else if (auktoritativ.klassificering === "felplacerad") t.antalFelplacerade += 1;
        else if (auktoritativ.klassificering === "okand") t.antalOkanda += 1;
        else if (auktoritativ.klassificering === "otydlig_match") t.antalOtydliga += 1;
        if (harKonflikt) t.antalKonflikter += 1;
      }
    } else {
      // Aldrig skannat i någon session i omgången — genuint saknat. Om
      // det (sällsynt) förekommer i flera sessioners saknad-lista väljs
      // den TIDIGASTE sessionen (den ursprungligen förväntade platsen)
      // som auktoritativ, deterministiskt.
      const auktoritativ = saknade.reduce((a, b) => (b.sessionStartadAt < a.sessionStartadAt ? b : a));
      const ovriga = saknade.filter((h) => h !== auktoritativ);
      harKonflikt = ovriga.length > 0;

      if (ovriga.length > 0) {
        const sessionIderTxt = Array.from(new Set(saknade.map((h) => h.sessionId))).join(", ");
        konflikter.push({
          pktNr,
          typ: "saknad_flera_sessioner",
          sessionIdAnvand: auktoritativ.sessionId,
          ovrigaSessionIder: Array.from(new Set(ovriga.map((h) => h.sessionId))),
          beskrivning: `Paket ${pktNr} var förväntat men aldrig skannat, i flera fack-sessioner under omgången (session ${sessionIderTxt}). Räknas som saknat en gång, mot session ${auktoritativ.sessionId}.`,
          blockerarAvslut: false,
          losningSessionId: null,
          hanteradAv: null,
          hanteradAt: null,
        });
      }

      omradeId = fackTillOmrade.get(auktoritativ.fackId);
      const targets = omradeId !== undefined ? [totalt, ackFor(omradeId)] : [totalt];
      for (const t of targets) {
        t.antalInventeradePaket += 1;
        t.antalLagerRader += auktoritativ.antalLagerRader;
        t.antalSaknade += 1;
        t.styckSaknat += auktoritativ.styck;
        t.nomM3Saknat += auktoritativ.nomM3;
        if (harKonflikt) t.antalKonflikter += 1;
      }
    }
  }

  for (const acc of [totalt, ...perOmrade.values()]) {
    acc.totaltNomM3 = round2(acc.totaltNomM3);
    acc.nomM3Saknat = round2(acc.nomM3Saknat);
    acc.prissattNomM3 = round2(acc.prissattNomM3);
    acc.ejPrissattNomM3 = round2(acc.ejPrissattNomM3);
    acc.totaltLagervarde = round2(acc.totaltLagervarde);
  }

  return { totalt, perOmrade, konflikter, olostaBlockerandeKonflikter, dubbelskanningar };
}

// --- Global saknas-/tillkommit-avstämning (Task #20, uppföljning) ---------
//
// EN delad källa för BÅDE den alltid-live "Ej inventerade / Saknas"-vyn
// (GET /:id/saknade, GET /:id/tillkommit-efter-start) OCH den frysta
// totalradens antalSaknade/styckSaknat/nomM3Saknat/antalTillkommitEfterStart
// vid POST /:id/avsluta — så att en årsinventerings frysta rapport och dess
// historiska Saknas-lista ALDRIG kan visa olika tal (de anropar bokstavligen
// samma funktion, med samma tidsgräns).
//
// Gäller ENDAST 'arsinventering'-omgångar med en global startsnapshot (se
// lagerInventeringsomgangGlobalSnapshotTable) — returnerar harGlobalSnapshot:
// false annars (t.ex. kontrollinventeringar, eller äldre omgångar från innan
// denna funktion infördes).
//
// Definition:
//  - hittadeFranStartlager : pktNr i startsnapshoten SOM OCKSÅ skannades i
//                            NÅGON fack-session i omgången, oavsett vilket
//                            fack. Ett paket registrerat i fack A men fysiskt
//                            funnet i fack B räknas ALLTID som hittat här.
//  - saknasFranStartlager  : pktNr i startsnapshoten som ALDRIG skannades.
//  - tillkommitEfterStart  : pktNr som skannades i omgången men INTE fanns i
//                            startsnapshoten alls (t.ex. nyinlevererat gods
//                            under en flerdagars inventering). Räknas ALDRIG
//                            som "hittat" i avstämningen mot startsnapshoten.
//
// Följande gäller ALLTID, oavsett hur många paket som tillkommit:
//   hittadeFranStartlager.antal + saknasFranStartlager.antal === antalGlobalSnapshot
//
// Kvantiteter (styck/NOM m³) för hittade/saknade paket läses UTESLUTANDE
// från den GLOBALA STARTSNAPSHOTEN (aldrig dagens lagerdata, aldrig
// skanningstillfällets frysta data) — detta är en avstämning mot vad som
// fanns VID START, inte en värdering av vad som fysiskt skannades senare.
// tillkommit-efter-start-paket saknar per definition startdata — deras
// kvantiteter läses istället från den (senaste) skanningens frysta historik,
// med samma live-fallback som övriga vyer för skanningar från innan
// frysningen infördes.
//
// `tidsgrans` (valfri): begränsar vilka skanningar som räknas med, via
// `skannadAt <= tidsgrans`. Används för att göra en AVSLUTAD omgångs
// Saknas-/Tillkommit-vy exakt reproducerbar (bunden till omgångens
// avslutadAt, satt till SAMMA Date-instans som skrevs till avslutadAt) — en
// skanning i en kvarglömd, fortfarande pågående session som råkar ske EFTER
// att omgången stängts kan då aldrig ändra en redan fryst historisk rapport.
// En PÅGÅENDE omgång anropas alltid utan tidsgräns (all skanning räknas).
export type GlobalAvstamningPaket = PaketDetaljer & {
  pktNr: string;
  lagerId: number | null;
  // Endast satt för tillkommitEfterStart (tidpunkt för den auktoritativa,
  // senaste skanningen) — null för saknasFranStartlager.
  senastSkannadAt: string | null;
};

export type GlobalAvstamningResultat =
  | { harGlobalSnapshot: false }
  | {
      harGlobalSnapshot: true;
      antalGlobalSnapshot: number;
      hittadeFranStartlager: { antal: number; styck: number; nomM3: number };
      saknasFranStartlager: { antal: number; styck: number; nomM3: number; paket: GlobalAvstamningPaket[] };
      tillkommitEfterStart: { antal: number; styck: number; nomM3: number; paket: GlobalAvstamningPaket[] };
    };

export async function beraknaGlobalAvstamningForOmgang(
  omgangId: number,
  tidsgrans?: Date | null,
  query: Pick<typeof db, "select"> = db,
): Promise<GlobalAvstamningResultat> {
  const snapshotRader = await query
    .select()
    .from(lagerInventeringsomgangGlobalSnapshotTable)
    .where(eq(lagerInventeringsomgangGlobalSnapshotTable.omgangId, omgangId));

  if (snapshotRader.length === 0) return { harGlobalSnapshot: false };

  const snapshotPerPktNr = new Map<string, typeof snapshotRader>();
  for (const r of snapshotRader) {
    const arr = snapshotPerPktNr.get(r.pktNr) ?? [];
    arr.push(r);
    snapshotPerPktNr.set(r.pktNr, arr);
  }

  const sessioner = await query
    .select({ id: lagerInventeringarTable.id })
    .from(lagerInventeringarTable)
    .where(eq(lagerInventeringarTable.omgangId, omgangId));
  const sessionIds = sessioner.map((s) => s.id);

  const skanningar = sessionIds.length
    ? await query
        .select()
        .from(lagerInventeringSkanningarTable)
        .where(
          tidsgrans
            ? and(
                inArray(lagerInventeringSkanningarTable.inventeringId, sessionIds),
                lte(lagerInventeringSkanningarTable.skannadAt, tidsgrans),
              )
            : inArray(lagerInventeringSkanningarTable.inventeringId, sessionIds),
        )
    : [];

  const skanningIds = skanningar.map((s) => s.id);
  const raderPerSkanning = new Map<number, (typeof lagerInventeringSkanningRaderTable.$inferSelect)[]>();
  if (skanningIds.length > 0) {
    const allaRader = await query
      .select()
      .from(lagerInventeringSkanningRaderTable)
      .where(inArray(lagerInventeringSkanningRaderTable.skanningId, skanningIds));
    for (const rad of allaRader) {
      const arr = raderPerSkanning.get(rad.skanningId) ?? [];
      arr.push(rad);
      raderPerSkanning.set(rad.skanningId, arr);
    }
  }

  const scannadeGrupper = new Map<string, typeof skanningar>();
  for (const s of skanningar) {
    const arr = scannadeGrupper.get(s.pktNrSkannat) ?? [];
    arr.push(s);
    scannadeGrupper.set(s.pktNrSkannat, arr);
  }

  const snapshotPktNrSet = new Set(snapshotPerPktNr.keys());
  const scannadePktNrSet = new Set(scannadeGrupper.keys());

  const hittadePktNr = Array.from(snapshotPktNrSet).filter((p) => scannadePktNrSet.has(p));
  const saknasPktNr = Array.from(snapshotPktNrSet)
    .filter((p) => !scannadePktNrSet.has(p))
    .sort();
  const tillkommitPktNr = Array.from(scannadePktNrSet)
    .filter((p) => !snapshotPktNrSet.has(p))
    .sort();

  let hittadeStyck = 0;
  let hittadeNomM3 = 0;
  for (const p of hittadePktNr) {
    const d = paketDetaljerFranGlobalSnapshot(snapshotPerPktNr.get(p)!);
    hittadeStyck += d.styck;
    hittadeNomM3 += d.nomM3;
  }

  const saknasPaket: GlobalAvstamningPaket[] = saknasPktNr.map((pktNr) => {
    const rader = snapshotPerPktNr.get(pktNr)!;
    const d = paketDetaljerFranGlobalSnapshot(rader);
    return { ...d, pktNr, lagerId: rader[0].lagerId, nomM3: round2(d.nomM3), senastSkannadAt: null };
  });
  let saknasStyck = 0;
  let saknasNomM3 = 0;
  for (const pkt of saknasPaket) {
    saknasStyck += pkt.styck;
    saknasNomM3 += pkt.nomM3;
  }

  const tillkommitPaket: GlobalAvstamningPaket[] = [];
  let tillkommitStyck = 0;
  let tillkommitNomM3 = 0;
  for (const pktNr of tillkommitPktNr) {
    const kandidater = scannadeGrupper.get(pktNr)!;
    const auktoritativ = kandidater.reduce((a, b) => (b.skannadAt > a.skannadAt ? b : a));
    const rader = raderPerSkanning.get(auktoritativ.id) ?? [];
    let d = paketDetaljerFranFrystHistorik(rader, auktoritativ.frystUtanRader);
    if (!d) {
      const liveRader = await hamtaAktuellaPaketRader(auktoritativ.pktNrSkannat);
      d = liveRader.length > 0 ? sammanstallPaketDetaljer(liveRader) : NOLL_PAKETDETALJER;
    }
    tillkommitStyck += d.styck;
    tillkommitNomM3 += d.nomM3;
    tillkommitPaket.push({
      ...d,
      pktNr,
      lagerId: rader[0]?.lagerId ?? null,
      nomM3: round2(d.nomM3),
      senastSkannadAt: auktoritativ.skannadAt.toISOString(),
    });
  }

  return {
    harGlobalSnapshot: true,
    antalGlobalSnapshot: snapshotPktNrSet.size,
    hittadeFranStartlager: { antal: hittadePktNr.length, styck: hittadeStyck, nomM3: round2(hittadeNomM3) },
    saknasFranStartlager: { antal: saknasPktNr.length, styck: saknasStyck, nomM3: round2(saknasNomM3), paket: saknasPaket },
    tillkommitEfterStart: {
      antal: tillkommitPktNr.length,
      styck: tillkommitStyck,
      nomM3: round2(tillkommitNomM3),
      paket: tillkommitPaket,
    },
  };
}

// Startar en ny inventeringssession för ett fack, eller återupptar en
// befintlig pågående session om en redan finns (max en pågående per fack,
// garanteras även av ett partiellt unikt DB-index).
router.post("/start", async (req, res) => {
  const omradeId = Number(req.body?.omradeId);
  const fackId = Number(req.body?.fackId);
  if (!Number.isInteger(omradeId) || !Number.isInteger(fackId)) {
    res.status(400).json({ error: "omradeId och fackId krävs" });
    return;
  }

  let begardOmgangId: number | null = null;
  if (req.body?.omgangId !== undefined && req.body?.omgangId !== null) {
    const raw = Number(req.body.omgangId);
    if (!Number.isInteger(raw)) {
      res.status(400).json({ error: "Ogiltigt omgangId" });
      return;
    }
    begardOmgangId = raw;
  }

  const resultat = await db.transaction(async (tx) => {
    if (begardOmgangId !== null) {
      const [omgang] = await tx
        .select()
        .from(lagerInventeringsomgangarTable)
        .where(eq(lagerInventeringsomgangarTable.id, begardOmgangId))
        .for("update");
      if (!omgang) return { ok: false as const, status: 400, error: "Omgången hittades inte" };
      if (omgang.status !== "pagaende") {
        return { ok: false as const, status: 409, error: "Omgången är avslutad och kan inte ta emot eller återuppta sessioner" };
      }
      const [iScope] = await tx
        .select()
        .from(lagerInventeringsomgangFackTable)
        .where(and(eq(lagerInventeringsomgangFackTable.omgangId, begardOmgangId), eq(lagerInventeringsomgangFackTable.fackId, fackId)));
      if (!iScope) return { ok: false as const, status: 400, error: "Facket ingår inte i omgångens omfång" };
    }

    const [fack] = await tx
      .select()
      .from(lagerFackTable)
      .where(and(eq(lagerFackTable.id, fackId), eq(lagerFackTable.omradeId, omradeId)));
    if (!fack) return { ok: false as const, status: 400, error: "Facket hittades inte i angivet område" };

    const [befintlig] = await tx
      .select()
      .from(lagerInventeringarTable)
      .where(and(eq(lagerInventeringarTable.fackId, fackId), eq(lagerInventeringarTable.status, "pagaende")));
    if (befintlig) {
      if (begardOmgangId !== null && befintlig.omgangId !== begardOmgangId) {
        return { ok: false as const, status: 409, error: "Facket har redan en pågående session i en annan inventeringsomgång" };
      }
      if (befintlig.omgangId !== null && befintlig.omgangId !== begardOmgangId) {
        const [befintligOmgang] = await tx
          .select()
          .from(lagerInventeringsomgangarTable)
          .where(eq(lagerInventeringsomgangarTable.id, befintlig.omgangId))
          .for("update");
        if (!befintligOmgang || befintligOmgang.status !== "pagaende") {
          return { ok: false as const, status: 409, error: "Sessionens inventeringsomgång är avslutad och kan inte återupptas" };
        }
      }
      return { ok: true as const, atertagen: true, session: befintlig };
    }

    const aktuellaRader = await tx
      .select()
      .from(lagerPosterTable)
      .where(and(eq(lagerPosterTable.omradeId, omradeId), eq(lagerPosterTable.fackId, fackId), ...iLagerConditions()));

    const [session] = await tx
      .insert(lagerInventeringarTable)
      .values({ omradeId, fackId, omgangId: begardOmgangId, startadAv: req.userId })
      .returning();

    if (aktuellaRader.length > 0) {
      await tx.insert(lagerInventeringForvantadeTable).values(
        aktuellaRader.map((r) => ({
          inventeringId: session.id,
          lagerId: r.id,
          pktNr: r.pktNr?.trim() || `_saknar_pktnr_${r.id}`,
          omradeIdVidStart: r.omradeId,
          fackIdVidStart: r.fackId,
          traslagVidStart: r.traslag,
          profilVidStart: r.profil,
          kvalitetVidStart: r.kvalitet,
          nomTjocklekVidStart: r.nomTjocklek,
          nomBreddVidStart: r.nomBredd,
          langdDmVidStart: r.langdDm,
          antalVidStart: r.antal,
          nomM3VidStart: r.m3,
        })),
      );
    }

    return { ok: true as const, atertagen: false, session };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  res.status(resultat.atertagen ? 200 : 201).json({
    atertagen: resultat.atertagen,
    session: await byggSessionsoversikt(resultat.session),
  });
});

// Lista sessioner, ev. filtrerat på status — driver "Pågående" och
// "Historik"-flikarna.
router.get("/", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const conditions = status ? [eq(lagerInventeringarTable.status, status)] : [];
  const sessioner = await db
    .select()
    .from(lagerInventeringarTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(lagerInventeringarTable.startadAt));

  const omradeIds = Array.from(new Set(sessioner.map((s) => s.omradeId)));
  const fackIds = Array.from(new Set(sessioner.map((s) => s.fackId)));
  const [omraden, fackRader] = await Promise.all([
    omradeIds.length ? db.select().from(lagerOmradenTable).where(inArray(lagerOmradenTable.id, omradeIds)) : Promise.resolve([]),
    fackIds.length ? db.select().from(lagerFackTable).where(inArray(lagerFackTable.id, fackIds)) : Promise.resolve([]),
  ]);
  const omradeMap = new Map(omraden.map((o) => [o.id, o]));
  const fackMap = new Map(fackRader.map((f) => [f.id, f]));

  res.json(
    sessioner.map((s) => ({
      id: s.id,
      status: s.status,
      omradeId: s.omradeId,
      omradeNamn: omradeMap.get(s.omradeId)?.namn ?? null,
      fackId: s.fackId,
      fackKod: fackMap.get(s.fackId)?.kod ?? null,
      startadAv: s.startadAv,
      startadAt: s.startadAt.toISOString(),
      avslutadAv: s.avslutadAv,
      avslutadAt: s.avslutadAt ? s.avslutadAt.toISOString() : null,
    })),
  );
});

// Avvikelseöversikt: samtliga AVSLUTADE sessioner som fortfarande har minst
// en olöst avvikelse just nu (räknas om live — en korrigering eller annan
// ändring efter avslut kan ha löst den sedan dess).
router.get("/avvikelser", async (_req, res) => {
  const avslutade = await db
    .select()
    .from(lagerInventeringarTable)
    .where(eq(lagerInventeringarTable.status, "avslutad"))
    .orderBy(desc(lagerInventeringarTable.avslutadAt));

  const resultat = [];
  for (const session of avslutade) {
    const oversikt = await byggSessionsoversikt(session);
    const olosta = oversikt.raknare.felplacerade + oversikt.raknare.okanda + oversikt.raknare.otydliga + oversikt.raknare.saknade;
    if (olosta > 0) {
      resultat.push({
        id: oversikt.id,
        omradeNamn: oversikt.omradeNamn,
        fackKod: oversikt.fackKod,
        avslutadAt: oversikt.avslutadAt,
        raknare: oversikt.raknare,
      });
    }
  }
  res.json(resultat);
});

// Paketsökning för den manuella pktNr-inmatningen i den aktiva
// skanningssidan (samma sök-/UX-mönster som "Lägg till paket" i
// Specifikationer, se SpecPage.tsx). Söker bland AKTUELLA (i_lager)
// lager_poster-rader med samma fritextregler som `GET /lager?search=`
// (delad `buildLagerSearchConditions`), men grupperar träffarna per pktNr
// — ett fysiskt paket ska ge EN träff, aldrig en per längdrad (samma regel
// som skanningsflödet, se hamtaAktuellaPaketRader/klassificeraRader ovan).
// Ingen klassificeringslogik här — det är rent sök/visning, valet av en
// träff går via samma POST /:id/skanna som en fysisk streckkodsläsning.
router.get("/sok-paket", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json({ data: [] });
    return;
  }

  const conditions = [...iLagerConditions(), ...buildLagerSearchConditions(q)];
  const raderAktuella = await db
    .select()
    .from(lagerPosterTable)
    .where(and(...conditions))
    .orderBy(sql`CASE WHEN ${lagerPosterTable.pktNr} ~ '^[0-9]+$' THEN LPAD(${lagerPosterTable.pktNr}, 20, '0') ELSE ${lagerPosterTable.pktNr} END, ${lagerPosterTable.id}`)
    .limit(500);

  // Om ett pktNr inte längre har aktuella rader ska inventeringen ändå kunna
  // identifiera ett historiskt mjukraderat paket. Detta är en ren läsning:
  // sökningen återaktiverar aldrig lagerdata.
  const historiskaKandidater = await db
    .select()
    .from(lagerPosterTable)
    .where(and(...buildLagerSearchConditions(q)))
    .orderBy(sql`CASE WHEN ${lagerPosterTable.pktNr} ~ '^[0-9]+$' THEN LPAD(${lagerPosterTable.pktNr}, 20, '0') ELSE ${lagerPosterTable.pktNr} END, ${lagerPosterTable.id}`)
    .limit(500);
  const kandidatPktNr = Array.from(
    new Set([...raderAktuella, ...historiskaKandidater].map((r) => r.pktNr).filter((p): p is string => !!p)),
  );
  const [komplettaAktuella, komplettaHistoriska] = kandidatPktNr.length
    ? await Promise.all([
        db
          .select()
          .from(lagerPosterTable)
          .where(and(inArray(lagerPosterTable.pktNr, kandidatPktNr), ...iLagerConditions())),
        db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.pktNr, kandidatPktNr)),
      ])
    : [[], []];
  const aktivaPktNr = new Set(komplettaAktuella.map((r) => r.pktNr));
  const historiskaPktNr = new Set(
    komplettaHistoriska
      .filter((r) => (r.raderadAt !== null || (r.datumUt !== null && r.avrappTyp !== "spec_import")) && !aktivaPktNr.has(r.pktNr))
      .map((r) => r.pktNr),
  );
  const historiskaRader = komplettaHistoriska.filter((r) => historiskaPktNr.has(r.pktNr));
  const rader = [
    ...komplettaAktuella,
    // Ett historiskt pktNr visas endast när just det pktNr saknar aktuella
    // rader. Ett aktivt pktNr vinner alltså vid en blandad historik.
    ...historiskaRader.filter((r) => !aktivaPktNr.has(r.pktNr)),
  ];

  // Gruppera per pktNr — ett fysiskt paket kan ligga som flera rader (en
  // per längd), se Task #18-kommentaren högst upp i denna fil.
  const grupper = new Map<string, typeof rader>();
  for (const r of rader) {
    if (!r.pktNr) continue;
    const arr = grupper.get(r.pktNr) ?? [];
    arr.push(r);
    grupper.set(r.pktNr, arr);
  }

  const omradeIds = Array.from(new Set(rader.map((r) => r.omradeId).filter((v): v is number => v != null)));
  const fackIds = Array.from(new Set(rader.map((r) => r.fackId).filter((v): v is number => v != null)));
  const [omraden, fackRader] = await Promise.all([
    omradeIds.length ? db.select().from(lagerOmradenTable).where(inArray(lagerOmradenTable.id, omradeIds)) : Promise.resolve([]),
    fackIds.length ? db.select().from(lagerFackTable).where(inArray(lagerFackTable.id, fackIds)) : Promise.resolve([]),
  ]);
  const omradeMap = new Map(omraden.map((o) => [o.id, o]));
  const fackMap = new Map(fackRader.map((f) => [f.id, f]));

  const data = Array.from(grupper.entries())
    .slice(0, 25) // autocomplete — begränsa antal FÖRSLAG, inte antal underliggande rader
    .map(([pktNr, rows]) => {
      const first = rows[0];
      const langder = Array.from(new Set(rows.map((r) => toNumber(r.langdDm)).filter((v) => v > 0))).sort((a, b) => a - b);
      const omradeIdSet = new Set(rows.map((r) => r.omradeId ?? null));
      const fackIdSet = new Set(rows.map((r) => r.fackId ?? null));
      const harMjukraderadRad = rows.some((r) => r.raderadAt !== null);
      const deregistrerad = harMjukraderadRad;
      const avrapporterad = !deregistrerad && rows.every((r) => r.datumUt !== null);
      const kanAterstallas = deregistrerad && rows.every((r) => r.raderadAt !== null && r.datumUt === null);
      return {
        pktNr,
        traslag: first.traslag,
        profil: first.profil,
        kvalitet: first.kvalitet,
        behandling: first.behandling,
        utforande: first.utforande,
        datumIn: first.datumIn,
        datumUt: first.datumUt,
        plats: first.plats,
        anteckning: first.anteckning,
        nomTjocklek: toNumber(first.nomTjocklek) || null,
        nomBredd: toNumber(first.nomBredd) || null,
        actTjocklek: toNumber(first.actTjocklek) || null,
        actBredd: toNumber(first.actBredd) || null,
        langder,
        antalRader: rows.length,
        totalAntal: rows.reduce((sum, r) => sum + toNumber(r.antal), 0),
        totalM3: round2(rows.reduce((sum, r) => sum + toNumber(r.m3), 0)),
        omradeId: first.omradeId,
        fackId: first.fackId,
        omradeNamn: first.omradeId != null ? (omradeMap.get(first.omradeId)?.namn ?? null) : null,
        fackKod: first.fackId != null ? (fackMap.get(first.fackId)?.kod ?? null) : null,
        // Rader oense om placering — visas som "blandad" istället för att gissa.
        blandadPlacering: omradeIdSet.size > 1 || fackIdSet.size > 1,
        inventeringsstatus: deregistrerad
          ? kanAterstallas
            ? "deregistrerad"
            : "ej_aterstallningsbar"
          : "ej_aterstallningsbar",
        deregistrerad,
        avrapporterad,
        kanAterstallas,
        restaureringsAnledning: deregistrerad && !kanAterstallas
          ? "Historiska rader har datumUt eller ett annat tillstånd som inte kan återställas säkert"
          : null,
      };
    });

  res.json({ data });
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const session = await hamtaSession(id);
  if (!session) {
    res.status(404).json({ error: "Sessionen hittades inte" });
    return;
  }
  res.json(await byggSessionsoversikt(session));
});

// Återinför ett historiskt mjukraderat pktNr som EN paketatomisk operation.
// Detta är uttryckligen separat från skanning: en skanning får aldrig ändra
// lagerstatus. Endast raderadAt skrivs.
router.post("/:id/aterstall", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const pktNr = String(req.body?.pktNr ?? "").trim();
  if (!pktNr) {
    res.status(400).json({ error: "pktNr krävs" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    if (session.status !== "pagaende") return { kind: "session_stangd" as const };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pkt:${pktNr}`}, 0))`);
    // Återställning är sällsynt. Ett kort skrivlås på tabellen gör även
    // kontrollen mot samtidiga nya rader med samma pktNr predicatesäker,
    // utan att paketets normala import-/syncvägar behöver ändras.
    await tx.execute(sql`LOCK TABLE lager_poster IN SHARE ROW EXCLUSIVE MODE`);

    // Lås även aktiva rader med samma pktNr. Det förhindrar att en aktiv
    // konflikt passerar mellan kontrollen och återställningen.
    const allaRader = await tx
      .select()
      .from(lagerPosterTable)
      .where(eq(lagerPosterTable.pktNr, pktNr))
      .for("update");
    if (allaRader.length === 0) return { kind: "saknas" as const };

    const aktivaEllerBlandade = allaRader.some((r) => r.raderadAt === null);
    const harUtlevereradRad = allaRader.some((r) => r.datumUt !== null);
    const deleted = allaRader.filter((r) => r.raderadAt !== null);
    if (aktivaEllerBlandade) return { kind: "konflikt" as const, anledning: "Ett aktivt eller blandat paket med samma pktNr finns redan" };
    if (harUtlevereradRad) return { kind: "ej_restaurerbar" as const, anledning: "Paketet har datumUt och kan inte återställas säkert" };
    if (deleted.length === 0) return { kind: "ej_restaurerbar" as const, anledning: "Inga säkra mjukraderade rader hittades" };

    const restored = await tx
      .update(lagerPosterTable)
      .set({ raderadAt: null })
      .where(inArray(lagerPosterTable.id, deleted.map((r) => r.id)))
      .returning();
    // Historik skrivs i samma transaktion och för varje återinförd rad.
    await tx.insert(lagerHistorikTable).values(
      restored.map((r) => ({
        lagerId: r.id,
        action: "aterstall",
        changedBy: req.userId,
        andringar: JSON.stringify({ raderadAt: null }),
      })),
    );
    return { kind: "aterstalld" as const, restored };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  if (resultat.value.kind === "session_stangd") {
    res.status(400).json({ error: "Sessionen är inte pågående" });
    return;
  }
  if (resultat.value.kind === "saknas") {
    res.status(404).json({ error: "Inga historiska lagerposter hittades för pktNr" });
    return;
  }
  if (resultat.value.kind === "konflikt" || resultat.value.kind === "ej_restaurerbar") {
    res.status(409).json({ error: resultat.value.anledning, pktNr, kanAterstallas: false });
    return;
  }
  res.json({
    pktNr,
    aterstalld: true,
    antalRader: resultat.value.restored.length,
    kanAterstallas: true,
    rader: resultat.value.restored,
  });
});

// Registrerar en fysisk skanning av ett pktNr i en pågående session.
// Idempotent för samma pktNr inom samma session — ett upprepat
// skanningsförsök returnerar den befintliga skanningen med
// `redanSkannad: true` istället för att skapa en ny rad.
router.post("/:id/skanna", async (req, res) => {
  const id = Number(req.params.id);
  const pktNr = String(req.body?.pktNr ?? "").trim();
  const metod = String(req.body?.metod ?? "skanner");
  if (!pktNr) {
    res.status(400).json({ error: "pktNr krävs" });
    return;
  }
  if (!["skanner", "kamera", "manuell"].includes(metod)) {
    res.status(400).json({ error: "Ogiltig metod" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    if (session.status !== "pagaende") return { kind: "session_stangd" as const, session };

    const [befintlig] = await tx
      .select()
      .from(lagerInventeringSkanningarTable)
      .where(and(eq(lagerInventeringSkanningarTable.inventeringId, id), eq(lagerInventeringSkanningarTable.pktNrSkannat, pktNr)));
    if (befintlig) return { kind: "befintlig" as const, session, klassificering: befintlig.klassificering };

    const rader = await tx
      .select()
      .from(lagerPosterTable)
      .where(and(eq(lagerPosterTable.pktNr, pktNr), ...iLagerConditions()));
    if (rader.length === 0) {
      const historiska = await tx
        .select()
        .from(lagerPosterTable)
        .where(eq(lagerPosterTable.pktNr, pktNr));
      if (historiska.some((r) => r.raderadAt !== null)) {
        const kanAterstallas = historiska.every((r) => r.raderadAt !== null && r.datumUt === null);
        return {
          kind: "deregistrerad" as const,
          session,
          kanAterstallas,
          anledning: kanAterstallas
            ? null
            : "Historiska rader har datumUt eller ett annat tillstånd som inte kan återställas säkert",
          rader: historiska,
        };
      }
    }
    if (rader.length === 0) {
      const avrapporterade = await hamtaAvrapporteradeRader(tx, pktNr);
      if (avrapporterade.length > 0) {
        return {
          kind: "avrapporterad" as const,
          session,
          avrapportering: await beskrivAvrapportering(tx, avrapporterade),
          rader: avrapporterade,
        };
      }
    }
    const klassificering = (await registreraSkanning(tx, session, pktNr, metod, req.userId, rader)).klassificering;

    return { kind: "skapad" as const, session, klassificering };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  if (resultat.value.kind === "session_stangd") {
    res.status(400).json({ error: "Sessionen är inte pågående" });
    return;
  }
  if (resultat.value.kind === "avrapporterad") {
    // Ren läsning: ingen skanning sparas förrän användaren valt hur
    // avvikelsen ska hanteras (byt mot annat paket / återinför).
    res.status(200).json({
      redanSkannad: false,
      avrapporterad: true,
      klassificering: "avrapporterad",
      status: "avrapporterad",
      pktNr,
      avrapportering: resultat.value.avrapportering,
      package: sammanstallPaketDetaljer(resultat.value.rader),
    });
    return;
  }
  if (resultat.value.kind === "deregistrerad") {
    const detaljer = sammanstallPaketDetaljer(resultat.value.rader);
    res.status(200).json({
      redanSkannad: false,
      deregistrerad: true,
      klassificering: "deregistrerad",
      status: "deregistrerad",
      kanAterstallas: resultat.value.kanAterstallas,
      restaureringsAnledning: resultat.value.anledning,
      pktNr,
      package: {
        ...detaljer,
        rader: resultat.value.rader,
      },
    });
    return;
  }
  res.status(resultat.value.kind === "skapad" ? 201 : 200).json({
    redanSkannad: resultat.value.kind === "befintlig",
    klassificering: resultat.value.klassificering,
    session: await byggSessionsoversikt(resultat.value.session),
  });
});

// Ångrar/tar bort en enskild skanning i en PÅGÅENDE session (t.ex. en
// felskanning). Tar bort HELA pktNr-skanningen som en enhet — cascade från
// lager_inventering_skanningar tar med samtliga kopplade
// lager_inventering_skanning_rader, även för paket med flera längdrader.
// Ändrar ALDRIG lager_poster, område, fack eller plats: detta är enbart en
// "ångra inventeringsskanning", ingen lagerkorrigering. Hittade/Kvar att
// hitta/Felplacerade/Okända/Otydliga uppdateras automatiskt eftersom
// byggSessionsoversikt alltid räknar dessa live från kvarvarande
// skannings- och förväntade-rader — inget separat räknarläge att synka.
router.delete("/:id/skanna/:pktNr", async (req, res) => {
  const id = Number(req.params.id);
  const pktNr = String(req.params.pktNr ?? "").trim();
  if (!pktNr) {
    res.status(400).json({ error: "pktNr krävs" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    if (session.status !== "pagaende") return { kind: "session_stangd" as const, session };
    const [befintlig] = await tx
      .select()
      .from(lagerInventeringSkanningarTable)
      .where(and(eq(lagerInventeringSkanningarTable.inventeringId, id), eq(lagerInventeringSkanningarTable.pktNrSkannat, pktNr)));
    if (!befintlig) return { kind: "saknas" as const, session };

    await tx.delete(lagerInventeringSkanningarTable).where(eq(lagerInventeringSkanningarTable.id, befintlig.id));
    await tx
      .delete(lagerInventeringPriserTable)
      .where(and(eq(lagerInventeringPriserTable.inventeringId, id), eq(lagerInventeringPriserTable.pktNr, pktNr)));
    return { kind: "borttagen" as const, session };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  if (resultat.value.kind === "session_stangd") {
    res.status(400).json({ error: "Sessionen är inte pågående" });
    return;
  }
  if (resultat.value.kind === "saknas") {
    res.status(404).json({ error: "Skanningen hittades inte" });
    return;
  }
  res.json({ borttagen: true, pktNr, session: await byggSessionsoversikt(resultat.value.session) });
});

router.post("/:id/avsluta", async (req, res) => {
  const id = Number(req.params.id);
  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    if (session.status !== "pagaende") return null;
    const [updated] = await tx
      .update(lagerInventeringarTable)
      .set({ status: "avslutad", avslutadAv: req.userId, avslutadAt: new Date() })
      .where(and(eq(lagerInventeringarTable.id, id), eq(lagerInventeringarTable.status, "pagaende")))
      .returning();
    return updated ?? null;
  });
  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  if (!resultat.value) {
    res.status(400).json({ error: "Sessionen är inte pågående" });
    return;
  }
  res.json(await byggSessionsoversikt(resultat.value));
});

router.post("/:id/avbryt", async (req, res) => {
  const id = Number(req.params.id);
  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    if (session.status !== "pagaende") return null;
    const [updated] = await tx
      .update(lagerInventeringarTable)
      .set({ status: "avbruten", avslutadAv: req.userId, avslutadAt: new Date() })
      .where(and(eq(lagerInventeringarTable.id, id), eq(lagerInventeringarTable.status, "pagaende")))
      .returning();
    return updated ?? null;
  });
  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  if (!resultat.value) {
    res.status(400).json({ error: "Sessionen är inte pågående" });
    return;
  }
  res.json(await byggSessionsoversikt(resultat.value));
});

// Korrigerar placeringen för valda felplacerade paket till sessionens
// fack. Skanningen i sig ändrar ALDRIG placering — detta är det enda
// stället en inventering faktiskt flyttar lagerposter, och det sker
// alltid explicit, per paket, efter användarens godkännande.
//
// Innan skrivning kontrolleras att paketets placering fortfarande
// stämmer överens med läget VID SKANNINGSTILLFÄLLET (lagrat på
// lager_inventering_skanning_rader). Om någon flyttat paketet under
// tiden blockeras korrigeringen som en konflikt istället för att
// skriva över den nya, okända placeringen.
router.post("/:id/korrigera", async (req, res) => {
  const id = Number(req.params.id);
  const pktNrLista = Array.isArray(req.body?.pktNrLista) ? (req.body.pktNrLista as unknown[]).map((p) => String(p).trim()) : [];
  if (pktNrLista.length === 0) {
    res.status(400).json({ error: "pktNrLista krävs" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    const [omrade] = await tx.select().from(lagerOmradenTable).where(eq(lagerOmradenTable.id, session.omradeId));
    if (!omrade) return { kind: "fel" as const, status: 500, error: "Sessionens område hittades inte" };
    const [tillFack] = await tx.select().from(lagerFackTable).where(eq(lagerFackTable.id, session.fackId));
    if (!tillFack) return { kind: "fel" as const, status: 500, error: "Sessionens fack hittades inte" };

    const korrigerade: string[] = [];
    const konflikter: { pktNr: string; anledning: string }[] = [];

    for (const pktNr of pktNrLista) {
      const [skanning] = await tx
        .select()
        .from(lagerInventeringSkanningarTable)
        .where(and(eq(lagerInventeringSkanningarTable.inventeringId, id), eq(lagerInventeringSkanningarTable.pktNrSkannat, pktNr)))
        .orderBy(desc(lagerInventeringSkanningarTable.skannadAt))
        .limit(1);

      if (!skanning) {
        konflikter.push({ pktNr, anledning: "Paketet är inte skannat i denna session" });
        continue;
      }
      if (skanning.klassificering !== "felplacerad") {
        konflikter.push({ pktNr, anledning: "Paketet är inte klassificerat som felplacerat" });
        continue;
      }

      const skanningRader = await tx
        .select()
        .from(lagerInventeringSkanningRaderTable)
        .where(eq(lagerInventeringSkanningRaderTable.skanningId, skanning.id));
      if (skanningRader.length === 0) {
        konflikter.push({ pktNr, anledning: "Inga rader kopplade till skanningen" });
        continue;
      }

      const aktuella = await hamtaAktuellaPaketRader(pktNr);
      const aktuellaIds = new Set(aktuella.map((r) => r.id));
      const skannadeIds = new Set(skanningRader.map((r) => r.lagerId));
      const sammaMangd = aktuellaIds.size === skannadeIds.size && Array.from(aktuellaIds).every((idx) => skannadeIds.has(idx));

      let konflikt = !sammaMangd;
      if (!konflikt) {
        for (const rad of skanningRader) {
          const nu = aktuella.find((r) => r.id === rad.lagerId);
          if (!nu || nu.omradeId !== rad.omradeIdVidSkanning || nu.fackId !== rad.fackIdVidSkanning) {
            konflikt = true;
            break;
          }
        }
      }

      if (konflikt) {
        konflikter.push({ pktNr, anledning: "Paketets placering har ändrats sedan skanningen — kontrollera och korrigera manuellt" });
        continue;
      }

      await applyLagerPatch(
        aktuella.map((r) => r.id),
        { omradeId: session.omradeId, fackId: session.fackId, plats: omrade.namn },
        { userId: req.userId, action: "inventering_korrigering" },
      );
      if (session.omgangId !== null) {
        const fran = skanningRader[0];
        const franOmradeId = fran.omradeIdVidSkanning ?? aktuella[0]?.omradeId ?? null;
        const franFackId = fran.fackIdVidSkanning ?? aktuella[0]?.fackId ?? null;
        const [franOmrade] =
          franOmradeId === null
            ? [null]
            : await tx.select().from(lagerOmradenTable).where(eq(lagerOmradenTable.id, franOmradeId));
        const [franFack] =
          franFackId === null
            ? [null]
            : await tx.select().from(lagerFackTable).where(eq(lagerFackTable.id, franFackId));
        await tx.insert(lagerInventeringsomgangKorrigeringarTable).values({
          omgangId: session.omgangId,
          inventeringId: id,
          skanningId: skanning.id,
          pktNr,
          franOmradeId,
          franFackId,
          franOmradeNamn: franOmrade?.namn ?? null,
          franFackKod: franFack?.kod ?? null,
          tillOmradeId: session.omradeId,
          tillFackId: session.fackId,
          tillOmradeNamn: omrade.namn,
          tillFackKod: tillFack.kod,
          korrigeradAv: req.userId,
        });
      }
      korrigerade.push(pktNr);
    }

    return { kind: "ok" as const, korrigerade, konflikter };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  if (resultat.value.kind === "fel") {
    res.status(resultat.value.status).json({ error: resultat.value.error });
    return;
  }
  res.json({ korrigerade: resultat.value.korrigerade, konflikter: resultat.value.konflikter });
});

// Förslag på vilket paket som i själva verket plockades i stället för det
// avrapporterade paketet `pktNr` (som hittades kvar i lagret). Rankas på
// samma mått/profil/kvalitet, samt om paketet "saknas" i det här facket
// (förväntat men ännu inte skannat). Ren läsning.
router.get("/:id/byte-kandidater", async (req, res) => {
  const id = Number(req.params.id);
  const pktNr = String(req.query.pktNr ?? "").trim();
  const session = await hamtaSession(id);
  if (!session) {
    res.status(404).json({ error: "Sessionen hittades inte" });
    return;
  }
  if (!pktNr) {
    res.status(400).json({ error: "pktNr krävs" });
    return;
  }

  const aRader = await hamtaAvrapporteradeRader(db, pktNr);
  if (aRader.length === 0) {
    res.json({ data: [] });
    return;
  }
  const a = aRader[0];
  const aTjocklek = toNumber(a.nomTjocklek);
  const aBredd = toNumber(a.nomBredd);

  const [skannade, forvantade] = await Promise.all([
    db
      .select({ pktNr: lagerInventeringSkanningarTable.pktNrSkannat })
      .from(lagerInventeringSkanningarTable)
      .where(eq(lagerInventeringSkanningarTable.inventeringId, id)),
    db
      .select({ pktNr: lagerInventeringForvantadeTable.pktNr })
      .from(lagerInventeringForvantadeTable)
      .where(eq(lagerInventeringForvantadeTable.inventeringId, id)),
  ]);
  const skannadeSet = new Set(skannade.map((x) => x.pktNr));
  const saknasIFack = new Set(forvantade.map((x) => x.pktNr).filter((p) => !skannadeSet.has(p)));

  // Kandidater = aktuella paket med samma nominella mått (annars samma fack).
  const matchVillkor =
    aTjocklek > 0 && aBredd > 0
      ? and(
          sql`${lagerPosterTable.nomTjocklek}::numeric = ${aTjocklek}`,
          sql`${lagerPosterTable.nomBredd}::numeric = ${aBredd}`,
        )
      : and(eq(lagerPosterTable.omradeId, session.omradeId), eq(lagerPosterTable.fackId, session.fackId));
  const kandidatRader = await db
    .select()
    .from(lagerPosterTable)
    .where(and(matchVillkor, ...iLagerConditions()))
    .limit(1500);

  const grupper = new Map<string, LagerRad[]>();
  for (const r of kandidatRader) {
    if (!r.pktNr || r.pktNr === pktNr || skannadeSet.has(r.pktNr)) continue;
    const arr = grupper.get(r.pktNr) ?? [];
    arr.push(r);
    grupper.set(r.pktNr, arr);
  }

  const aLangder = new Set(aRader.map((r) => toNumber(r.langdDm)).filter((v) => v > 0));
  const poangade = Array.from(grupper.entries()).map(([kPktNr, rows]) => {
    const first = rows[0];
    const orsaker: string[] = [];
    let poang = 0;
    if (saknasIFack.has(kPktNr)) { poang += 6; orsaker.push("Saknas i facket"); }
    if (first.omradeId === session.omradeId && first.fackId === session.fackId) { poang += 3; orsaker.push("Samma fack"); }
    else if (first.omradeId === session.omradeId) { poang += 1; orsaker.push("Samma område"); }
    if ((first.traslag ?? "") === (a.traslag ?? "")) poang += 2; else poang -= 2;
    if ((first.profil ?? "") === (a.profil ?? "")) { poang += 2; if (first.profil) orsaker.push("Samma profil"); }
    if ((first.kvalitet ?? "") === (a.kvalitet ?? "")) { poang += 1; if (first.kvalitet) orsaker.push("Samma kvalitet"); }
    const langder = Array.from(new Set(rows.map((r) => toNumber(r.langdDm)).filter((v) => v > 0))).sort((x, y) => x - y);
    if (langder.length > 0 && langder.every((l) => aLangder.has(l))) { poang += 2; orsaker.push("Samma längd"); }
    return { kPktNr, rows, first, langder, orsaker, poang };
  });
  poangade.sort((x, y) => y.poang - x.poang || x.kPktNr.localeCompare(y.kPktNr, "sv", { numeric: true }));

  const topp = poangade.slice(0, 12);
  const omradeIds = Array.from(new Set(topp.map((k) => k.first.omradeId).filter((v): v is number => v != null)));
  const fackIds = Array.from(new Set(topp.map((k) => k.first.fackId).filter((v): v is number => v != null)));
  const [omraden, fackRader] = await Promise.all([
    omradeIds.length ? db.select().from(lagerOmradenTable).where(inArray(lagerOmradenTable.id, omradeIds)) : Promise.resolve([]),
    fackIds.length ? db.select().from(lagerFackTable).where(inArray(lagerFackTable.id, fackIds)) : Promise.resolve([]),
  ]);
  const omradeMap = new Map(omraden.map((o) => [o.id, o]));
  const fackMap = new Map(fackRader.map((f) => [f.id, f]));

  res.json({
    data: topp.map((k) => ({
      pktNr: k.kPktNr,
      traslag: k.first.traslag,
      profil: k.first.profil,
      kvalitet: k.first.kvalitet,
      nomTjocklek: toNumber(k.first.nomTjocklek) || null,
      nomBredd: toNumber(k.first.nomBredd) || null,
      langder: k.langder,
      totalAntal: k.rows.reduce((sum, r) => sum + toNumber(r.antal), 0),
      totalM3: round2(k.rows.reduce((sum, r) => sum + toNumber(r.m3), 0)),
      omradeNamn: k.first.omradeId != null ? (omradeMap.get(k.first.omradeId)?.namn ?? null) : null,
      fackKod: k.first.fackId != null ? (fackMap.get(k.first.fackId)?.kod ?? null) : null,
      saknasIFacket: saknasIFack.has(k.kPktNr),
      orsaker: k.orsaker,
    })),
  });
});

// Ombyte på order: paket A (avrapporterat på en bekräftad order men
// fysiskt kvar i lagret) byts mot paket B (som i själva verket plockades).
// ALLT sker i en transaktion:
//   - A återinförs i lager (datumUt/avrappTyp nollas) och skannas in
//   - B avrapporteras med ordens datum/typ
//   - ordens paketrad byts från A till B (pris per m³ följer med)
//   - lagerhistorik skrivs för båda paketen
//   - om sessionen ingår i en omgång loggas B som "avrapporterad" bland
//     omgångens saknade, så att rapporten visar varför B inte hittades
router.post("/:id/byt-paket", async (req, res) => {
  const id = Number(req.params.id);
  const pktNr = String(req.body?.pktNr ?? "").trim();
  const ersattAvPktNr = String(req.body?.ersattAvPktNr ?? "").trim();
  const metod = String(req.body?.metod ?? "skanner");
  if (!pktNr || !ersattAvPktNr) {
    res.status(400).json({ error: "pktNr och ersattAvPktNr krävs" });
    return;
  }
  if (pktNr === ersattAvPktNr) {
    res.status(400).json({ error: "Paketen måste vara olika" });
    return;
  }
  if (!["skanner", "kamera", "manuell"].includes(metod)) {
    res.status(400).json({ error: "Ogiltig metod" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    if (session.status !== "pagaende") return { kind: "session_stangd" as const };
    for (const p of [pktNr, ersattAvPktNr].sort()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pkt:${p}`}, 0))`);
    }

    const aRader = await tx
      .select()
      .from(lagerPosterTable)
      .where(and(eq(lagerPosterTable.pktNr, pktNr), isNull(lagerPosterTable.raderadAt)))
      .for("update");
    const aAvrapporterade = aRader.filter((r) => r.datumUt !== null && r.avrappTyp !== "spec_import");
    if (aAvrapporterade.length === 0 || aAvrapporterade.length !== aRader.length) {
      return { kind: "konflikt" as const, error: `Paket ${pktNr} är inte längre avrapporterat` };
    }
    const bRader = await tx
      .select()
      .from(lagerPosterTable)
      .where(and(eq(lagerPosterTable.pktNr, ersattAvPktNr), ...iLagerConditions()))
      .for("update");
    if (bRader.length === 0) {
      return { kind: "konflikt" as const, error: `Paket ${ersattAvPktNr} finns inte som aktuellt lagerpaket` };
    }

    const [redanSkannadA] = await tx
      .select({ id: lagerInventeringSkanningarTable.id })
      .from(lagerInventeringSkanningarTable)
      .where(and(eq(lagerInventeringSkanningarTable.inventeringId, id), eq(lagerInventeringSkanningarTable.pktNrSkannat, pktNr)));
    if (redanSkannadA) return { kind: "konflikt" as const, error: `Paket ${pktNr} är redan skannat i den här inventeringen` };
    const [redanSkannadB] = await tx
      .select({ id: lagerInventeringSkanningarTable.id })
      .from(lagerInventeringSkanningarTable)
      .where(and(eq(lagerInventeringSkanningarTable.inventeringId, id), eq(lagerInventeringSkanningarTable.pktNrSkannat, ersattAvPktNr)));
    if (redanSkannadB) {
      return { kind: "konflikt" as const, error: `Paket ${ersattAvPktNr} är redan skannat i den här inventeringen, alltså finns det kvar och kan inte vara det som plockades` };
    }

    const { spec, specPaket } = await hamtaSpecKoppling(tx, aAvrapporterade.map((r) => r.id));
    if (!spec || specPaket.length === 0) {
      return { kind: "konflikt" as const, error: `Paket ${pktNr} sitter inte på någon bekräftad order — använd "Återinför i lager"` };
    }
    const bPaIOrdern = await tx
      .select({ id: specPaketTable.id })
      .from(specPaketTable)
      .where(and(eq(specPaketTable.specId, spec.id), inArray(specPaketTable.lagerPostId, bRader.map((r) => r.id))));
    if (bPaIOrdern.length > 0) {
      return { kind: "konflikt" as const, error: `Paket ${ersattAvPktNr} ligger redan på ${spec.etikett}` };
    }

    const datumUt = aAvrapporterade.map((r) => r.datumUt!).sort().pop()!;
    const avrappTyp = aAvrapporterade[0].avrappTyp;
    const nu = new Date();

    // 1. A tillbaka i lager.
    const aNya = await tx
      .update(lagerPosterTable)
      .set({ datumUt: null, avrappTyp: null, uppdateradAt: nu })
      .where(inArray(lagerPosterTable.id, aAvrapporterade.map((r) => r.id)))
      .returning();
    // 2. B ut på ordern.
    await tx
      .update(lagerPosterTable)
      .set({ datumUt, avrappTyp, uppdateradAt: nu })
      .where(inArray(lagerPosterTable.id, bRader.map((r) => r.id)));

    // 3. Ordens paketrader: ta bort A, lägg till B (pris per m³ följer med).
    const referens = specPaket[0];
    await tx
      .delete(specPaketTable)
      .where(and(eq(specPaketTable.specId, spec.id), inArray(specPaketTable.lagerPostId, aAvrapporterade.map((r) => r.id))));
    const prisPerM3 = referens.saljPris !== null && referens.saljPris !== undefined ? Number(referens.saljPris) : null;
    await tx.insert(specPaketTable).values(
      bRader.map((r) => ({
        specId: spec.id,
        lagerPostId: r.id,
        saljPris: prisPerM3 !== null && !Number.isNaN(prisPerM3) ? String(prisPerM3) : null,
        saljSum:
          prisPerM3 !== null && !Number.isNaN(prisPerM3) && r.m3 !== null
            ? (prisPerM3 * toNumber(r.m3)).toFixed(2)
            : null,
        ntrKlass: referens.ntrKlass,
      })),
    );

    // 4. Historik.
    await tx.insert(lagerHistorikTable).values([
      ...aNya.map((r) => ({
        lagerId: r.id,
        action: "inventering_ombyte_tillbaka_i_lager",
        changedBy: req.userId,
        andringar: JSON.stringify({ inventeringId: id, specId: spec.id, ersattAv: ersattAvPktNr, datumUt: null }),
      })),
      ...bRader.map((r) => ({
        lagerId: r.id,
        action: "inventering_ombyte_avrapporterad",
        changedBy: req.userId,
        andringar: JSON.stringify({ inventeringId: id, specId: spec.id, ersatter: pktNr, datumUt }),
      })),
    ]);

    // 5. Logga B bland omgångens saknade (granskningslogg, påverkar inga siffror).
    if (session.omgangId !== null) {
      const kommentar = `Ombyte på ${spec.etikett}: paket ${pktNr} hittades kvar i lagret och byttes mot ${ersattAvPktNr}`;
      await tx
        .insert(lagerInventeringsomgangSaknatBeslutTable)
        .values({ omgangId: session.omgangId, pktNr: ersattAvPktNr, beslut: "avrapporterad", kommentar, beslutadAv: req.userId })
        .onConflictDoUpdate({
          target: [lagerInventeringsomgangSaknatBeslutTable.omgangId, lagerInventeringsomgangSaknatBeslutTable.pktNr],
          set: { beslut: "avrapporterad", kommentar, beslutadAv: req.userId, beslutadAt: new Date() },
        });
    }

    // 6. Skanna in A (nu aktuellt) i sessionen.
    const { klassificering } = await registreraSkanning(tx, session, pktNr, metod, req.userId, aNya);
    return { kind: "ok" as const, session, klassificering, spec };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  const v = resultat.value;
  if (v.kind === "session_stangd") {
    res.status(400).json({ error: "Sessionen är inte pågående" });
    return;
  }
  if (v.kind === "konflikt") {
    res.status(409).json({ error: v.error });
    return;
  }
  res.status(201).json({
    bytt: true,
    pktNr,
    ersattAvPktNr,
    order: v.spec.etikett,
    klassificering: v.klassificering,
    session: await byggSessionsoversikt(v.session),
  });
});

// Återinför ett avrapporterat paket som hittades fysiskt kvar och som INTE
// sitter på någon bekräftad order (t.ex. manuellt avrapporterat som saknat
// vid en tidigare inventering). Nollar datumUt/avrappTyp och skannar in det.
router.post("/:id/aterinfor-avrapporterat", async (req, res) => {
  const id = Number(req.params.id);
  const pktNr = String(req.body?.pktNr ?? "").trim();
  const metod = String(req.body?.metod ?? "skanner");
  if (!pktNr) {
    res.status(400).json({ error: "pktNr krävs" });
    return;
  }
  if (!["skanner", "kamera", "manuell"].includes(metod)) {
    res.status(400).json({ error: "Ogiltig metod" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx, session) => {
    if (session.status !== "pagaende") return { kind: "session_stangd" as const };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pkt:${pktNr}`}, 0))`);
    const rader = await tx
      .select()
      .from(lagerPosterTable)
      .where(and(eq(lagerPosterTable.pktNr, pktNr), isNull(lagerPosterTable.raderadAt)))
      .for("update");
    const avrapporterade = rader.filter((r) => r.datumUt !== null && r.avrappTyp !== "spec_import");
    if (avrapporterade.length === 0 || avrapporterade.length !== rader.length) {
      return { kind: "konflikt" as const, error: `Paket ${pktNr} är inte längre avrapporterat` };
    }
    const { spec } = await hamtaSpecKoppling(tx, avrapporterade.map((r) => r.id));
    if (spec) {
      return { kind: "konflikt" as const, error: `Paket ${pktNr} sitter på ${spec.etikett} — byt mot det paket som plockades i stället` };
    }
    const [redan] = await tx
      .select({ id: lagerInventeringSkanningarTable.id })
      .from(lagerInventeringSkanningarTable)
      .where(and(eq(lagerInventeringSkanningarTable.inventeringId, id), eq(lagerInventeringSkanningarTable.pktNrSkannat, pktNr)));
    if (redan) return { kind: "konflikt" as const, error: `Paket ${pktNr} är redan skannat i den här inventeringen` };

    const nya = await tx
      .update(lagerPosterTable)
      .set({ datumUt: null, avrappTyp: null, uppdateradAt: new Date() })
      .where(inArray(lagerPosterTable.id, avrapporterade.map((r) => r.id)))
      .returning();
    await tx.insert(lagerHistorikTable).values(
      nya.map((r) => ({
        lagerId: r.id,
        action: "inventering_aterinford_avrapporterat",
        changedBy: req.userId,
        andringar: JSON.stringify({ inventeringId: id, datumUt: null }),
      })),
    );
    const { klassificering } = await registreraSkanning(tx, session, pktNr, metod, req.userId, nya);
    return { kind: "ok" as const, session, klassificering };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  const v = resultat.value;
  if (v.kind === "session_stangd") {
    res.status(400).json({ error: "Sessionen är inte pågående" });
    return;
  }
  if (v.kind === "konflikt") {
    res.status(409).json({ error: v.error });
    return;
  }
  res.status(201).json({
    aterinford: true,
    pktNr,
    klassificering: v.klassificering,
    session: await byggSessionsoversikt(v.session),
  });
});


// Detaljerade rapportrader (en per skannat pktNr) för utskrift/export —
// driver både "Inventeringslista utan priser" och "Värderad
// inventeringslista". En avslutad (eller pågående) inventering ska vara en
// oföränderlig historisk ögonblicksbild: dimension/kvalitet/profil/träslag/
// längd/styck/NOM m³/plats läses därför från den FRYSTA skanningshistoriken
// (`lager_inventering_skanning_rader`), inte från ett live-join mot
// `lager_poster` — en senare flytt, delning, korrigering eller
// utleverans av paketet ändrar aldrig en redan visad rapportrad. Endast
// skanningar som gjordes INNAN denna frysning infördes saknar den och
// faller (per rad) tillbaka på ett live-uppslag som tidigare. Prisfälten
// (om paketet är prissatt) är sedan tidigare alltid den frusna snapshoten
// från lager_inventering_priser.
router.get("/:id/rader", async (req, res) => {
  const id = Number(req.params.id);
  const session = await hamtaSession(id);
  if (!session) {
    res.status(404).json({ error: "Sessionen hittades inte" });
    return;
  }

  const skanningar = await db
    .select()
    .from(lagerInventeringSkanningarTable)
    .where(eq(lagerInventeringSkanningarTable.inventeringId, id));

  const skanningIds = skanningar.map((s) => s.id);
  const raderPerSkanning = new Map<number, (typeof lagerInventeringSkanningRaderTable.$inferSelect)[]>();
  if (skanningIds.length > 0) {
    const allaRader = await db
      .select()
      .from(lagerInventeringSkanningRaderTable)
      .where(inArray(lagerInventeringSkanningRaderTable.skanningId, skanningIds));
    for (const rad of allaRader) {
      const arr = raderPerSkanning.get(rad.skanningId) ?? [];
      arr.push(rad);
      raderPerSkanning.set(rad.skanningId, arr);
    }
  }

  const priser = await db
    .select()
    .from(lagerInventeringPriserTable)
    .where(eq(lagerInventeringPriserTable.inventeringId, id));
  const prisMap = new Map(priser.map((p) => [p.pktNr, p]));

  const omradeCache = new Map<number, string>();
  const fackCache = new Map<number, string>();
  async function omradeNamn(omradeId: number): Promise<string | null> {
    if (!omradeCache.has(omradeId)) {
      const [o] = await db.select().from(lagerOmradenTable).where(eq(lagerOmradenTable.id, omradeId));
      if (o) omradeCache.set(omradeId, o.namn);
    }
    return omradeCache.get(omradeId) ?? null;
  }
  async function fackKod(fackId: number): Promise<string | null> {
    if (!fackCache.has(fackId)) {
      const [f] = await db.select().from(lagerFackTable).where(eq(lagerFackTable.id, fackId));
      if (f) fackCache.set(fackId, f.kod);
    }
    return fackCache.get(fackId) ?? null;
  }

  const rader = [];
  for (const s of skanningar) {
    const skanningRader = raderPerSkanning.get(s.id) ?? [];
    const detaljer =
      paketDetaljerFranFrystHistorik(skanningRader, s.frystUtanRader) ??
      sammanstallPaketDetaljer(await hamtaAktuellaPaketRader(s.pktNrSkannat));
    const pris = prisMap.get(s.pktNrSkannat);
    rader.push({
      pktNr: s.pktNrSkannat,
      klassificering: s.klassificering,
      traslag: detaljer.traslag,
      profil: detaljer.profil,
      kvalitet: detaljer.kvalitet,
      nomTjocklek: detaljer.nomTjocklek,
      nomBredd: detaljer.nomBredd,
      langder: detaljer.langder,
      styck: detaljer.styck,
      nomM3: round2(detaljer.nomM3),
      omradeId: detaljer.omradeId,
      omradeNamn: detaljer.omradeId != null ? await omradeNamn(detaljer.omradeId) : null,
      fackId: detaljer.fackId,
      fackKod: detaljer.fackId != null ? await fackKod(detaljer.fackId) : null,
      blandadPlacering: detaljer.blandadPlacering,
      pris: pris
        ? {
            prisPerNomM3: Number(pris.prisPerNomM3),
            nomM3: Number(pris.nomM3),
            lagervarde: Number(pris.lagervarde),
            satAv: pris.satAv,
            satAt: pris.satAt.toISOString(),
          }
        : null,
    });
  }

  res.json(rader);
});

// Värderingssammanfattning för en session, inklusive jämförelse mot den
// senaste TIDIGARE avslutade sessionen i SAMMA fack (kronologiskt) — detta
// är kroken som möjliggör framtida årsvis jämförelse av NOM m³/lagervärde
// utan att behöva bygga om datamodellen igen.
router.get("/:id/varde", async (req, res) => {
  const id = Number(req.params.id);
  const session = await hamtaSession(id);
  if (!session) {
    res.status(404).json({ error: "Sessionen hittades inte" });
    return;
  }

  const varde = await beraknaVardeSummering(id);

  const villkor = [
    eq(lagerInventeringarTable.fackId, session.fackId),
    eq(lagerInventeringarTable.status, "avslutad"),
    ne(lagerInventeringarTable.id, id),
  ];
  if (session.avslutadAt) {
    villkor.push(lt(lagerInventeringarTable.avslutadAt, session.avslutadAt));
  }
  const [foregaende] = await db
    .select()
    .from(lagerInventeringarTable)
    .where(and(...villkor))
    .orderBy(desc(lagerInventeringarTable.avslutadAt))
    .limit(1);

  let jamforelse = null;
  if (foregaende) {
    const foregaendeVarde = await beraknaVardeSummering(foregaende.id);
    jamforelse = {
      foregaendeInventeringId: foregaende.id,
      foregaendeAvslutadAt: foregaende.avslutadAt ? foregaende.avslutadAt.toISOString() : null,
      foregaende: foregaendeVarde,
      forandringNomM3: round2(varde.totaltNomM3 - foregaendeVarde.totaltNomM3),
      forandringLagervarde: round2(varde.totaltLagervarde - foregaendeVarde.totaltLagervarde),
    };
  }

  res.json({ ...varde, jamforelse });
});

// Prissätter ett eller flera skannade paket (samma pris/NOM m³ för alla i
// listan) — täcker både "enskilt paket" (lista med 1 element), "flera
// markerade paket" och bulkprissättning på en grupp (frontend räknar ut
// vilka pktNr som delar dimension/kvalitet/profil/träslag och skickar in
// dem i samma anrop). Omprissättning av ett redan prissatt paket är en
// UPPDATERING (upsert) av dess snapshot, inte en ny historisk rad.
router.post("/:id/prissatt", async (req, res) => {
  const id = Number(req.params.id);
  const pktNrLista = Array.isArray(req.body?.pktNrLista)
    ? (req.body.pktNrLista as unknown[]).map((p) => String(p).trim()).filter(Boolean)
    : [];
  const prisPerNomM3 = Number(req.body?.prisPerNomM3);

  if (pktNrLista.length === 0) {
    res.status(400).json({ error: "pktNrLista krävs" });
    return;
  }
  if (!Number.isFinite(prisPerNomM3) || prisPerNomM3 < 0) {
    res.status(400).json({ error: "prisPerNomM3 måste vara ett positivt tal" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx) => {
    const prissatta: { pktNr: string; nomM3: number; lagervarde: number }[] = [];
    const fel: { pktNr: string; anledning: string }[] = [];

    for (const pktNr of pktNrLista) {
      const [skanning] = await tx
        .select()
        .from(lagerInventeringSkanningarTable)
        .where(and(eq(lagerInventeringSkanningarTable.inventeringId, id), eq(lagerInventeringSkanningarTable.pktNrSkannat, pktNr)));
      if (!skanning) {
        fel.push({ pktNr, anledning: "Paketet är inte skannat i denna inventering" });
        continue;
      }

      const rader = await hamtaAktuellaPaketRader(pktNr);
      const nomM3 = rader.reduce((sum, r) => sum + toNumber(r.m3), 0);
      if (nomM3 <= 0) {
        fel.push({ pktNr, anledning: "Paketet saknar NOM m³ och kan inte prissättas" });
        continue;
      }
      const lagervarde = round2(nomM3 * prisPerNomM3);

      await tx
        .insert(lagerInventeringPriserTable)
        .values({
          inventeringId: id,
          pktNr,
          prisPerNomM3: String(prisPerNomM3),
          nomM3: String(round2(nomM3)),
          lagervarde: String(lagervarde),
          satAv: req.userId,
        })
        .onConflictDoUpdate({
          target: [lagerInventeringPriserTable.inventeringId, lagerInventeringPriserTable.pktNr],
          set: {
            prisPerNomM3: String(prisPerNomM3),
            nomM3: String(round2(nomM3)),
            lagervarde: String(lagervarde),
            satAv: req.userId,
            uppdateradAt: new Date(),
          },
        });

      prissatta.push({ pktNr, nomM3: round2(nomM3), lagervarde });
    }
    return { prissatta, fel };
  });

  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  res.json({ ...resultat.value, varde: await beraknaVardeSummering(id) });
});

// Tar bort prissättning för ett eller flera paket i en session (t.ex. för
// att rätta ett felskrivet pris). Rör aldrig lager_poster.
router.delete("/:id/prissatt", async (req, res) => {
  const id = Number(req.params.id);
  const pktNrLista = Array.isArray(req.body?.pktNrLista)
    ? (req.body.pktNrLista as unknown[]).map((p) => String(p).trim()).filter(Boolean)
    : [];
  if (pktNrLista.length === 0) {
    res.status(400).json({ error: "pktNrLista krävs" });
    return;
  }

  const resultat = await medLastOmgångForSessionsmutation(id, async (tx) => {
    await tx
      .delete(lagerInventeringPriserTable)
      .where(and(eq(lagerInventeringPriserTable.inventeringId, id), inArray(lagerInventeringPriserTable.pktNr, pktNrLista)));
    return { borttagna: pktNrLista };
  });
  if (!resultat.ok) {
    res.status(resultat.status).json({ error: resultat.error });
    return;
  }
  res.json({ ...resultat.value, varde: await beraknaVardeSummering(id) });
});

export default router;
