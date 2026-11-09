// Permanent regression suite for inventeringsomgångar (Task #20 + den
// senare skärpningen av dubbelskanningshantering). Ersätter de tidigare
// engångsverifieringsskripten — se .agents/memory/lager-inventeringsomgangar.md
// för designbeslut och .agents/memory/lager-pktnr-atomicity.md.
//
// Körs mot den RIKTIGA (dev-)databasen, precis som den ursprungliga
// engångsverifieringen gjorde — projektet har ingen separat testdatabas.
// All testdata skapas under unika område/fack-namn (prefix "TEST_") och
// städas bort i `afterAll`, oavsett om assertions ovanför misslyckas.
//
// VIKTIGT (se minnesanteckning): "./app" importeras allra FÖRST för att
// undvika "handler must be a function" från olösta cirkulära router-
// exports — routes/lager.ts (som routes/inventering.ts importerar
// applyLagerPatch från) importerar i sin tur requireAdmin från "../app".
import "../../app";

import express from "express";
import type { Server } from "node:http";
import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { clerkClient } from "@clerk/express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  lagerOmradenTable,
  lagerFackTable,
  lagerPosterTable,
  lagerInventeringarTable,
  lagerInventeringsomgangarTable,
  lagerInventeringsomgangSammanfattningTable,
  lagerInventeringsomgangGlobalSnapshotTable,
  lagerInventeringForvantadeTable,
} from "@workspace/db";
import inventeringRouter from "../inventering";
import inventeringsomgangarRouter from "../inventeringsomgangar";
import lagerRouter, { applyLagerPatch } from "../lager";

vi.mock("@clerk/express", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...actual,
    getAuth: (req: express.Request & { auth?: () => unknown }) => req.auth?.(),
  };
});

// --- Testapp: samma routrar som produktionen, med en injicerad auth/user
// --- och en Clerk-user-mock så requireAdmin kan testas deterministiskt. ---
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = String(req.header("x-test-user") ?? "testare");
    (req as express.Request & { userId?: string; auth?: () => unknown }).userId = userId;
    (req as express.Request & { auth?: () => unknown }).auth = () => ({
      userId,
      sessionId: "test-session",
      sessionClaims: { userId },
      tokenType: "session_token",
    });
    next();
  });
  app.use("/inventering", inventeringRouter);
  app.use("/inventeringsomgangar", inventeringsomgangarRouter);
  app.use("/lager", lagerRouter);
  return app;
}

let server: Server;
let baseUrl: string;

async function api<T = unknown>(
  method: string,
  path: string,
  opts: { body?: unknown; user?: string } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.user ? { "x-test-user": opts.user } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(
        [
          `Test-API returned non-JSON for ${method} ${res.url}`,
          `status=${res.status}`,
          `content-type=${contentType || "<missing>"}`,
          `body=${JSON.stringify(text)}`,
        ].join("\n"),
        { cause: error },
      );
    }
  }
  return { status: res.status, data: data as T };
}

// --- Testdatafixtur --------------------------------------------------------
// Två fack i samma testområde. lager_poster-rader lämnas annars minimala
// (endast de fält affärslogiken faktiskt läser) — "aktuellt lager" kräver
// bara att datumUt/raderadAt/avrappTyp inte utesluter raden, se
// lib/lagerFilters.ts.
const omradeIds: number[] = [];
const fackIds: number[] = [];
const posterIds: number[] = [];
const sessionIds: number[] = [];
const omgangIds: number[] = [];

async function skapaOmrade(namn: string) {
  const [o] = await db
    .insert(lagerOmradenTable)
    .values({ namn, slug: namn.toLowerCase().replace(/[^a-z0-9]+/g, "-") })
    .returning();
  omradeIds.push(o.id);
  return o;
}

async function skapaFack(omradeId: number, kod: string) {
  const [f] = await db.insert(lagerFackTable).values({ omradeId, kod }).returning();
  fackIds.push(f.id);
  return f;
}

async function skapaPost(opts: { omradeId: number; fackId: number; pktNr: string; antal?: number; m3?: number }) {
  const [p] = await db
    .insert(lagerPosterTable)
    .values({
      pktNr: opts.pktNr,
      omradeId: opts.omradeId,
      fackId: opts.fackId,
      traslag: "Furu",
      antal: opts.antal ?? 10,
      m3: String(opts.m3 ?? 1.5),
    })
    .returning();
  posterIds.push(p.id);
  return p;
}

async function mjukRaderaPost(id: number, datumUt: string | null = null) {
  await db
    .update(lagerPosterTable)
    .set({ raderadAt: new Date(), datumUt })
    .where(eq(lagerPosterTable.id, id));
}

async function startaSession(omradeId: number, fackId: number, omgangId?: number, user = "testare") {
  const { data } = await api<{ session: { id: number } }>("POST", "/inventering/start", {
    body: { omradeId, fackId, ...(omgangId ? { omgangId } : {}) },
    user,
  });
  sessionIds.push(data.session.id);
  return data.session.id;
}

async function skanna(sessionId: number, pktNr: string, user = "testare") {
  return api("POST", `/inventering/${sessionId}/skanna`, { body: { pktNr }, user });
}

async function avslutaSession(sessionId: number, user = "testare") {
  return api("POST", `/inventering/${sessionId}/avsluta`, { user });
}

async function skapaOmgang(namn: string, omradeId: number, user = "testare") {
  const { data } = await api<{ id: number }>("POST", "/inventeringsomgangar", {
    body: { namn, typ: "kontrollinventering", omradeIds: [omradeId] },
    user,
  });
  omgangIds.push(data.id);
  return data.id;
}

// En "arsinventering" är per definition HELA lagret — se global-snapshot-
// kommentaren på lagerInventeringsomgangGlobalSnapshotTable. Fackomfånget
// (för att sessionerna ska kunna starta) sätts ändå explicit precis som en
// kontrollinventering, men den globala snapshoten tas ALLTID över hela
// lager_poster (iLagerConditions), oavsett omfångets område(n).
async function skapaArsinventering(namn: string, omradeId: number, user = "testare") {
  const { data } = await api<{ id: number }>("POST", "/inventeringsomgangar", {
    body: { namn, typ: "arsinventering", omradeIds: [omradeId] },
    user,
  });
  omgangIds.push(data.id);
  return data.id;
}

beforeAll(async () => {
  vi.spyOn(clerkClient.users, "getUser").mockImplementation(async (userId) => ({
    id: userId,
    publicMetadata: { role: userId === "non-admin" ? "user" : "admin" },
  }) as never);
  const app = buildTestApp();
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Kunde inte starta testservern");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  // Ordning viktig: omgångar (cascadar fack-scope/sammanfattning/konflikter/
  // lösningar) → sessioner (cascadar forväntade/skanningar/skanningrader/
  // priser) → lagerposter → fack → områden. lager_inventeringars fack_id/
  // omrade_id-FK:er har ingen cascade, så sessionerna måste bort innan facken.
  if (omgangIds.length) await db.delete(lagerInventeringsomgangarTable).where(inArray(lagerInventeringsomgangarTable.id, omgangIds));
  if (sessionIds.length) await db.delete(lagerInventeringarTable).where(inArray(lagerInventeringarTable.id, sessionIds));
  if (posterIds.length) await db.delete(lagerPosterTable).where(inArray(lagerPosterTable.id, posterIds));
  if (fackIds.length) await db.delete(lagerFackTable).where(inArray(lagerFackTable.id, fackIds));
  if (omradeIds.length) await db.delete(lagerOmradenTable).where(inArray(lagerOmradenTable.id, omradeIds));

  await pool.end();
});

describe("Inventeringsomgångar — grundflöde", () => {
  test("hittade och saknade paket räknas separat, och saknat NOM m³ bidrar aldrig till funnet", async () => {
    const omrade = await skapaOmrade("TEST_Grundflode");
    const fack = await skapaFack(omrade.id, "A1");
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-FOUND", antal: 5, m3: 1 });
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-MISSING", antal: 3, m3: 0.5 });

    const omgangId = await skapaOmgang("Grundflöde", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    await skanna(sessionId, "P-FOUND");
    // P-MISSING skannas aldrig.
    await avslutaSession(sessionId);

    const { status } = await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    expect(status).toBe(200);

    const { data } = await api<{ sammanfattning: { totalt: { styck: number; totaltNomM3: number; antalSaknade: number; styckSaknat: number; nomM3Saknat: number } } }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    const totalt = data.sammanfattning.totalt;
    expect(totalt.styck).toBe(5);
    expect(totalt.totaltNomM3).toBeCloseTo(1);
    expect(totalt.antalSaknade).toBe(1);
    expect(totalt.styckSaknat).toBe(3);
    expect(totalt.nomM3Saknat).toBeCloseTo(0.5);
  });

  test("ett pktNr utan aktuella rader fryser till noll och en senare orelaterad post läcker aldrig in NOM m³", async () => {
    const omrade = await skapaOmrade("TEST_FrystNoll");
    const fack = await skapaFack(omrade.id, "A1");

    const omgangId = await skapaOmgang("FrystNoll", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    // Skanna ett pktNr som INTE finns som lagerpost alls -> klassificeras
    // "okänd" och fryses medvetet till noll (frystUtanRader).
    await skanna(sessionId, "P-OKAND-000");
    await avslutaSession(sessionId);
    await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);

    const { data: fore } = await api<{ sammanfattning: { totalt: { styck: number; totaltNomM3: number } } }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    expect(fore.sammanfattning.totalt.styck).toBe(0);
    expect(Number(fore.sammanfattning.totalt.totaltNomM3)).toBe(0);

    // En helt orelaterad post med samma pktNr dyker upp EFTER avslut.
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-OKAND-000", antal: 99, m3: 42 });

    const { data: efter } = await api<{ sammanfattning: { totalt: { styck: number; totaltNomM3: number } } }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    expect(efter.sammanfattning.totalt.styck).toBe(0);
    expect(Number(efter.sammanfattning.totalt.totaltNomM3)).toBe(0);
  });
});

describe("Inventering — återinför historiskt mjukraderat paket", () => {
  test("levererad rad utan raderadAt är avrapporterad: varnar utan att skanna eller ändra lagret", async () => {
    // Tidigare klassades detta som en vanlig "okänd" skanning. Det dolde det
    // vanliga fallet att ett paket avrapporterats på en order men ändå står
    // kvar (ombyte). Nu returneras ett avrapporterat-svar; skanningen sparas
    // först när användaren valt åtgärd (byt/återinför) — se
    // inventeringAvrapporterat.test.ts.
    const omrade = await skapaOmrade("TEST_LevereradOkand");
    const fack = await skapaFack(omrade.id, "A1");
    const post = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-LEVERERAD", antal: 1, m3: 0.2 });
    await db.update(lagerPosterTable).set({ datumUt: "2026-01-01" }).where(eq(lagerPosterTable.id, post.id));
    const sessionId = await startaSession(omrade.id, fack.id);
    const scanned = await api<{ deregistrerad?: boolean; avrapporterad?: boolean; klassificering: string }>("POST", `/inventering/${sessionId}/skanna`, {
      body: { pktNr: "P-LEVERERAD" },
    });
    expect(scanned.status).toBe(200);
    expect(scanned.data.avrapporterad).toBe(true);
    expect(scanned.data.deregistrerad).not.toBe(true);
    const [efter] = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, post.id));
    expect(efter.datumUt).toBe("2026-01-01");
    const oversikt = await api<{ skanningar: unknown[] }>("GET", `/inventering/${sessionId}`);
    expect(oversikt.data.skanningar).toHaveLength(0);
  });

  test("identifierar utan mutation, återställer atomiskt och kan sedan skanna som vanligt", async () => {
    const omrade = await skapaOmrade("TEST_AterstallEnRad");
    const fack = await skapaFack(omrade.id, "A1");
    const post = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ATER-1", antal: 7, m3: 1.1 });
    const fore = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, post.id));
    await mjukRaderaPost(post.id);

    const omgangId = await skapaOmgang("Återställ en rad", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);

    const sok = await api<{ data: { pktNr: string; deregistrerad: boolean; kanAterstallas: boolean }[] }>(
      "GET",
      "/inventering/sok-paket?q=P-ATER-1",
    );
    expect(sok.data.data[0]).toMatchObject({ pktNr: "P-ATER-1", deregistrerad: true, kanAterstallas: true });
    const efterSok = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, post.id));
    expect(efterSok[0].raderadAt).not.toBeNull();

    const scanFore = await api<{ deregistrerad: boolean; kanAterstallas: boolean }>(
      "POST",
      `/inventering/${sessionId}/skanna`,
      { body: { pktNr: "P-ATER-1" } },
    );
    expect(scanFore.data).toMatchObject({ deregistrerad: true, kanAterstallas: true });
    const efterScan = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, post.id));
    expect(efterScan[0].raderadAt).not.toBeNull();

    const nekad = await api<{ error: string }>("POST", `/inventering/${sessionId}/aterstall`, {
      body: { pktNr: "P-ATER-1" },
      user: "non-admin",
    });
    expect(nekad.status).toBe(403);

    const aterstall = await api<{ aterstalld: boolean; antalRader: number }>(
      "POST",
      `/inventering/${sessionId}/aterstall`,
      { body: { pktNr: "P-ATER-1" } },
    );
    expect(aterstall.status).toBe(200);
    expect(aterstall.data).toMatchObject({ aterstalld: true, antalRader: 1 });
    const efterAterstall = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, post.id));
    expect(efterAterstall[0].raderadAt).toBeNull();
    expect(efterAterstall[0].datumUt).toBe(fore[0].datumUt);
    expect(efterAterstall[0].omradeId).toBe(fore[0].omradeId);
    expect(efterAterstall[0].fackId).toBe(fore[0].fackId);
    expect(efterAterstall[0].pktNr).toBe(fore[0].pktNr);
    expect(efterAterstall[0].traslag).toBe(fore[0].traslag);
    expect(efterAterstall[0].antal).toBe(fore[0].antal);
    expect(efterAterstall[0].m3).toBe(fore[0].m3);

    const scanEfter = await api<{ klassificering: string }>("POST", `/inventering/${sessionId}/skanna`, {
      body: { pktNr: "P-ATER-1" },
    });
    expect(scanEfter.status).toBe(201);
    expect(scanEfter.data.klassificering).toBe("forvantad_hittad");
  });

  test("återställer flera längdrader tillsammans och avvisar datumUt", async () => {
    const omrade = await skapaOmrade("TEST_AterstallAtomic");
    const fack = await skapaFack(omrade.id, "A1");
    const radA = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ATER-MULTI", antal: 2, m3: 0.4 });
    const radB = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ATER-MULTI", antal: 3, m3: 0.6 });
    const utRad = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ATER-UT", antal: 1, m3: 0.2 });
    const aktivKonflikt = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ATER-KONFLIKT", antal: 1, m3: 0.2 });
    const raderadKonflikt = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ATER-KONFLIKT", antal: 2, m3: 0.3 });
    await mjukRaderaPost(radA.id);
    await mjukRaderaPost(radB.id);
    await mjukRaderaPost(utRad.id, "2026-01-01");
    await mjukRaderaPost(raderadKonflikt.id);

    const omgangId = await skapaOmgang("Återställ atomiskt", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    const restore = await api<{ antalRader: number }>("POST", `/inventering/${sessionId}/aterstall`, {
      body: { pktNr: "P-ATER-MULTI" },
    });
    expect(restore.status).toBe(200);
    expect(restore.data.antalRader).toBe(2);
    const multi = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, [radA.id, radB.id]));
    expect(multi.every((r) => r.raderadAt === null)).toBe(true);

    const rejected = await api<{ error: string }>("POST", `/inventering/${sessionId}/aterstall`, {
      body: { pktNr: "P-ATER-UT" },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.data.error).toMatch(/datumUt/i);
    const unchanged = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, utRad.id));
    expect(unchanged[0].raderadAt).not.toBeNull();

    const conflict = await api<{ error: string }>("POST", `/inventering/${sessionId}/aterstall`, {
      body: { pktNr: "P-ATER-KONFLIKT" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.data.error).toMatch(/aktivt eller blandat paket/i);
    const conflictRows = await db
      .select()
      .from(lagerPosterTable)
      .where(inArray(lagerPosterTable.id, [aktivKonflikt.id, raderadKonflikt.id]));
    expect(conflictRows.find((r) => r.id === aktivKonflikt.id)?.raderadAt).toBeNull();
    expect(conflictRows.find((r) => r.id === raderadKonflikt.id)?.raderadAt).not.toBeNull();
  });
});

describe("Inventeringsomgångar — dubbelskanning kräver manuell hantering", () => {
  test("dubbelskannat pktNr blockerar avslut (409) tills en människa löser konflikten", async () => {
    const omrade = await skapaOmrade("TEST_Dubbel1");
    const fackA = await skapaFack(omrade.id, "A1");
    const fackB = await skapaFack(omrade.id, "B1");
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-DUBBEL-1", antal: 4, m3: 2 });

    const omgangId = await skapaOmgang("Dubbel1", omrade.id);
    const sessionA = await startaSession(omrade.id, fackA.id, omgangId);
    const sessionB = await startaSession(omrade.id, fackB.id, omgangId);
    // Samma fysiska pktNr skannas "hittat" i två olika fack-sessioner.
    await skanna(sessionA, "P-DUBBEL-1");
    await skanna(sessionB, "P-DUBBEL-1");
    await avslutaSession(sessionA);
    await avslutaSession(sessionB);

    const preview = await api<{ antalOlostaBlockerande: number; dubbelskanningar: { pktNr: string; olost: boolean; kandidater: { sessionId: number }[] }[] }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/dubbelskanningar`,
    );
    expect(preview.data.antalOlostaBlockerande).toBe(1);
    expect(preview.data.dubbelskanningar).toHaveLength(1);
    expect(preview.data.dubbelskanningar[0].olost).toBe(true);
    const kandidatSessioner = preview.data.dubbelskanningar[0].kandidater.map((k) => k.sessionId).sort();
    expect(kandidatSessioner).toEqual([sessionA, sessionB].sort());

    const avsluta = await api<{ olostaPktNr: string[] }>("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    expect(avsluta.status).toBe(409);
    expect(avsluta.data.olostaPktNr).toEqual(["P-DUBBEL-1"]);

    // Omgången förblir pågående — inget skrevs.
    const [rad] = await db.select().from(lagerInventeringsomgangarTable).where(eq(lagerInventeringsomgangarTable.id, omgangId));
    expect(rad.status).toBe("pagaende");
  });

  test("explicit val av rätt fack löser konflikten, avslutar, och paketet räknas exakt en gång mot det valda fackets område", async () => {
    const omradeA = await skapaOmrade("TEST_DubbelValA");
    const omradeB = await skapaOmrade("TEST_DubbelValB");
    const fackA = await skapaFack(omradeA.id, "A1");
    const fackB = await skapaFack(omradeB.id, "B1");
    await skapaPost({ omradeId: omradeA.id, fackId: fackA.id, pktNr: "P-DUBBEL-2", antal: 6, m3: 3 });

    const omgangId = await skapaOmgang("DubbelVal", omradeA.id);
    // Registrera bara omrade A i omfånget via skapaOmgang, men lägg till
    // fack B manuellt i omfånget genom att starta dess session direkt (fack B
    // ingår inte i frysta omfånget om det inte skapades med) — så skapa
    // omgången med båda områdena explicit istället.
    const { data: full } = await api<{ id: number }>("POST", "/inventeringsomgangar", {
      body: { namn: "DubbelVal-full", typ: "kontrollinventering", omradeIds: [omradeA.id, omradeB.id] },
    });
    omgangIds.push(full.id);

    const sessionA = await startaSession(omradeA.id, fackA.id, full.id);
    const sessionB = await startaSession(omradeB.id, fackB.id, full.id);
    await skanna(sessionA, "P-DUBBEL-2");
    await skanna(sessionB, "P-DUBBEL-2");
    await avslutaSession(sessionA);
    await avslutaSession(sessionB);

    // Peka ut fack B:s session som den korrekta.
    const los = await api<{ pktNr: string; valdSessionId: number; hanteradAv: string }>(
      "POST",
      `/inventeringsomgangar/${full.id}/dubbelskanningar/P-DUBBEL-2/los`,
      { body: { valdSessionId: sessionB }, user: "alice" },
    );
    expect(los.status).toBe(200);
    expect(los.data.hanteradAv).toBe("alice");

    const previewEfter = await api<{ antalOlostaBlockerande: number; dubbelskanningar: { olost: boolean; losning: { valdSessionId: number; hanteradAv: string } | null }[] }>(
      "GET",
      `/inventeringsomgangar/${full.id}/dubbelskanningar`,
    );
    expect(previewEfter.data.antalOlostaBlockerande).toBe(0);
    expect(previewEfter.data.dubbelskanningar[0].olost).toBe(false);
    expect(previewEfter.data.dubbelskanningar[0].losning?.valdSessionId).toBe(sessionB);

    const avsluta = await api("POST", `/inventeringsomgangar/${full.id}/avsluta`);
    expect(avsluta.status).toBe(200);

    const { data } = await api<{
      sammanfattning: {
        totalt: { styck: number; antalKonflikter: number };
        perOmrade: { omradeId: number; styck: number }[];
        konflikter: { pktNr: string; typ: string; losningSessionId: number | null; hanteradAv: string | null }[];
      };
    }>("GET", `/inventeringsomgangar/${full.id}`);

    // Räknas exakt EN gång totalt...
    expect(data.sammanfattning.totalt.styck).toBe(6);
    expect(data.sammanfattning.totalt.antalKonflikter).toBe(1);
    // ...och tillskrivs område B (det valda fyndet), INTE område A.
    const perOmradeMedFynd = data.sammanfattning.perOmrade.filter((r) => r.styck > 0);
    expect(perOmradeMedFynd).toHaveLength(1);
    expect(perOmradeMedFynd[0].omradeId).toBe(omradeB.id);

    const konflikt = data.sammanfattning.konflikter.find((k) => k.pktNr === "P-DUBBEL-2");
    expect(konflikt?.typ).toBe("dubbelskannad");
    expect(konflikt?.losningSessionId).toBe(sessionB);
    expect(konflikt?.hanteradAv).toBe("alice");
  });

  test("'hanterad' utan val bekräftar konflikten och faller tillbaka på senaste skanningen", async () => {
    const omrade = await skapaOmrade("TEST_DubbelHanterad");
    const fackA = await skapaFack(omrade.id, "A1");
    const fackB = await skapaFack(omrade.id, "B1");
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-DUBBEL-3", antal: 2, m3: 1 });

    const omgangId = await skapaOmgang("DubbelHanterad", omrade.id);
    const sessionA = await startaSession(omrade.id, fackA.id, omgangId);
    await skanna(sessionA, "P-DUBBEL-3");
    // Liten fördröjning så sessionB:s skanning garanterat har en senare
    // tidsstämpel än sessionA:s.
    await new Promise((r) => setTimeout(r, 20));
    const sessionB = await startaSession(omrade.id, fackB.id, omgangId);
    await skanna(sessionB, "P-DUBBEL-3");
    await avslutaSession(sessionA);
    await avslutaSession(sessionB);

    const los = await api("POST", `/inventeringsomgangar/${omgangId}/dubbelskanningar/P-DUBBEL-3/los`, {
      body: { hanterad: true },
      user: "bob",
    });
    expect(los.status).toBe(200);

    const avsluta = await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    expect(avsluta.status).toBe(200);

    const { data } = await api<{ sammanfattning: { konflikter: { pktNr: string; sessionIdAnvand: number; hanteradAv: string | null; losningSessionId: number | null }[] } }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    const konflikt = data.sammanfattning.konflikter.find((k) => k.pktNr === "P-DUBBEL-3")!;
    // "hanterad" utan val -> senaste skanningen (session B) vinner, precis
    // som innan skärpningen, men nu bara efter medveten bekräftelse.
    expect(konflikt.sessionIdAnvand).toBe(sessionB);
    expect(konflikt.losningSessionId).toBeNull();
    expect(konflikt.hanteradAv).toBe("bob");
  });

  test("en ny skanning i ett tredje fack gör en tidigare lösning förlegad igen", async () => {
    const omrade = await skapaOmrade("TEST_DubbelForlegad");
    const fackA = await skapaFack(omrade.id, "A1");
    const fackB = await skapaFack(omrade.id, "B1");
    const fackC = await skapaFack(omrade.id, "C1");
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-DUBBEL-4", antal: 1, m3: 0.4 });

    const omgangId = await skapaOmgang("DubbelForlegad", omrade.id);
    const sessionA = await startaSession(omrade.id, fackA.id, omgangId);
    const sessionB = await startaSession(omrade.id, fackB.id, omgangId);
    await skanna(sessionA, "P-DUBBEL-4");
    await skanna(sessionB, "P-DUBBEL-4");

    const los = await api("POST", `/inventeringsomgangar/${omgangId}/dubbelskanningar/P-DUBBEL-4/los`, {
      body: { valdSessionId: sessionA },
    });
    expect(los.status).toBe(200);

    let preview = await api<{ antalOlostaBlockerande: number }>("GET", `/inventeringsomgangar/${omgangId}/dubbelskanningar`);
    expect(preview.data.antalOlostaBlockerande).toBe(0);

    // Ett tredje fack skannar samma pktNr innan omgången avslutas — den
    // registrerade lösningen matchar inte längre den fulla kandidatlistan.
    const sessionC = await startaSession(omrade.id, fackC.id, omgangId);
    await skanna(sessionC, "P-DUBBEL-4");

    preview = await api<{ antalOlostaBlockerande: number }>("GET", `/inventeringsomgangar/${omgangId}/dubbelskanningar`);
    expect(preview.data.antalOlostaBlockerande).toBe(1);

    const avsluta = await api<{ olostaPktNr: string[] }>("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    expect(avsluta.status).toBe(409);
    expect(avsluta.data.olostaPktNr).toEqual(["P-DUBBEL-4"]);

    await avslutaSession(sessionA);
    await avslutaSession(sessionB);
    await avslutaSession(sessionC);
  });

  test("'saknad_sedan_hittad' blockerar aldrig avslut, oavsett dubbelskanningar", async () => {
    const omrade = await skapaOmrade("TEST_SaknadHittad");
    const fackA = await skapaFack(omrade.id, "A1");
    const fackB = await skapaFack(omrade.id, "B1");
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-SAKNAD-1", antal: 7, m3: 2.2 });

    const omgangId = await skapaOmgang("SaknadHittad", omrade.id);
    const sessionA = await startaSession(omrade.id, fackA.id, omgangId);
    const sessionB = await startaSession(omrade.id, fackB.id, omgangId);
    // Saknas i A (aldrig skannat där), hittas i B.
    await skanna(sessionB, "P-SAKNAD-1");
    await avslutaSession(sessionA);
    await avslutaSession(sessionB);

    const avsluta = await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    expect(avsluta.status).toBe(200);

    const { data } = await api<{ sammanfattning: { totalt: { styck: number; antalSaknade: number }; konflikter: { pktNr: string; typ: string; blockerarAvslut: boolean }[] } }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    expect(data.sammanfattning.totalt.styck).toBe(7);
    expect(data.sammanfattning.totalt.antalSaknade).toBe(0);
    const konflikt = data.sammanfattning.konflikter.find((k) => k.pktNr === "P-SAKNAD-1")!;
    expect(konflikt.typ).toBe("saknad_sedan_hittad");
    expect(konflikt.blockerarAvslut).toBe(false);
  });
});

describe("Inventeringsomgångar — global saknas-avstämning (årsinventering)", () => {
  test("GET /saknade använder kontrollinventeringens frysta sessionssnapshot utan global snapshot", async () => {
    const omrade = await skapaOmrade("TEST_EjArs");
    const fack = await skapaFack(omrade.id, "A1");
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-EJ-ARS", antal: 1, m3: 1 });
    const omgangId = await skapaOmgang("EjArs", omrade.id);

    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    const { status, data } = await api<{
      harGlobalSnapshot: boolean;
      kontrollinventering: boolean;
      paket: { pktNr: string }[];
    }>("GET", `/inventeringsomgangar/${omgangId}/saknade`);
    expect(status).toBe(200);
    expect(data.harGlobalSnapshot).toBe(false);
    expect(data.kontrollinventering).toBe(true);
    expect(data.paket.map((p) => p.pktNr)).toContain("P-EJ-ARS");
    await avslutaSession(sessionId);
  });

  test("ett paket utan registrerat fack (NULL omrade/fack) som aldrig skannas hamnar i saknas-listan", async () => {
    const omrade = await skapaOmrade("TEST_ArsNullFack");
    const fack = await skapaFack(omrade.id, "A1");
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ARS-FUNNET", antal: 2, m3: 1 });
    // Simulerar ett paket registrerat utan omrade/fack (endast fritext-plats) —
    // det enda scenariot en per-sessions förväntade-lista aldrig kan fånga.
    const [utanFack] = await db
      .insert(lagerPosterTable)
      .values({ pktNr: "P-ARS-UTAN-FACK", traslag: "Furu", antal: 4, m3: "0.8", omradeId: null, fackId: null })
      .returning();
    posterIds.push(utanFack.id);

    const omgangId = await skapaArsinventering("ArsNullFack", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    await skanna(sessionId, "P-ARS-FUNNET");
    // P-ARS-UTAN-FACK skannas aldrig — och kan inte skannas i något fack
    // eftersom det inte finns registrerat i något.
    await avslutaSession(sessionId);

    const { status, data } = await api<{ harGlobalSnapshot: boolean; antalGlobalt: number; antalSaknas: number; paket: { pktNr: string; actTjocklek: string | null }[] }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/saknade`,
    );
    expect(status).toBe(200);
    expect(data.harGlobalSnapshot).toBe(true);
    // Snapshoten tas över HELA lagret, inte bara omgångens fackomfång —
    // så antalGlobalt inkluderar alla aktuella lager_poster-rader (>= de två
    // paket denna test bryr sig om).
    expect(data.antalGlobalt).toBeGreaterThanOrEqual(2);
    const pktNrLista = data.paket.map((p) => p.pktNr);
    expect(pktNrLista).toContain("P-ARS-UTAN-FACK");
    expect(pktNrLista).not.toContain("P-ARS-FUNNET");
  });

  test("ett paket skannat i ETT ANNAT fack under omgången räknas alltid som funnet, aldrig som saknat", async () => {
    const omrade = await skapaOmrade("TEST_ArsAnnatFack");
    const fackA = await skapaFack(omrade.id, "A1");
    const fackB = await skapaFack(omrade.id, "B1");
    // Registrerad i fack A, men kommer fysiskt hittas (skannas) i fack B.
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-ARS-FLYTTAD", antal: 3, m3: 0.9 });

    const { data: full } = await api<{ id: number }>("POST", "/inventeringsomgangar", {
      body: { namn: "ArsAnnatFack", typ: "arsinventering", omradeIds: [omrade.id] },
    });
    omgangIds.push(full.id);

    const sessionA = await startaSession(omrade.id, fackA.id, full.id);
    const sessionB = await startaSession(omrade.id, fackB.id, full.id);
    // Aldrig skannat i sitt förväntade fack A...
    await skanna(sessionB, "P-ARS-FLYTTAD"); // ...men hittat i fack B.
    await avslutaSession(sessionA);
    await avslutaSession(sessionB);

    const { data } = await api<{ paket: { pktNr: string }[] }>("GET", `/inventeringsomgangar/${full.id}/saknade`);
    expect(data.paket.map((p) => p.pktNr)).not.toContain("P-ARS-FLYTTAD");
  });

  test("'Behåll i lager' registrerar bara ett granskningsbeslut och rör aldrig lager_poster", async () => {
    const omrade = await skapaOmrade("TEST_ArsBehall");
    const fack = await skapaFack(omrade.id, "A1");
    const post = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ARS-BEHALL", antal: 1, m3: 0.3 });

    const omgangId = await skapaArsinventering("ArsBehall", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    await avslutaSession(sessionId); // P-ARS-BEHALL skannas aldrig.

    const { status, data } = await api<{ hanterade: string[]; beslut: string }>(
      "POST",
      `/inventeringsomgangar/${omgangId}/saknade/behall`,
      { body: { pktNrLista: ["P-ARS-BEHALL"], kommentar: "Letar vidare nästa vecka" }, user: "alice" },
    );
    expect(status).toBe(200);
    expect(data.hanterade).toEqual(["P-ARS-BEHALL"]);

    const [rad] = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, post.id));
    expect(rad.datumUt).toBeNull(); // oförändrad

    const { data: saknade } = await api<{ paket: { pktNr: string; beslut: { typ: string; kommentar: string | null; beslutadAv: string } | null }[] }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/saknade`,
    );
    const rad2 = saknade.paket.find((p) => p.pktNr === "P-ARS-BEHALL");
    expect(rad2?.beslut?.typ).toBe("behall_i_lager");
    expect(rad2?.beslut?.beslutadAv).toBe("alice");
  });

  test("avrapportering avslutar paketet (pktNr-atomiskt) via samma delade mutationskärna som utleverans, och blockerar ett faktiskt funnet paket", async () => {
    const omrade = await skapaOmrade("TEST_ArsAvrapp");
    const fack = await skapaFack(omrade.id, "A1");
    // Ett fysiskt paket som två lager_poster-rader (två längder) — testar
    // pktNr-atomicitet (Task #18): BÅDA raderna ska avrapporteras.
    const radA = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ARS-AVRAPP", antal: 2, m3: 0.4 });
    const radB = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ARS-AVRAPP", antal: 3, m3: 0.6 });
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ARS-FUNNET-2", antal: 1, m3: 0.2 });

    const omgangId = await skapaArsinventering("ArsAvrapp", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    await skanna(sessionId, "P-ARS-FUNNET-2");
    await avslutaSession(sessionId);

    // Ett redan FUNNET pktNr kan inte avrapporteras via denna väg.
    const blockerad = await api<{ avrapporterade: unknown[]; konflikter: { pktNr: string; anledning: string }[] }>(
      "POST",
      `/inventeringsomgangar/${omgangId}/saknade/avrapportera`,
      { body: { pktNrLista: ["P-ARS-FUNNET-2"] } },
    );
    expect(blockerad.data.avrapporterade).toHaveLength(0);
    expect(blockerad.data.konflikter[0]?.pktNr).toBe("P-ARS-FUNNET-2");

    const { status, data } = await api<{ avrapporterade: { pktNr: string; antalRader: number }[]; konflikter: unknown[] }>(
      "POST",
      `/inventeringsomgangar/${omgangId}/saknade/avrapportera`,
      { body: { pktNrLista: ["P-ARS-AVRAPP"], kommentar: "Bekräftat borta" }, user: "bob" },
    );
    expect(status).toBe(200);
    expect(data.konflikter).toHaveLength(0);
    expect(data.avrapporterade).toEqual([{ pktNr: "P-ARS-AVRAPP", antalRader: 2 }]);

    const raderna = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, [radA.id, radB.id]));
    expect(raderna.every((r) => r.datumUt !== null)).toBe(true);

    const historik = await db.execute(
      sql`select action from lager_historik where lager_id = ${radA.id} order by id desc limit 1`,
    );
    expect((historik.rows[0] as { action: string }).action).toBe("inventeringsomgang_saknat_avrapporterad");

    const { data: saknade } = await api<{ paket: { pktNr: string; beslut: { typ: string } | null }[] }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/saknade`,
    );
    // Ett avrapporterat pktNr har inte längre några AKTUELLA lager_poster-
    // rader, men fanns i den globala startsnapshoten — det ska fortsätta
    // synas i listan (för spårbarhet) med sitt beslut, inte försvinna tyst.
    const rad = saknade.paket.find((p) => p.pktNr === "P-ARS-AVRAPP");
    expect(rad?.beslut?.typ).toBe("avrapporterad");
  });
});

describe("Kontrollinventering — fryst sessionsomfång för saknade", () => {
  test("visar och avrapporterar endast frysta, selekterade paket; utanför scope och efter snapshot lämnas orörda", async () => {
    const omrade = await skapaOmrade("TEST_KontrollSaknade");
    const annatOmrade = await skapaOmrade("TEST_KontrollUtanför");
    const fack = await skapaFack(omrade.id, "A1");
    const annatFack = await skapaFack(annatOmrade.id, "B1");
    const vald = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-KONT-VALD", antal: 2, m3: 0.4 });
    const kvar = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-KONT-KVAR", antal: 3, m3: 0.6 });
    const utanför = await skapaPost({ omradeId: annatOmrade.id, fackId: annatFack.id, pktNr: "P-KONT-UTANFOR", antal: 4, m3: 0.8 });

    const omgangId = await skapaOmgang("Kontroll saknade", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    const efterSnapshot = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-KONT-EFTER", antal: 5, m3: 1 });

    const lista = await api<{ paket: { pktNr: string }[] }>("GET", `/inventeringsomgangar/${omgangId}/saknade`);
    expect(lista.status).toBe(200);
    expect(lista.data.paket.map((p) => p.pktNr)).toEqual(expect.arrayContaining(["P-KONT-VALD", "P-KONT-KVAR"]));
    expect(lista.data.paket.map((p) => p.pktNr)).not.toContain("P-KONT-EFTER");
    expect(lista.data.paket.map((p) => p.pktNr)).not.toContain("P-KONT-UTANFOR");

    // Avslut gör ingen automatisk avrapportering.
    await avslutaSession(sessionId);
    await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    const foreAvrapport = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, [vald.id, kvar.id]));
    expect(foreAvrapport.every((r) => r.datumUt === null)).toBe(true);

    const avrapp = await api<{ avrapporterade: { pktNr: string }[]; konflikter: { pktNr: string }[] }>(
      "POST",
      `/inventeringsomgangar/${omgangId}/saknade/avrapportera`,
      { body: { pktNrLista: ["P-KONT-VALD", "P-KONT-EFTER", "P-KONT-UTANFOR"] } },
    );
    expect(avrapp.status).toBe(200);
    expect(avrapp.data.avrapporterade).toEqual([{ pktNr: "P-KONT-VALD", antalRader: 1 }]);
    expect(avrapp.data.konflikter.map((c) => c.pktNr).sort()).toEqual(["P-KONT-EFTER", "P-KONT-UTANFOR"]);

    const efter = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, [vald.id, kvar.id, efterSnapshot.id, utanför.id]));
    expect(efter.find((r) => r.id === vald.id)?.datumUt).not.toBeNull();
    expect(efter.find((r) => r.id === kvar.id)?.datumUt).toBeNull();
    expect(efter.find((r) => r.id === efterSnapshot.id)?.datumUt).toBeNull();
    expect(efter.find((r) => r.id === utanför.id)?.datumUt).toBeNull();
  });
});

describe("Årsinventering — avrapportering använder exakt global startsnapshot", () => {
  test("avvisar ett nytt pktNr-rad-ID trots samma pktNr och lämnar båda raderna orörda", async () => {
    const omrade = await skapaOmrade("TEST_ArSnapshotMismatch");
    const fack = await skapaFack(omrade.id, "A1");
    const fore = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ARS-MISMATCH", antal: 2, m3: 0.4 });
    const omgangId = await skapaArsinventering("År snapshot mismatch", omrade.id);
    await startaSession(omrade.id, fack.id, omgangId);
    const efter = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-ARS-MISMATCH", antal: 3, m3: 0.6 });

    const avrapp = await api<{ avrapporterade: unknown[]; konflikter: { pktNr: string; anledning: string }[] }>(
      "POST",
      `/inventeringsomgangar/${omgangId}/saknade/avrapportera`,
      { body: { pktNrLista: ["P-ARS-MISMATCH"] } },
    );
    expect(avrapp.status).toBe(200);
    expect(avrapp.data.avrapporterade).toEqual([]);
    expect(avrapp.data.konflikter[0].pktNr).toBe("P-ARS-MISMATCH");

    const rows = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, [fore.id, efter.id]));
    expect(rows.every((r) => r.datumUt === null)).toBe(true);
  });
});

describe("Kontrollinventering — avrapportering använder exakt frysta lager-ID:n", () => {
  test("avvisar ny rad med samma pktNr efter sessionsnapshot", async () => {
    const omrade = await skapaOmrade("TEST_KontrollSnapshotMismatch");
    const fack = await skapaFack(omrade.id, "A1");
    const fore = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-KONT-MISMATCH", antal: 1, m3: 0.2 });
    const omgangId = await skapaOmgang("Kontroll snapshot mismatch", omrade.id);
    await startaSession(omrade.id, fack.id, omgangId);
    const efter = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-KONT-MISMATCH", antal: 2, m3: 0.4 });

    const avrapp = await api<{ avrapporterade: unknown[]; konflikter: { pktNr: string }[] }>(
      "POST",
      `/inventeringsomgangar/${omgangId}/saknade/avrapportera`,
      { body: { pktNrLista: ["P-KONT-MISMATCH"] } },
    );
    expect(avrapp.status).toBe(200);
    expect(avrapp.data.avrapporterade).toEqual([]);
    expect(avrapp.data.konflikter).toEqual([{ pktNr: "P-KONT-MISMATCH", anledning: expect.any(String) }]);
    const rows = await db.select().from(lagerPosterTable).where(inArray(lagerPosterTable.id, [fore.id, efter.id]));
    expect(rows.every((r) => r.datumUt === null)).toBe(true);
  });
});

describe("Inventeringsomgångar — global avstämning fryst identiskt med live-listan vid avslut", () => {
  test("saknat utan fack, hittat i annat fack, och tillkommet gods fryses konsekvent — och en avrapportering EFTER avslut ändrar aldrig den frysta rapporten", async () => {
    const omrade = await skapaOmrade("TEST_GlobalFrys");
    const fackA = await skapaFack(omrade.id, "A1");
    const fackB = await skapaFack(omrade.id, "B1");

    // (a) Utan registrerat fack, skannas aldrig -> saknat.
    const [utanFack] = await db
      .insert(lagerPosterTable)
      .values({ pktNr: "P-FRYS-NOFACK", traslag: "Furu", antal: 2, m3: "0.4", omradeId: null, fackId: null })
      .returning();
    posterIds.push(utanFack.id);
    // (b) Registrerad i fack A, men fysiskt hittad i fack B -> ALDRIG saknat.
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-FRYS-FLYTTAD", antal: 3, m3: 0.6 });
    // (c) Registrerad i fack A, aldrig skannad -> saknat, och avrapporteras EFTER avslut.
    const utlev = await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-FRYS-UTLEV", antal: 1, m3: 0.3 });

    const omgangId = await skapaArsinventering("GlobalFrys", omrade.id);

    // Gods som anländer och registreras EFTER att den globala snapshoten
    // togs (vid omgångens skapande ovan) -> kan aldrig vara "saknat" (det
    // fanns inte i startsnapshoten), och ska INTE räknas som "hittat" mot
    // den heller -> klassificeras separat som "tillkommit efter start".
    const tillkommen = await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-FRYS-TILLKOMMEN", antal: 4, m3: 0.7 });

    const sessionA = await startaSession(omrade.id, fackA.id, omgangId);
    const sessionB = await startaSession(omrade.id, fackB.id, omgangId);
    await skanna(sessionB, "P-FRYS-FLYTTAD");
    await skanna(sessionA, "P-FRYS-TILLKOMMEN");
    await avslutaSession(sessionA);
    await avslutaSession(sessionB);

    // Läs av den LIVE saknas-/tillkommit-listan precis innan avslut, sparad
    // för jämförelse mot den frysta sammanställningen nedan.
    const fore = await api<{ antalGlobalt: number; antalSkannat: number; antalSaknas: number; paket: { pktNr: string }[] }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/saknade`,
    );
    const foreTillkommit = await api<{ antal: number; styck: number; nomM3: number }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/tillkommit-efter-start`,
    );

    const avsluta = await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    expect(avsluta.status).toBe(200);

    type TotaltRad = {
      antalSaknade: number;
      styckSaknat: number;
      nomM3Saknat: number;
      antalGlobalSnapshot: number | null;
      antalTillkommitEfterStart: number | null;
      styckTillkommitEfterStart: number | null;
      nomM3TillkommitEfterStart: number | null;
    };
    const { data } = await api<{ sammanfattning: { totalt: TotaltRad } }>("GET", `/inventeringsomgangar/${omgangId}`);
    const totalt = data.sammanfattning.totalt;

    // (d) Den frysta totalraden är EXAKT vad den live-beräknade listan visade
    // precis innan avslut (samma delade avstämningsfunktion, samma tidsgräns).
    expect(totalt.antalGlobalSnapshot).toBe(fore.data.antalGlobalt);
    expect(totalt.antalSaknade).toBe(fore.data.antalSaknas);
    expect(totalt.antalTillkommitEfterStart).toBe(foreTillkommit.data.antal);
    expect(totalt.styckTillkommitEfterStart).toBe(foreTillkommit.data.styck);
    expect(Number(totalt.nomM3TillkommitEfterStart)).toBeCloseTo(foreTillkommit.data.nomM3);

    // Matematisk konsekvens: Hittade (globalt skannade) + Saknade == Globalt.
    expect(fore.data.antalSkannat + fore.data.antalSaknas).toBe(fore.data.antalGlobalt);

    // Innehållskontroll: (a) och (c) saknas, (b) och (d)-tillkomna gör det inte.
    const saknasEfter = await api<{ paket: { pktNr: string }[] }>("GET", `/inventeringsomgangar/${omgangId}/saknade`);
    const saknasPktNr = saknasEfter.data.paket.map((p) => p.pktNr);
    expect(saknasPktNr).toContain("P-FRYS-NOFACK");
    expect(saknasPktNr).toContain("P-FRYS-UTLEV");
    expect(saknasPktNr).not.toContain("P-FRYS-FLYTTAD");
    expect(saknasPktNr).not.toContain("P-FRYS-TILLKOMMEN");

    const tillkommitEfter = await api<{ paket: { pktNr: string; styck: number; nomM3: number }[] }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/tillkommit-efter-start`,
    );
    const tillkommenRad = tillkommitEfter.data.paket.find((p) => p.pktNr === "P-FRYS-TILLKOMMEN");
    expect(tillkommenRad?.styck).toBe(4);
    expect(tillkommenRad?.nomM3).toBeCloseTo(0.7);

    // (c) forts.: avrapportera P-FRYS-UTLEV EFTER att omgången redan stängts.
    const avrapp = await api<{ avrapporterade: { pktNr: string }[]; konflikter: unknown[] }>(
      "POST",
      `/inventeringsomgangar/${omgangId}/saknade/avrapportera`,
      { body: { pktNrLista: ["P-FRYS-UTLEV"] }, user: "carla" },
    );
    expect(avrapp.status).toBe(200);
    expect(avrapp.data.konflikter).toHaveLength(0);
    expect(avrapp.data.avrapporterade.map((a) => a.pktNr)).toEqual(["P-FRYS-UTLEV"]);

    const [utlevRad] = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, utlev.id));
    expect(utlevRad.datumUt).not.toBeNull(); // fysiskt utlevererat i lager_poster nu

    // Trots det: den frysta rapporten (skapad FÖRE avrapporteringen) är orörd...
    const { data: efterAvrapp } = await api<{ sammanfattning: { totalt: TotaltRad } }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    expect(efterAvrapp.sammanfattning.totalt.antalSaknade).toBe(totalt.antalSaknade);
    expect(efterAvrapp.sammanfattning.totalt.styckSaknat).toBe(totalt.styckSaknat);
    expect(Number(efterAvrapp.sammanfattning.totalt.nomM3Saknat)).toBeCloseTo(Number(totalt.nomM3Saknat));

    // ...och paketet visas FORTFARANDE historiskt som saknat vid inventerings-
    // tillfället (bunden till avslutadAt), nu bara med ett synligt beslut.
    const { data: saknadeEfterAvrapp } = await api<{ paket: { pktNr: string; beslut: { typ: string } | null }[] }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/saknade`,
    );
    const utlevPaket = saknadeEfterAvrapp.paket.find((p) => p.pktNr === "P-FRYS-UTLEV");
    expect(utlevPaket).toBeTruthy();
    expect(utlevPaket?.beslut?.typ).toBe("avrapporterad");
  });
});

describe("Inventeringsomgångar — jämförelse mellan omgångar", () => {
  test("GET /jamfor varnar när omgångarnas fackomfång skiljer sig", async () => {
    const omrade = await skapaOmrade("TEST_Jamfor");
    const fack1 = await skapaFack(omrade.id, "A1");
    const fack2 = await skapaFack(omrade.id, "A2");
    await skapaPost({ omradeId: omrade.id, fackId: fack1.id, pktNr: "P-JAMFOR-1", antal: 1, m3: 1 });

    // Omgång A: bara fack1 i omfånget.
    const { data: omgangA } = await api<{ id: number }>("POST", "/inventeringsomgangar", {
      body: { namn: "JamforA", typ: "kontrollinventering", fackIds: [fack1.id] },
    });
    omgangIds.push(omgangA.id);
    const sessionA = await startaSession(omrade.id, fack1.id, omgangA.id);
    await skanna(sessionA, "P-JAMFOR-1");
    await avslutaSession(sessionA);
    await api("POST", `/inventeringsomgangar/${omgangA.id}/avsluta`);

    // Omgång B: fack1 + fack2 i omfånget (annat omfång).
    const { data: omgangB } = await api<{ id: number }>("POST", "/inventeringsomgangar", {
      body: { namn: "JamforB", typ: "kontrollinventering", fackIds: [fack1.id, fack2.id] },
    });
    omgangIds.push(omgangB.id);
    const sessionB1 = await startaSession(omrade.id, fack1.id, omgangB.id);
    await skanna(sessionB1, "P-JAMFOR-1");
    await avslutaSession(sessionB1);
    const sessionB2 = await startaSession(omrade.id, fack2.id, omgangB.id);
    await avslutaSession(sessionB2);
    await api("POST", `/inventeringsomgangar/${omgangB.id}/avsluta`);

    const { data, status } = await api<{ sammaOmfang: boolean; varning: string | null }>(
      "GET",
      `/inventeringsomgangar/jamfor/${omgangA.id}/${omgangB.id}`,
    );
    expect(status).toBe(200);
    expect(data.sammaOmfang).toBe(false);
    expect(data.varning).toBeTruthy();
  });
});

describe("Inventeringsomgångar — enkel slutsammanställning", () => {
  test("visar frysta slutmått, beslutspåverkat saldo och historiskt korrigerade felplaceringar per pktNr", async () => {
    const omrade = await skapaOmrade("TEST_Slutsammanstallning");
    const fackA = await skapaFack(omrade.id, "SLUT-A");
    const fackB = await skapaFack(omrade.id, "SLUT-B");

    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-SLUT-HITTAD", antal: 5, m3: 0.5 });
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-SLUT-BEHALL", antal: 2, m3: 0.2 });
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-SLUT-AVRAPP", antal: 3, m3: 0.3 });
    const felplaceradA = await skapaPost({ omradeId: omrade.id, fackId: fackB.id, pktNr: "P-SLUT-FEL", antal: 4, m3: 0.4 });
    const felplaceradB = await skapaPost({ omradeId: omrade.id, fackId: fackB.id, pktNr: "P-SLUT-FEL", antal: 6, m3: 0.6 });

    const omgangId = await skapaArsinventering("Slutsammanställning", omrade.id);
    const tillkommen = await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-SLUT-TILLKOMMEN", antal: 7, m3: 0.7 });
    const sessionId = await startaSession(omrade.id, fackA.id, omgangId);

    await skanna(sessionId, "P-SLUT-HITTAD");
    await skanna(sessionId, "P-SLUT-TILLKOMMEN");
    const felScan = await skanna(sessionId, "P-SLUT-FEL");
    expect((felScan.data as { klassificering: string }).klassificering).toBe("felplacerad");

    const korrigering = await api<{ korrigerade: string[]; konflikter: unknown[] }>(
      "POST",
      `/inventering/${sessionId}/korrigera`,
      { body: { pktNrLista: ["P-SLUT-FEL"] }, user: "rattare" },
    );
    expect(korrigering.status).toBe(200);
    expect(korrigering.data.korrigerade).toEqual(["P-SLUT-FEL"]);
    expect(korrigering.data.konflikter).toHaveLength(0);

    const behall = await api("POST", `/inventeringsomgangar/${omgangId}/saknade/behall`, {
      body: { pktNrLista: ["P-SLUT-BEHALL"] },
    });
    expect(behall.status).toBe(200);
    const avrapportera = await api("POST", `/inventeringsomgangar/${omgangId}/saknade/avrapportera`, {
      body: { pktNrLista: ["P-SLUT-AVRAPP"] },
    });
    expect(avrapportera.status).toBe(200);

    expect((await avslutaSession(sessionId)).status).toBe(200);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`)).status).toBe(200);

    type SlutSvar = {
      slutsammanstallning: {
        start: { antalPaket: number; nomM3: number };
        hittat: { antalPaket: number; nomM3: number };
        saknas: { antalPaket: number; nomM3: number };
        tillkommitEfterStart: { antalPaket: number; nomM3: number };
        slutligtLagerEnligtBeslut: { antalPaket: number; nomM3: number };
      };
      felplacerade: {
        pktNr: string;
        styck: number;
        nomM3: number;
        forvantatFackKod: string | null;
        hittatFackKod: string | null;
        korrigerad: boolean;
        korrigeradAv: string | null;
      }[];
    };
    const foreFlytt = await api<SlutSvar>("GET", `/inventeringsomgangar/${omgangId}`);
    expect(foreFlytt.status).toBe(200);
    const slut = foreFlytt.data.slutsammanstallning;
    expect(slut.hittat.antalPaket + slut.saknas.antalPaket).toBe(slut.start.antalPaket);
    expect(slut.hittat.nomM3 + slut.saknas.nomM3).toBeCloseTo(slut.start.nomM3);
    expect(slut.tillkommitEfterStart.antalPaket).toBe(1);
    expect(slut.tillkommitEfterStart.nomM3).toBeCloseTo(0.7);
    expect(slut.slutligtLagerEnligtBeslut.antalPaket).toBe(slut.start.antalPaket);
    expect(slut.slutligtLagerEnligtBeslut.nomM3).toBeCloseTo(slut.start.nomM3 - 0.3 + 0.7);

    expect(foreFlytt.data.felplacerade).toHaveLength(1);
    const felplacerad = foreFlytt.data.felplacerade[0];
    expect(felplacerad.pktNr).toBe("P-SLUT-FEL");
    expect(felplacerad.styck).toBe(10);
    expect(felplacerad.nomM3).toBeCloseTo(1);
    expect(felplacerad.forvantatFackKod).toBe("SLUT-A");
    expect(felplacerad.hittatFackKod).toBe("SLUT-B");
    expect(felplacerad.korrigerad).toBe(true);
    expect(felplacerad.korrigeradAv).toBe("rattare");

    await applyLagerPatch(
      [felplaceradA.id, felplaceradB.id],
      { omradeId: omrade.id, fackId: fackB.id, plats: omrade.namn },
      { userId: "vanlig-flytt", action: "batch_update" },
    );

    const efterFlytt = await api<SlutSvar>("GET", `/inventeringsomgangar/${omgangId}`);
    const historisk = efterFlytt.data.felplacerade.find((p) => p.pktNr === "P-SLUT-FEL");
    expect(historisk?.korrigerad).toBe(true);
    expect(historisk?.korrigeradAv).toBe("rattare");
    expect(historisk?.hittatFackKod).toBe("SLUT-B");
    expect(efterFlytt.data.slutsammanstallning).toEqual(foreFlytt.data.slutsammanstallning);

    expect(tillkommen.id).toBeGreaterThan(0);
  });
});

describe("Inventeringsomgångar — serverstyrt och låst avslut", () => {
  test("öppna sessioner blockerar avslut och svaret identifierar session och fack", async () => {
    const omrade = await skapaOmrade("TEST_OppnaSessioner");
    const fack = await skapaFack(omrade.id, "LAS-A");
    const omgangId = await skapaOmgang("Öppna sessioner", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);

    const avslut = await api<{
      error: string;
      oppnaSessioner: { sessionId: number; fackId: number; fackKod: string | null; status: string }[];
    }>("POST", `/inventeringsomgangar/${omgangId}/avsluta`);
    expect(avslut.status).toBe(409);
    expect(avslut.data.oppnaSessioner).toEqual([
      { sessionId, fackId: fack.id, fackKod: "LAS-A", status: "pagaende" },
    ]);

    await avslutaSession(sessionId);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`)).status).toBe(200);
  });

  test("en fristående session får inte återlämnas som session för en omgång", async () => {
    const omrade = await skapaOmrade("TEST_FriståendeSession");
    const fack = await skapaFack(omrade.id, "LAS-FRI");
    const fristaendeSessionId = await startaSession(omrade.id, fack.id);
    const omgangId = await skapaOmgang("Fristående session", omrade.id);

    const start = await api("POST", "/inventering/start", {
      body: { omradeId: omrade.id, fackId: fack.id, omgangId },
    });
    expect(start.status).toBe(409);

    const [session] = await db
      .select()
      .from(lagerInventeringarTable)
      .where(eq(lagerInventeringarTable.id, fristaendeSessionId));
    expect(session.omgangId).toBeNull();
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`)).status).toBe(200);
  });

  test("alla historikpåverkande sessionsmutationer blockeras efter omgångsavslut", async () => {
    const omrade = await skapaOmrade("TEST_EfterAvslut");
    const fack = await skapaFack(omrade.id, "LAS-B");
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-LAST", antal: 4, m3: 0.4 });
    const omgangId = await skapaOmgang("Efter avslut", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    await skanna(sessionId, "P-LAST");
    await avslutaSession(sessionId);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`)).status).toBe(200);

    const fore = await api<{ sammanfattning: unknown; slutsammanstallning: unknown }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    const anrop = await Promise.all([
      skanna(sessionId, "P-NY"),
      api("DELETE", `/inventering/${sessionId}/skanna/P-LAST`),
      avslutaSession(sessionId),
      api("POST", `/inventering/${sessionId}/korrigera`, { body: { pktNrLista: ["P-LAST"] } }),
      api("POST", `/inventering/${sessionId}/prissatt`, {
        body: { pktNrLista: ["P-LAST"], prisPerNomM3: 1000 },
      }),
      api("DELETE", `/inventering/${sessionId}/prissatt`, { body: { pktNrLista: ["P-LAST"] } }),
      api("POST", "/inventering/start", { body: { omradeId: omrade.id, fackId: fack.id, omgangId } }),
    ]);
    expect(anrop.map((svar) => svar.status)).toEqual([409, 409, 409, 409, 409, 409, 409]);

    const efter = await api<{ sammanfattning: unknown; slutsammanstallning: unknown }>(
      "GET",
      `/inventeringsomgangar/${omgangId}`,
    );
    expect(efter.data.sammanfattning).toEqual(fore.data.sammanfattning);
    expect(efter.data.slutsammanstallning).toEqual(fore.data.slutsammanstallning);
  });

  test("samtidiga avslut ger exakt en vinnare och exakt en totalrad", async () => {
    const omrade = await skapaOmrade("TEST_DubbelAvslut");
    await skapaFack(omrade.id, "LAS-C");
    const omgangId = await skapaOmgang("Samtidigt avslut", omrade.id);

    const svar = await Promise.all([
      api("POST", `/inventeringsomgangar/${omgangId}/avsluta`, { user: "avslutare-a" }),
      api("POST", `/inventeringsomgangar/${omgangId}/avsluta`, { user: "avslutare-b" }),
    ]);
    expect(svar.map((r) => r.status).sort()).toEqual([200, 409]);

    const [antal] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(lagerInventeringsomgangSammanfattningTable)
      .where(
        sql`${lagerInventeringsomgangSammanfattningTable.omgangId} = ${omgangId}
            and ${lagerInventeringsomgangSammanfattningTable.omradeId} is null`,
      );
    expect(antal.value).toBe(1);
  });

  test("race mellan ny session och avslut kan aldrig lämna en öppen session i en avslutad omgång", async () => {
    const omrade = await skapaOmrade("TEST_StartAvslutRace");
    const fack = await skapaFack(omrade.id, "LAS-D");
    const omgangId = await skapaOmgang("Start kontra avslut", omrade.id);

    const [startSvar, avslutSvar] = await Promise.all([
      api<{ session?: { id: number } }>("POST", "/inventering/start", {
        body: { omradeId: omrade.id, fackId: fack.id, omgangId },
        user: "startare",
      }),
      api("POST", `/inventeringsomgangar/${omgangId}/avsluta`, { user: "avslutare" }),
    ]);
    expect(
      (startSvar.status === 201 && avslutSvar.status === 409) ||
        (startSvar.status === 409 && avslutSvar.status === 200),
    ).toBe(true);
    if (startSvar.status === 201 && startSvar.data.session) sessionIds.push(startSvar.data.session.id);

    const [omgang] = await db
      .select()
      .from(lagerInventeringsomgangarTable)
      .where(eq(lagerInventeringsomgangarTable.id, omgangId));
    const sessioner = await db
      .select()
      .from(lagerInventeringarTable)
      .where(eq(lagerInventeringarTable.omgangId, omgangId));
    expect(omgang.status === "avslutad" && sessioner.some((s) => s.status === "pagaende")).toBe(false);
  });
});

describe("Lagerredigering — strukturerad plats", () => {
  test("paketimport sparar samma område och fack på samtliga markerade paket", async () => {
    const omrade = await skapaOmrade("TEST_Importomrade");
    const fack = await skapaFack(omrade.id, "03");
    const prefix = `TEST_IMPORT_${Date.now()}`;
    const importeradeIds: number[] = [];

    for (let i = 1; i <= 7; i++) {
      const svar = await api<{ id: number }>("POST", "/lager/upsert", {
        body: {
          pktNr: `${prefix}_${i}`,
          traslag: "Furu",
          antal: 10 + i,
          mottaget: "Testleverantör",
          datumIn: "2026-09-09",
          omradeId: omrade.id,
          fackId: fack.id,
        },
      });
      expect(svar.status).toBe(201);
      importeradeIds.push(svar.data.id);
      posterIds.push(svar.data.id);
    }

    const importerade = await db
      .select()
      .from(lagerPosterTable)
      .where(inArray(lagerPosterTable.id, importeradeIds));
    expect(importerade).toHaveLength(7);
    expect(importerade.every((rad) =>
      rad.omradeId === omrade.id &&
      rad.fackId === fack.id &&
      rad.plats === omrade.namn &&
      rad.mottaget === "Testleverantör" &&
      rad.datumIn === "2026-09-09"
    )).toBe(true);

    const lista = await api<{
      data: Array<{
        omradeId: number | null;
        fackId: number | null;
        omradeNamn: string | null;
        fackKod: string | null;
      }>;
    }>("GET", `/lager?search=${encodeURIComponent(prefix)}&page=1&limit=100`);
    expect(lista.status).toBe(200);
    expect(lista.data.data).toHaveLength(7);
    expect(lista.data.data.every((rad) =>
      rad.omradeId === omrade.id &&
      rad.fackId === fack.id &&
      rad.omradeNamn === omrade.namn &&
      rad.fackKod === fack.kod
    )).toBe(true);

    const detalj = await api<{
      omradeId: number | null;
      fackId: number | null;
      omradeNamn: string | null;
      fackKod: string | null;
    }>("GET", `/lager/${importeradeIds[0]}`);
    expect(detalj.status).toBe(200);
    expect(detalj.data).toMatchObject({
      omradeId: omrade.id,
      fackId: fack.id,
      omradeNamn: omrade.namn,
      fackKod: fack.kod,
    });
  });

  test("område och fack uppdateras paketatomiskt medan övriga fält stannar på vald rad", async () => {
    const omradeA = await skapaOmrade("TEST_Redigeringsomrade_A");
    const omradeB = await skapaOmrade("TEST_Redigeringsomrade_B");
    const fackA = await skapaFack(omradeA.id, "A01");
    const fackB = await skapaFack(omradeB.id, "B01");
    const pktNr = `TEST_REDIGERA_${Date.now()}`;
    const rad1 = await skapaPost({ omradeId: omradeA.id, fackId: fackA.id, pktNr, antal: 10 });
    const rad2 = await skapaPost({ omradeId: omradeA.id, fackId: fackA.id, pktNr, antal: 20 });

    const flytt = await api<{
      id: number;
      omradeId: number | null;
      fackId: number | null;
      plats: string | null;
      omradeNamn: string | null;
      fackKod: string | null;
    }>("PUT", `/lager/${rad1.id}`, {
      body: {
        omradeId: omradeB.id,
        fackId: fackB.id,
        plats: "SKA_IGNORERAS",
        antal: 99,
      },
    });

    expect(flytt.status).toBe(200);
    expect(flytt.data).toMatchObject({
      id: rad1.id,
      omradeId: omradeB.id,
      fackId: fackB.id,
      plats: omradeB.namn,
      omradeNamn: omradeB.namn,
      fackKod: fackB.kod,
    });

    const efterFlytt = await db
      .select()
      .from(lagerPosterTable)
      .where(inArray(lagerPosterTable.id, [rad1.id, rad2.id]))
      .orderBy(lagerPosterTable.id);
    expect(efterFlytt).toHaveLength(2);
    expect(efterFlytt.every((rad) =>
      rad.omradeId === omradeB.id &&
      rad.fackId === fackB.id &&
      rad.plats === omradeB.namn
    )).toBe(true);
    expect(efterFlytt.find((rad) => rad.id === rad1.id)?.antal).toBe(99);
    expect(efterFlytt.find((rad) => rad.id === rad2.id)?.antal).toBe(20);

    const felKombination = await api<{ error: string }>("PUT", `/lager/${rad1.id}`, {
      body: { omradeId: omradeA.id, fackId: fackB.id },
    });
    expect(felKombination.status).toBe(400);
    expect(felKombination.data.error).toBe("Valt fack tillhör inte valt område");

    const utanFack = await api("PUT", `/lager/${rad1.id}`, {
      body: { omradeId: omradeA.id, fackId: null },
    });
    expect(utanFack.status).toBe(200);

    const efterRensning = await db
      .select()
      .from(lagerPosterTable)
      .where(inArray(lagerPosterTable.id, [rad1.id, rad2.id]));
    expect(efterRensning.every((rad) =>
      rad.omradeId === omradeA.id &&
      rad.fackId === null &&
      rad.plats === omradeA.namn
    )).toBe(true);

    const fackUtanOmrade = await api<{ error: string }>("PUT", `/lager/${rad1.id}`, {
      body: { fackId: fackA.id },
    });
    expect(fackUtanOmrade.status).toBe(400);
    expect(fackUtanOmrade.data.error).toBe("fackId kräver omradeId");
  });
});

describe("Inventeringsomgång — read-only rapport", () => {
  test("använder frysta längdrader, räknar lpm en gång och skiljer oväntad kontrollskanning", async () => {
    const omrade = await skapaOmrade("TEST_Rapport");
    const fack = await skapaFack(omrade.id, "A1");
    const annatFack = await skapaFack(omrade.id, "B1");
    const radA = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-RAPPORT-MULTI", antal: 10, m3: 1 });
    const radB = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-RAPPORT-MULTI", antal: 3, m3: 0.5 });
    const missing = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-RAPPORT-SAKNAS", antal: 2, m3: 0.2 });
    await db
      .update(lagerPosterTable)
      .set({
        langdDm: "40",
        profil: "Regel",
        kvalitet: "C24",
        nomTjocklek: "50",
        nomBredd: "100",
        actTjocklek: "45",
        actBredd: "95",
      })
      .where(inArray(lagerPosterTable.id, [radA.id, radB.id]));
    await db.update(lagerPosterTable).set({
      langdDm: "30",
      profil: "Regel",
      kvalitet: "C24",
      nomTjocklek: "50",
      nomBredd: "100",
    }).where(eq(lagerPosterTable.id, missing.id));

    const omgangId = await skapaOmgang("Rapport", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    const unexpected = await skapaPost({ omradeId: omrade.id, fackId: annatFack.id, pktNr: "P-RAPPORT-OVANTAT", antal: 1, m3: 0.1 });
    await db.update(lagerPosterTable).set({
      langdDm: "20",
      profil: "Regel",
      kvalitet: "C24",
      nomTjocklek: "50",
      nomBredd: "100",
    }).where(eq(lagerPosterTable.id, unexpected.id));
    await skanna(sessionId, "P-RAPPORT-MULTI");
    await skanna(sessionId, "P-RAPPORT-OVANTAT");
    await avslutaSession(sessionId);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`)).status).toBe(200);

    const report = await api<{
      dataQuality: {
        fullstandigtFryst: boolean;
        historiskaLuckor: string[];
        historiskaReferenser: { platsnamnHistorisktFrysta: boolean; ickeBlockerandeNoteringar: string[] };
      };
      totals: { unikaPaket: number; styck: number; lpm: number; actM3SaknadeRader: number };
      slutlager: { pktNr: string; status: string; frystaLangdrader: unknown[] }[];
      avvikelser: { pktNr: string; status: string }[];
    }>("GET", `/inventeringsomgangar/${omgangId}/rapport`);
    expect(report.status).toBe(200);
    expect(report.data.dataQuality.fullstandigtFryst).toBe(true);
    expect(report.data.dataQuality.historiskaReferenser.platsnamnHistorisktFrysta).toBe(false);
    expect(report.data.dataQuality.historiskaReferenser.ickeBlockerandeNoteringar.length).toBeGreaterThan(0);
    expect(report.data.totals.unikaPaket).toBe(3);
    expect(report.data.totals.styck).toBe(16);
    expect(report.data.totals.lpm).toBeCloseTo(60);
    expect(report.data.totals.actM3SaknadeRader).toBe(2);
    expect(report.data.slutlager.find((p) => p.pktNr === "P-RAPPORT-MULTI")?.frystaLangdrader).toHaveLength(2);
    expect(report.data.avvikelser.find((p) => p.pktNr === "P-RAPPORT-OVANTAT")?.status).toBe("Skannat – ej i förväntat lager");
  });

  test("flaggar saknad fryst produktidentitet utan live-fallback", async () => {
    const omrade = await skapaOmrade("TEST_RapportKvalitet");
    const fack = await skapaFack(omrade.id, "A1");
    const post = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-RAPPORT-LUCKA", antal: 1, m3: 0.1 });
    await db.update(lagerPosterTable).set({
      profil: "Regel",
      kvalitet: "C24",
      nomTjocklek: "50",
      nomBredd: "100",
      langdDm: "40",
    }).where(eq(lagerPosterTable.id, post.id));
    const omgangId = await skapaArsinventering("Rapport datakvalitet", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    await avslutaSession(sessionId);
    await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);

    await db
      .update(lagerInventeringsomgangGlobalSnapshotTable)
      .set({ profilVidStart: null })
      .where(eq(lagerInventeringsomgangGlobalSnapshotTable.omgangId, omgangId));
    const report = await api<{ dataQuality: { fullstandigtFryst: boolean; historiskaLuckor: string[] } }>(
      "GET",
      `/inventeringsomgangar/${omgangId}/rapport`,
    );
    expect(report.data.dataQuality.fullstandigtFryst).toBe(false);
    expect(report.data.dataQuality.historiskaLuckor.some((lucka) => lucka.includes("profil"))).toBe(true);
  });

  test("kontrollens nullade frysta placering stannar i rapporten som historisk lucka", async () => {
    const omrade = await skapaOmrade("TEST_RapportNullPlacering");
    const fack = await skapaFack(omrade.id, "A1");
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-RAPPORT-NULL-PLACERING", antal: 1, m3: 0.1 });
    const omgangId = await skapaOmgang("Rapport nullplacering", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    await db
      .update(lagerInventeringForvantadeTable)
      .set({ omradeIdVidStart: null, fackIdVidStart: null })
      .where(eq(lagerInventeringForvantadeTable.inventeringId, sessionId));
    await avslutaSession(sessionId);
    await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`);

    const report = await api<{
      dataQuality: { fullstandigtFryst: boolean; historiskaLuckor: string[] };
      paket: { pktNr: string }[];
    }>("GET", `/inventeringsomgangar/${omgangId}/rapport`);
    expect(report.data.paket.map((p) => p.pktNr)).toContain("P-RAPPORT-NULL-PLACERING");
    expect(report.data.dataQuality.fullstandigtFryst).toBe(false);
    expect(report.data.dataQuality.historiskaLuckor.some((lucka) => lucka.includes("historiskPlacering"))).toBe(true);
  });
});

describe("Inventeringsomgång — rapportens slutlagerregel", () => {
  test("årsinventering använder start minus avrapporterat plus skannat utanför start", async () => {
    const omrade = await skapaOmrade("TEST_RapportArs");
    const fackA = await skapaFack(omrade.id, "A1");
    const fackB = await skapaFack(omrade.id, "B1");
    const found = await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-R-FOUND", antal: 2, m3: 0.2 });
    const misplaced = await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-R-MISPLACED", antal: 3, m3: 0.3 });
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-R-BEHALL", antal: 4, m3: 0.4 });
    await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-R-UNDECIDED", antal: 5, m3: 0.5 });
    const avrapporterad = await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-R-AVRAPP", antal: 6, m3: 0.6 });
    const conflict = await skapaPost({ omradeId: omrade.id, fackId: fackA.id, pktNr: "P-R-CONFLICT", antal: 7, m3: 0.7 });

    const omgangId = await skapaArsinventering("Rapport årsregel", omrade.id);
    const sessionA = await startaSession(omrade.id, fackA.id, omgangId);
    const sessionB = await startaSession(omrade.id, fackB.id, omgangId);

    await skanna(sessionA, "P-R-FOUND");
    await db.update(lagerPosterTable).set({ fackId: fackB.id }).where(eq(lagerPosterTable.id, misplaced.id));
    await skanna(sessionB, "P-R-MISPLACED");
    await skanna(sessionA, "P-R-CONFLICT");
    await db.update(lagerPosterTable).set({ fackId: fackB.id }).where(eq(lagerPosterTable.id, conflict.id));
    await skanna(sessionB, "P-R-CONFLICT");

    // Created after the global start snapshot: it is included in the final
    // stock, but must retain the annual "not in startsnapshot" status.
    const [afterStart] = await db
      .insert(lagerPosterTable)
      .values({ pktNr: "P-R-AFTER-START", traslag: "Furu", antal: 8, m3: "0.8", omradeId: omrade.id, fackId: fackB.id })
      .returning();
    posterIds.push(afterStart.id);
    await skanna(sessionB, "P-R-AFTER-START");

    const behall = await api("POST", `/inventeringsomgangar/${omgangId}/saknade/behall`, {
      body: { pktNrLista: ["P-R-BEHALL"] },
    });
    expect(behall.status).toBe(200);
    await api("POST", `/inventeringsomgangar/${omgangId}/dubbelskanningar/P-R-CONFLICT/los`, {
      body: { valdSessionId: sessionB },
    });
    await avslutaSession(sessionA);
    await avslutaSession(sessionB);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`)).status).toBe(200);

    const avrapportera = await api("POST", `/inventeringsomgangar/${omgangId}/saknade/avrapportera`, {
      body: { pktNrLista: [avrapporterad.pktNr] },
    });
    expect(avrapportera.status).toBe(200);

    type Rapport = {
      totals: { unikaPaket: number; saknadePaketUtanBeslut: number; varning: string | null };
      slutlager: { pktNr: string; status: string; placering: { fackId: number | null }; summering: { styck: number } }[];
      paket: { pktNr: string; status: string; iSlutlager: boolean; placering: { fackId: number | null }; summering: { styck: number } }[];
    };
    const fore = await api<Rapport>("GET", `/inventeringsomgangar/${omgangId}/rapport`);
    expect(fore.status).toBe(200);
    expect(fore.data.totals.saknadePaketUtanBeslut).toBeGreaterThanOrEqual(1);
    expect(fore.data.totals.varning).toContain("saknade paket saknar beslut");
    const scenarioPktNr = new Set([
      "P-R-FOUND",
      "P-R-MISPLACED",
      "P-R-BEHALL",
      "P-R-UNDECIDED",
      "P-R-CONFLICT",
      "P-R-AFTER-START",
    ]);
    expect(fore.data.slutlager.filter((p) => scenarioPktNr.has(p.pktNr))).toHaveLength(6);
    expect(fore.data.paket.find((p) => p.pktNr === "P-R-AVRAPP")).toMatchObject({
      status: "Avrapporterat",
      iSlutlager: false,
    });
    expect(fore.data.paket.find((p) => p.pktNr === "P-R-BEHALL")?.status).toBe("Saknas – Behåll i lager");
    expect(fore.data.paket.find((p) => p.pktNr === "P-R-UNDECIDED")?.status).toBe("Saknas – inget beslut");
    expect(fore.data.paket.find((p) => p.pktNr === "P-R-AFTER-START")?.status).toBe("Skannat – ej i startsnapshot");
    expect(fore.data.paket.find((p) => p.pktNr === "P-R-CONFLICT")?.placering.fackId).toBe(fackB.id);

    // A post-close change in live lager_poster must not alter frozen report
    // quantities or placement.
    await db.update(lagerPosterTable).set({ antal: 999, m3: "99", fackId: fackB.id }).where(eq(lagerPosterTable.id, found.id));
    const efter = await api<Rapport>("GET", `/inventeringsomgangar/${omgangId}/rapport`);
    expect(efter.data.paket.find((p) => p.pktNr === "P-R-FOUND")?.summering).toEqual(
      fore.data.paket.find((p) => p.pktNr === "P-R-FOUND")?.summering,
    );
  });

  test("kontrollrapporten använder endast fryst sessionsscope och beslut", async () => {
    const omrade = await skapaOmrade("TEST_RapportKontroll");
    const utanförOmrade = await skapaOmrade("TEST_RapportKontrollUtanför");
    const fack = await skapaFack(omrade.id, "A1");
    const utanförFack = await skapaFack(utanförOmrade.id, "U1");
    await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-K-R-BEHALL", antal: 2, m3: 0.2 });
    const avrapporterad = await skapaPost({ omradeId: omrade.id, fackId: fack.id, pktNr: "P-K-R-AVRAPP", antal: 3, m3: 0.3 });
    await skapaPost({ omradeId: utanförOmrade.id, fackId: utanförFack.id, pktNr: "P-K-R-UTANFOR", antal: 4, m3: 0.4 });

    const omgangId = await skapaOmgang("Kontroll rapport", omrade.id);
    const sessionId = await startaSession(omrade.id, fack.id, omgangId);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/saknade/behall`, {
      body: { pktNrLista: ["P-K-R-BEHALL"] },
    })).status).toBe(200);
    await avslutaSession(sessionId);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/avsluta`)).status).toBe(200);
    expect((await api("POST", `/inventeringsomgangar/${omgangId}/saknade/avrapportera`, {
      body: { pktNrLista: [avrapporterad.pktNr] },
    })).status).toBe(200);

    const report = await api<{
      totals: { unikaPaket: number };
      paket: { pktNr: string; status: string; iSlutlager: boolean }[];
      slutlager: { pktNr: string }[];
    }>("GET", `/inventeringsomgangar/${omgangId}/rapport`);
    expect(report.status).toBe(200);
    expect(report.data.totals.unikaPaket).toBe(1);
    expect(report.data.paket.find((p) => p.pktNr === "P-K-R-BEHALL")).toMatchObject({
      status: "Saknas – Behåll i lager",
      iSlutlager: true,
    });
    expect(report.data.paket.find((p) => p.pktNr === "P-K-R-AVRAPP")).toMatchObject({
      status: "Avrapporterat",
      iSlutlager: false,
    });
    expect(report.data.paket.map((p) => p.pktNr)).not.toContain("P-K-R-UTANFOR");
    expect(report.data.slutlager.map((p) => p.pktNr)).toEqual(["P-K-R-BEHALL"]);
  });
});
