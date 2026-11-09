// Regressionstest: avrapporterade paket som hittas vid inventering.
//
// Scenario (hyvelorder): ordern skrevs med paket A, men paket B plockades
// (A stod längst in) utan att ordern ändrades. Vid inventeringen står A kvar
// (avrapporterat) medan B saknas. Inventeringen ska då (1) tala om att A sitter
// på ordern, (2) föreslå B och (3) rätta order + lager i ett steg.
//
// Körs mot den riktiga (dev-)databasen precis som övriga inventeringstester;
// all testdata prefixas "TEST_" och städas i afterAll.
import "../../app";

import express from "express";
import type { Server } from "node:http";
import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { clerkClient } from "@clerk/express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  lagerOmradenTable,
  lagerFackTable,
  lagerPosterTable,
  lagerInventeringarTable,
  lagerInventeringsomgangarTable,
  specifikationerTable,
  specPaketTable,
} from "@workspace/db";
import inventeringRouter from "../inventering";
import inventeringsomgangarRouter from "../inventeringsomgangar";

vi.mock("@clerk/express", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...actual,
    getAuth: (req: express.Request & { auth?: () => unknown }) => req.auth?.(),
  };
});

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
  return app;
}

let server: Server;
let baseUrl: string;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const omradeIds: number[] = [];
const fackIds: number[] = [];
const posterIds: number[] = [];
const sessionIds: number[] = [];
const omgangIds: number[] = [];
const specIds: number[] = [];

async function skapaOmradeOchFack(namn: string) {
  const [o] = await db.insert(lagerOmradenTable).values({ namn, slug: namn.toLowerCase().replace(/[^a-z0-9]+/g, "-") }).returning();
  omradeIds.push(o.id);
  const [f] = await db.insert(lagerFackTable).values({ omradeId: o.id, kod: "A1" }).returning();
  fackIds.push(f.id);
  return { omrade: o, fack: f };
}

async function skapaPost(omradeId: number, fackId: number, pktNr: string, extra: Partial<typeof lagerPosterTable.$inferInsert> = {}) {
  const [p] = await db
    .insert(lagerPosterTable)
    .values({
      pktNr,
      omradeId,
      fackId,
      traslag: "Furu",
      nomTjocklek: "50",
      nomBredd: "100",
      langdDm: "48",
      antal: 10,
      m3: "2.4",
      ...extra,
    })
    .returning();
  posterIds.push(p.id);
  return p;
}

async function skapaBekraftadHyvelorder(lagerPostIds: number[], hyvlingNr: number) {
  const [spec] = await db
    .insert(specifikationerTable)
    .values({ typ: "hyvling", hyvlingNr, kund: "TEST_Kund", status: "bekraftad", bekraftadAt: new Date() })
    .returning();
  specIds.push(spec.id);
  await db.insert(specPaketTable).values(lagerPostIds.map((lagerPostId) => ({ specId: spec.id, lagerPostId, saljPris: "1000", saljSum: "2400" })));
  return spec;
}

async function startaSession(omradeId: number, fackId: number, omgangId?: number) {
  const { data } = await api<{ session: { id: number } }>("POST", "/inventering/start", {
    omradeId,
    fackId,
    ...(omgangId ? { omgangId } : {}),
  });
  sessionIds.push(data.session.id);
  return data.session.id;
}

beforeAll(async () => {
  vi.spyOn(clerkClient.users, "getUser").mockImplementation(async (userId) => ({
    id: userId,
    publicMetadata: { role: "admin" },
  }) as never);
  await new Promise<void>((resolve, reject) => {
    server = buildTestApp().listen(0, (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Kunde inte starta testservern");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (omgangIds.length) await db.delete(lagerInventeringsomgangarTable).where(inArray(lagerInventeringsomgangarTable.id, omgangIds));
  if (sessionIds.length) await db.delete(lagerInventeringarTable).where(inArray(lagerInventeringarTable.id, sessionIds));
  if (specIds.length) await db.delete(specifikationerTable).where(inArray(specifikationerTable.id, specIds));
  if (posterIds.length) await db.delete(lagerPosterTable).where(inArray(lagerPosterTable.id, posterIds));
  if (fackIds.length) await db.delete(lagerFackTable).where(inArray(lagerFackTable.id, fackIds));
  if (omradeIds.length) await db.delete(lagerOmradenTable).where(inArray(lagerOmradenTable.id, omradeIds));
  await pool.end();
});

const idag = new Date().toISOString().slice(0, 10);

describe("Avrapporterat paket hittat vid inventering", () => {
  test("hyvelorder-ombyte: A hittas kvar, B ersätter A på ordern, lager och order rättas", async () => {
    const { omrade, fack } = await skapaOmradeOchFack("TEST_Ombyte");
    const a = await skapaPost(omrade.id, fack.id, "TEST-A");
    const b = await skapaPost(omrade.id, fack.id, "TEST-B");
    const c = await skapaPost(omrade.id, fack.id, "TEST-C", { nomTjocklek: "22", nomBredd: "145" });
    const spec = await skapaBekraftadHyvelorder([a.id], 9001);
    await db.update(lagerPosterTable).set({ datumUt: idag, avrappTyp: "hyvlat_till_lager" }).where(eq(lagerPosterTable.id, a.id));

    const sessionId = await startaSession(omrade.id, fack.id);

    // 1. Skanning av A talar om att det är avrapporterat och sitter på ordern — ingen skanning sparas.
    const skan = await api("POST", `/inventering/${sessionId}/skanna`, { pktNr: "TEST-A" });
    expect(skan.status).toBe(200);
    expect(skan.data.avrapporterad).toBe(true);
    expect(skan.data.avrapportering.spec.etikett).toBe("Hyvelorder 9001");
    expect(skan.data.avrapportering.kanByta).toBe(true);
    const efterSkan = await api("GET", `/inventering/${sessionId}`);
    expect(efterSkan.data.skanningar).toHaveLength(0);

    // 2. B föreslås (samma mått, saknas i facket) före C (annat mått utesluts).
    const kand = await api("GET", `/inventering/${sessionId}/byte-kandidater?pktNr=TEST-A`);
    expect(kand.status).toBe(200);
    const pktNrIKandidater = kand.data.data.map((k: { pktNr: string }) => k.pktNr);
    expect(pktNrIKandidater[0]).toBe("TEST-B");
    expect(pktNrIKandidater).not.toContain("TEST-C");
    expect(pktNrIKandidater).not.toContain("TEST-A");
    expect(kand.data.data[0].saknasIFacket).toBe(true);

    // 3. Byt: A tillbaka i lager + hittat, B ut på ordern.
    const byt = await api("POST", `/inventering/${sessionId}/byt-paket`, { pktNr: "TEST-A", ersattAvPktNr: "TEST-B" });
    expect(byt.status).toBe(201);
    expect(byt.data.order).toBe("Hyvelorder 9001");
    expect(byt.data.klassificering).toBe("forvantad_hittad");
    expect(byt.data.session.skanningar.map((s: { pktNr: string }) => s.pktNr)).toEqual(["TEST-A"]);

    const [aEfter] = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, a.id));
    const [bEfter] = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, b.id));
    expect(aEfter.datumUt).toBeNull();
    expect(aEfter.avrappTyp).toBeNull();
    expect(bEfter.datumUt).toBe(idag);
    expect(bEfter.avrappTyp).toBe("hyvlat_till_lager");

    const orderRader = await db.select().from(specPaketTable).where(eq(specPaketTable.specId, spec.id));
    expect(orderRader.map((r) => r.lagerPostId)).toEqual([b.id]);
    expect(Number(orderRader[0].saljPris)).toBe(1000);
    expect(Number(orderRader[0].saljSum)).toBeCloseTo(2400);

    // 4. Ombytet kan inte göras två gånger.
    const igen = await api("POST", `/inventering/${sessionId}/byt-paket`, { pktNr: "TEST-A", ersattAvPktNr: "TEST-B" });
    expect(igen.status).toBe(409);
    void c;
  });

  test("B får inte vara ett paket som redan skannats (då står det ju kvar)", async () => {
    const { omrade, fack } = await skapaOmradeOchFack("TEST_OmbyteSkannat");
    const a = await skapaPost(omrade.id, fack.id, "TEST-A2");
    await skapaPost(omrade.id, fack.id, "TEST-B2");
    await skapaBekraftadHyvelorder([a.id], 9002);
    await db.update(lagerPosterTable).set({ datumUt: idag, avrappTyp: "hyvlat_till_lager" }).where(eq(lagerPosterTable.id, a.id));

    const sessionId = await startaSession(omrade.id, fack.id);
    await api("POST", `/inventering/${sessionId}/skanna`, { pktNr: "TEST-B2" });
    const byt = await api("POST", `/inventering/${sessionId}/byt-paket`, { pktNr: "TEST-A2", ersattAvPktNr: "TEST-B2" });
    expect(byt.status).toBe(409);
    const [aEfter] = await db.select().from(lagerPosterTable).where(eq(lagerPosterTable.id, a.id));
    expect(aEfter.datumUt).toBe(idag); // inget ändrades
  });

  test("avrapporterat utan order kan återinföras, men inte bytas", async () => {
    const { omrade, fack } = await skapaOmradeOchFack("TEST_Aterinfor");
    const a = await skapaPost(omrade.id, fack.id, "TEST-A3", { datumUt: idag });
    await skapaPost(omrade.id, fack.id, "TEST-B3");

    const sessionId = await startaSession(omrade.id, fack.id);
    const skan = await api("POST", `/inventering/${sessionId}/skanna`, { pktNr: "TEST-A3" });
    expect(skan.data.avrapporterad).toBe(true);
    expect(skan.data.avrapportering.spec).toBeNull();
    expect(skan.data.avrapportering.kanAterinforas).toBe(true);

    const byt = await api("POST", `/inventering/${sessionId}/byt-paket`, { pktNr: "TEST-A3", ersattAvPktNr: "TEST-B3" });
    expect(byt.status).toBe(409);

    const ater = await api("POST", `/inventering/${sessionId}/aterinfor-avrapporterat`, { pktNr: "TEST-A3" });
    expect(ater.status).toBe(201);
    expect(ater.data.klassificering).toBe("forvantad_hittad");
    const [aEfter] = await db.select().from(lagerPosterTable).where(and(eq(lagerPosterTable.id, a.id)));
    expect(aEfter.datumUt).toBeNull();
  });

  test("vanliga paket och okända paket klassas som förut", async () => {
    const { omrade, fack } = await skapaOmradeOchFack("TEST_Oforandrat");
    await skapaPost(omrade.id, fack.id, "TEST-OK");
    const sessionId = await startaSession(omrade.id, fack.id);
    const ok = await api("POST", `/inventering/${sessionId}/skanna`, { pktNr: "TEST-OK" });
    expect(ok.status).toBe(201);
    expect(ok.data.klassificering).toBe("forvantad_hittad");
    const okand = await api("POST", `/inventering/${sessionId}/skanna`, { pktNr: "TEST-FINNS-INTE" });
    expect(okand.data.klassificering).toBe("okand");
  });
});
